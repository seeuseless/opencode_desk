#!/usr/bin/env node
// UIA 桌面 MCP：把 Windows 无障碍树（UI Automation）暴露给 AI 操控桌面。
//
// 为什么需要它：截图 + 视觉模型那条路要求「对话模型能看图」，慢（每步 0.7~2.5s）、贵（一张图约 1500 token），
// 而且识图偶发返回空时模型会反复截屏空转。原生控件应用其实有一条纯文本的路——无障碍树：
// 「保存」「地址栏」「文件传输助手」这些元素**本来就有名字**，模型按名字/ref 点击即可，几十毫秒、不吃图片。
// 这正是内置浏览器 panel-mcp 的思路，这里把它平移到桌面。
//
// 底层是一个常驻的 PowerShell 宿主（uia-host.ps1）——只吐 JSON 数据，不含任何中文文案；
// 所有面向模型的说明都写在本文件里。宿主常驻是关键：UI Automation 首次初始化要几百毫秒，
// 每次调用重新起一个 powershell.exe 的话每步都要白等一遍。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = join(HERE, 'uia-host.ps1')
const POWERSHELL = process.env.QN_UIA_POWERSHELL || 'powershell.exe'
const CALL_TIMEOUT_MS = Number(process.env.QN_UIA_TIMEOUT_MS || 20000)

let child = null
let bootError = null
let seq = 0
const pending = new Map()
const stderrTail = []

function startHost() {
  if (child) return
  try {
    child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
  } catch (e) {
    bootError = e?.message ?? String(e)
    child = null
    return
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  createInterface({ input: child.stdout }).on('line', (line) => {
    const t = line.replace(/^\uFEFF/, '').trim()
    if (!t) return
    let msg
    try {
      msg = JSON.parse(t)
    } catch {
      return
    }
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p.resolve(msg)
    }
  })
  createInterface({ input: child.stderr }).on('line', (line) => {
    if (!line.trim()) return
    stderrTail.push(line.trim())
    if (stderrTail.length > 12) stderrTail.shift()
  })
  child.on('error', (e) => {
    bootError = e?.message ?? String(e)
  })
  child.on('exit', (code) => {
    child = null
    bootError = bootError || `UIA 宿主已退出（code=${code}）`
    for (const [, p] of pending) p.reject(new Error(bootError))
    pending.clear()
  })
}

function call(method, params, timeout = CALL_TIMEOUT_MS) {
  startHost()
  if (!child) return Promise.reject(new Error(bootError || 'UIA 宿主启动失败'))
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout'))
    }, timeout)
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(timer)
        resolve(m)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    try {
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    } catch (e) {
      clearTimeout(timer)
      pending.delete(id)
      reject(e)
    }
  })
}

// ---------------------------------------------------------------- 呈现层
const UIA_NOTE =
  '**本工具读的是 Windows 无障碍树，只有原生控件应用才有元素**（资源管理器、记事本、系统设置、Office、' +
  '浏览器、多数传统桌面软件）。像微信这类**自绘界面**（界面是一块画布，如微信 4.0 的 MMUIRenderSubWindow）' +
  '无障碍树是空的（实测只读得到标题栏的最小化/最大化/关闭三个按钮），UIA 对它无效——' +
  '不要反复重试 uia_tree，改走 `uia_keys` / `uia_paste` 的键盘流程。'

function rectText(r) {
  if (!r || r.x === null || r.w === null || r.w <= 0) return ''
  return ` (${r.x},${r.y} ${r.w}x${r.h})`
}

function formatWindows(r) {
  const list = Array.isArray(r.windows) ? r.windows : []
  if (!list.length) return '没有读到任何顶层窗口。'
  const lines = list.map((w, i) => {
    const fg = w.fg ? ' ←当前前台' : ''
    const t = w.name ? `「${w.name}」` : '(无标题)'
    return `${i + 1}. ${t} 进程 ${w.proc || '?'} (hwnd ${w.hwnd})${fg}`
  })
  return ['当前顶层窗口：', ...lines].join('\n')
}

function formatTree(r) {
  const win = r.window ?? {}
  const els = Array.isArray(r.elements) ? r.elements : []
  const head = `窗口「${win.name || '(无标题)'}」（进程 pid=${win.pid}，hwnd=${win.hwnd}）`
  if (!els.length) {
    return (
      head +
      '\n\n**该窗口无障碍树里没有任何可操作元素。** 这通常意味着它是**自绘界面**（把整个 UI 画在一块画布上），' +
      'UIA 对它无效——**不要再对同一个窗口重试 uia_tree / uia_windows，也不要试图点它的坐标**（画布给出的坐标不可靠）。\n' +
      '请改走**键盘流程**（全程不需要看画面，也不要截图）：\n' +
      '1. 按键一律用 `uia_keys`，并**带上目标窗口**：`uia_keys {"keys":"ctrl+f","match":"微信"}`。' +
      '带 match 会先把目标窗口切到前台并确认，切不过去就直接拒绝——绝不会把键打进青鸟自己或别的窗口。\n' +
      '2. **中文输入 / 发文件 / 发图片一律走剪贴板 + 粘贴**：先 `computer-use_set_clipboard`（mode=text / file / image），' +
      '再 `uia_paste {"match":"微信"}`（默认粘完即回车；想先核对内容就传 `enter:false`）。' +
      '中文**不要**用 `type` 直接打，会被输入法拦掉。\n' +
      '3. 切不过去（回执说没能置前）时，**如实告诉用户请他点一下那个窗口**，不要盲试坐标或截图。\n' +
      '\n微信的完整例子：`uia_keys {"keys":"ctrl+f","match":"微信"}` → set_clipboard 放会话名 → ' +
      '`uia_paste {"match":"微信"}` → set_clipboard 放正文 → `uia_paste {"match":"微信","enter":false}` → ' +
      '`uia_read_input {"match":"微信"}` 核对内容对不对 → `uia_keys {"keys":"return","match":"微信"}`。'
    )
  }
  const lines = els.map((e) => {
    const marks = []
    if (e.offscreen) marks.push('不可见')
    if (e.enabled === false) marks.push('禁用')
    const pats = Array.isArray(e.patterns) ? e.patterns.filter((p) => ['Invoke', 'Value', 'SelectionItem', 'Toggle', 'ExpandCollapse'].includes(p)) : []
    if (pats.length) marks.push('可' + (pats.includes('Value') ? '输入' : '点击'))
    const name = e.name ? `「${e.name}」` : ''
    const aid = e.aid ? ` #${e.aid}` : ''
    return `[${e.ref}] ${e.type} ${name}${aid}${marks.length ? ' ｜' + marks.join('/') : ''}${rectText(e.rect)}`
  })
  const tail = r.truncated ? ['', '（元素过多已截断，可调大 max 或先 uia_click 展开分组后再读）'] : []
  const bg = els.some((e) => e.offscreen)
    ? [
        '',
        '⚠️ 这个窗口现在是**最小化或在后台**（上面的元素都标了「不可见」）。**先用 `uia_window_focus` 把它还原并提到前台**再继续，' +
          'uia_click / uia_set_text 本身也会负责还原。' +
          '**不要**用 `{"action":"left_click","coordinate":[x,y]}` 去点屏幕上猜的坐标：窗口没在前台时估出来的坐标必然点偏，只会点到别的窗口上去。'
      ]
    : []
  return [
    head,
    `可操作元素 ${els.length} 个（ref 用于 uia_click / uia_set_text / uia_focus）：`,
    ...lines,
    ...tail,
    ...bg
  ].join('\n')
}

function explainError(err) {
  if (!err) return 'UIA 操作失败。'
  if (err === 'stale_ref')
    return '这个 ref 已经失效（窗口内容变了或上一次 uia_tree 已过期）。请重新调 uia_tree 取新的 ref。'
  if (err === 'window_not_found')
    return '没找到匹配的窗口。请先用 uia_windows 看当前有哪些窗口，用其中的准确标题或进程名重试。'
  if (err === 'self_window')
    return (
      '**拒绝发送：当前最前面的窗口是青鸟自己**（就是你现在正在跟用户对话的那个窗口）。' +
      '按键会直接打进对话框、污染用户正在输入的内容，所以这一步被挡住了。\n' +
      '正确做法：用本工具的 `match`（如 "微信"）或 `hwnd` 指定目标窗口，它会先把目标切到前台再发。'
    )
  if (err === 'focus_refused')
    return (
      '**没能把目标窗口切到前台，已放弃发送按键**（否则按键会打进当前前台那个窗口，越搞越乱）。\n' +
      '请如实告诉用户：「xxx 这个窗口切不到最前面，麻烦你点它一下」，不要改用点坐标或截图硬试。'
    )
  if (err === 'missing_keys') return 'keys 参数是必填的（如 `"ctrl+v"`、`"return"`）。'
  if (err === 'send_failed')
    return '按键发送失败（多半是目标窗口属于管理员权限进程，普通权限的输入被系统挡下）。请如实告诉用户当前焦点窗口需要以管理员身份运行青鸟才能控制。'
  if (err === 'no_value_pattern')
    return (
      '该元素不支持直接赋值（没有 Value 模式）。请改用：先 uia_focus 聚焦它，' +
      '再用 `uia_paste` 把剪贴板内容粘进去（中文务必走剪贴板，别用桌面控制的 type）。'
    )
  if (err === 'no_pattern_no_geometry')
    return '该元素既没有可用的操作模式，也没有有效坐标（窗口可能被最小化或已关闭），无法点击。'
  if (err === 'offscreen_geometry')
    return (
      '该元素没有可用的语义动作，而它的坐标落在屏幕之外（窗口被最小化或停在屏幕外），落点会不可靠。' +
      '请先 uia_window_focus 把窗口还原到前台，再重新 uia_tree 后重试。'
    )
  if (err === 'focus_failed') return '聚焦该元素失败，请重新 uia_tree 确认元素仍在。'
  if (err === 'timeout') return '等待 UIA 宿主响应超时（桌面可能卡顿或窗口无响应）。可稍后重试。'
  return `UIA 操作失败：${err}`
}

function failText(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true }
}

/**
 * 键盘类工具的共同拒绝文案。
 *
 * 这两类拒绝都是**有意为之的保护**，而且都必须落到「让模型改做法」而不是「重试一次」：
 *  · self_window   —— 当前前台是青鸟自己，按键会打进用户正在对话的输入框；
 *  · focus_refused —— 目标窗口抢不到前台，此时发键会打进别的窗口。
 * 两条都保持 isError，让模型把话如实转达给用户，而不是继续瞎试。
 */
function inputRefusal(r) {
  if (r.error === 'self_window') {
    return failText(
      '【已拒绝发送按键：当前最前面的窗口是青鸟自己】' +
        (r.title ? `（「${r.title}」/ ${r.proc}）` : '') +
        '\n按键会直接打进你正在跟用户对话的那个输入框，把用户正在写的内容搅乱，所以这一步被挡下了。\n' +
        '正确做法：**带上目标窗口再发**——`uia_keys {"keys":"...","match":"微信"}`，' +
        '或 `uia_paste {"match":"微信"}`，或先 `uia_window_focus "微信"`。' +
        '带 match 的调用会先把目标窗口切到前台并**确认成功后才发键**，不会再打到青鸟自己身上。'
    )
  }
  if (r.error === 'focus_refused') {
    return failText(
      `【已放弃发送按键：没能把「${r.name || r.proc || r.hwnd}」切到最前面】` +
        '（Windows 不允许后台进程抢前台，且青鸟窗口正挡在前面；此时发键会打进当前前台那个窗口）\n' +
        '请如实告诉用户：这个窗口切换不到最前面，**麻烦手动点一下它**，然后你继续。\n' +
        '不要改用点坐标、也不要截图硬试——那只会点到别的窗口上。'
    )
  }
  return failText(explainError(r.error ?? r.message))
}

// 工具名**不要带 uia_ 前缀**：内核注册时会自动拼上服务名（配置里的 key 就叫 uia），
// 写成 uia_tree 会被注册成 uia_uia_tree，与提示词里的 uia_tree 对不上 → 模型按文档调用报「工具不存在」。
// 所以这里只写后半截，最终注册名就是 uia_windows / uia_tree / uia_click / uia_set_text / uia_focus / uia_window_focus。
const TOOLS = [
  {
    name: 'windows',
    description:
      '列出当前桌面所有顶层窗口（标题 / 进程名 / hwnd），并标出当前前台窗口。' +
      '操作任何桌面应用的第一步：先用它确认目标应用是否已打开、窗口标题是什么。' +
      UIA_NOTE,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'tree',
    description:
      '读一个窗口的**无障碍树**：返回可操作元素清单（[ref] 类型「名称」），用 ref 去 uia_click / uia_set_text / uia_focus。' +
      '这是操作原生控件应用（资源管理器、记事本、系统设置、Office 等）**唯一推荐的方式**：纯文本、几十毫秒、' +
      '**不需要模型支持图片输入**，也**不要为此去截屏**。' +
      '不传 match/hwnd 时读当前前台窗口。' +
      UIA_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: '窗口标题或进程名的关键词（如「文件资源管理器」「notepad」），不区分大小写' },
        hwnd: { type: 'number', description: '窗口句柄（uia_windows 返回的 hwnd），比 match 更精确' },
        depth: { type: 'number', description: '遍历深度，默认 6' },
        max: { type: 'number', description: '最多返回多少个元素，默认 120' },
        interactiveOnly: { type: 'boolean', description: '只返回可操作元素，默认 true；设为 false 可看完整结构（调试用）' }
      }
    }
  },
  {
    name: 'click',
    description:
      '点击窗口里的一个元素（ref 来自 uia_tree）。优先用元素自身的语义动作（Invoke / Select / Toggle），' +
      '没有语义动作时才退化为在该元素中心点一次真实鼠标。' +
      '比截图后估算坐标可靠得多——不依赖模型看图，也不会因为窗口移动而点错位置。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'number', description: 'uia_tree 返回的 ref 编号' } },
      required: ['ref']
    }
  },
  {
    name: 'set_text',
    description:
      '往输入框直接写入文本（ref 来自 uia_tree，需要该元素支持 Value 模式）。中文也能正确写入，' +
      '不走模拟按键、不受输入法状态影响。若元素不支持直接赋值，会提示你先 uia_focus 再用 uia_paste 粘贴。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'uia_tree 返回的 ref 编号' },
        text: { type: 'string', description: '要写入的文本' }
      },
      required: ['ref', 'text']
    }
  },
  {
    name: 'focus',
    description: '把某个元素设为键盘焦点，并把它的窗口提到前台（ref 来自 uia_tree）。用于「先聚焦、再用 uia_keys / uia_paste 输入」这种组合。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'number', description: 'uia_tree 返回的 ref 编号' } },
      required: ['ref']
    }
  },
  {
    name: 'window_focus',
    description:
      '按标题/进程名把某个窗口还原并提到前台（如「微信」「notepad」）。' +
      '需要操作一个当前被盖住的窗口时，先用它激活，再 uia_tree（不传参即读前台窗口）或发键盘快捷键。' +
      '**如果它回「没能置为前台」，不要接着发按键**（键会打进当前前台那个窗口）——如实告诉用户请他点一下那个窗口。',
    inputSchema: {
      type: 'object',
      properties: { match: { type: 'string', description: '窗口标题或进程名的关键词，不区分大小写' } },
      required: ['match']
    }
  },
  {
    name: 'keys',
    description:
      '按一次键盘组合键（原生 SendInput，确定可靠）。**所有按键都走这个工具，不要再用桌面控制的 computer 的 key 动作**。\n' +
      '· `ctrl+f` 打开搜索框 ｜ `ctrl+v` 粘贴 ｜ `ctrl+a` 全选 ｜ `ctrl+c` 复制 ｜ `return` 回车 ｜ `esc` 取消 ｜ `tab` 切换 ｜ 方向键 `up`/`down`/`left`/`right`。\n' +
      '· 传 `match`（如 "微信"）或 `hwnd` 时，会**先把那个窗口提到前台并确认**，确认不了就拒绝发送——所以带上它比自己先 focus 再按键更安全。\n' +
      '· **青鸟自己的窗口永远不会被输入**：若当前最前面的窗口就是青鸟，本工具直接拒绝，不会把按键打进你正在跟用户对话的输入框里。',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: '组合键，如 "ctrl+v"、"ctrl+shift+t"、"return"、"esc"' },
        match: { type: 'string', description: '可选：目标窗口标题/进程名关键词（如 "微信"），会先聚焦并确认' },
        hwnd: { type: 'number', description: '可选：目标窗口句柄，比 match 精确' }
      },
      required: ['keys']
    }
  },
  {
    name: 'paste',
    description:
      '一步完成「把剪贴板内容粘贴进目标窗口」：聚焦目标窗口 → 确认前台 → 全选覆盖 → Ctrl+V →（默认）回车发送。\n' +
      '**粘贴前会先 Ctrl+A 全选**，所以它是**覆盖**而不是追加——不管输入框里原本剩了什么（上一轮的残留、搜索框旧关键词），' +
      '粘完里面就是你要发的这一份内容。\n' +
      '这是**往任何程序里输入中文或发送文件/图片的唯一推荐方式**（直接打字会被输入法拦掉，先 set_clipboard 再调本工具）。\n' +
      '用法：`computer-use_set_clipboard`（mode=text/file/image）先把内容放进剪贴板 → 调本工具。\n' +
      '`enter:false` 表示只粘进输入框、先不回车——**发正文时建议这么用**，接着 `uia_read_input` 核对内容，' +
      '确认无误再 `uia_keys {"keys":"return"}` 发送。',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: '目标窗口标题/进程名关键词（如 "微信"）；建议总是传' },
        hwnd: { type: 'number', description: '目标窗口句柄，比 match 精确' },
        enter: { type: 'boolean', description: '粘贴后再按一次回车发送，默认 true；想先核对内容就传 false' }
      }
    }
  },
  {
    name: 'read_input',
    description:
      '**读回当前输入框里真实的文字**（Ctrl+A 全选 + Ctrl+C 复制，再读系统剪贴板）——用来核对「刚才那一步到底输进去没有、内容对不对」。\n' +
      '自绘界面（微信这类无障碍树是空的）读不到元素，这是**唯一不需要截图就能校验输入内容**的手段。\n' +
      '典型用法：粘贴正文之后、按回车发送之前，先 read_input 确认内容与预期一致；不一致就重新 set_clipboard + paste（粘贴前先 `ctrl+a` 可覆盖旧内容），**不要把一个明显不对的内容发出去**。\n' +
      '注意：它会占用系统剪贴板（读回的内容就存在剪贴板里），并且会改变输入框的选区状态。',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: '目标窗口标题/进程名关键词；不传则用当前前台窗口' },
        hwnd: { type: 'number', description: '目标窗口句柄' }
      }
    }
  },
  {
    name: 'foreground',
    description:
      '读当前**前台窗口**是什么（标题 / 进程名 / pid / hwnd），以及它是不是青鸟自己。\n' +
      '发送按键、粘贴、点击这些「不可撤销」的动作之前，用它核对一眼当前焦点在哪个窗口上，比事后补救便宜得多。',
    inputSchema: { type: 'object', properties: {} }
  }
]

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function handleTool(name, args) {
  const a = args ?? {}
  // 内核转发的是声明名（windows / tree …）；同时容忍带前缀的写法（uia_windows）
  const n = String(name).replace(/^uia_/, '')
  switch (n) {
    case 'windows': {
      const r = await call('windows')
      return text(formatWindows(r))
    }
    case 'tree': {
      const r = await call('tree', {
        match: a.match,
        hwnd: a.hwnd,
        depth: a.depth,
        max: a.max,
        interactiveOnly: a.interactiveOnly
      })
      if (r.ok === false) return text(explainError(r.error ?? r.message))
      return text(formatTree(r))
    }
    case 'click': {
      const r = await call('invoke', { ref: a.ref })
      if (r.ok === false) return text(explainError(r.error ?? r.message))
      const where = r.via === 'mouse' ? `（该元素无语义动作，已在中心点 (${r.x},${r.y}) 真实点击）` : `（${r.via} 模式）`
      return text(`已点击 ref=${a.ref} ${where}。若页面/窗口内容因此变化，请重新 uia_tree 取新的 ref。`)
    }
    case 'set_text': {
      const r = await call('set_value', { ref: a.ref, text: String(a.text ?? '') })
      if (r.ok === false) return text(explainError(r.error ?? r.message))
      return text(`已写入 ref=${a.ref}：${JSON.stringify(String(a.text ?? ''))}（Value 模式）`)
    }
    case 'focus': {
      const r = await call('focus', { ref: a.ref })
      if (r.ok === false) return text(explainError(r.error ?? r.message))
      return text(`已聚焦 ref=${a.ref}，其所属窗口已提到前台。现在可以用桌面控制的 key/type 发按键了。`)
    }
    case 'window_focus': {
      const r = await call('focus_window', { match: String(a.match ?? '') })
      if (r.ok === false) return text(explainError(r.error ?? r.message))
      const fg = r.foreground
        ? r.clicked
          ? '已置为前台（API 抢焦点被系统拒绝，最后靠点了一下它的标题栏拿到前台权，窗口可能因此多了一个搜索框或菜单，发按键前先按一次 `esc` 收掉）'
          : '已置为前台'
        : '⚠️ **没能置为前台**：Windows 前台锁不允许后台进程抢焦点，已依次试过 SetForegroundWindow / AttachThreadInput / SwitchToThisWindow / ALT 键 / 点标题栏，全被拒。\n' +
          '**此时绝对不要发键盘按键**——键会打进当前前台那个窗口，越搞越乱。\n' +
          '改用 `uia_tree` 读它的元素、`uia_click` 点元素（语义点击不依赖前台权）；' +
          '如果它确实是自绘界面（树是空的）而任务又必须发按键，就如实告诉用户「这个窗口没能切到前台，请手动点它一下」，不要盲试。'
      return text(`窗口「${r.name}」进程 ${r.proc} (hwnd ${r.hwnd})：${fg}。接下来 uia_tree 不传参即可读它的元素。`)
    }
    case 'keys': {
      const r = await call('send_keys', { keys: String(a.keys ?? ''), match: a.match, hwnd: a.hwnd })
      // inputRefusal 返回的就是完整结果对象（含 isError），**不能再套 text()**——
      // 套了会把对象塞进 text 字段，模型看到的是 "[object Object]"。
      if (r.ok === false) return inputRefusal(r)
      return text(
        `已按 ${r.keys}。` + (r.fg_title ? `（当时的当前窗口：「${r.fg_title}」/ ${r.fg_proc}）` : '')
      )
    }
    case 'paste': {
      const r = await call('paste', { match: a.match, hwnd: a.hwnd, enter: a.enter })
      if (r.ok === false) return inputRefusal(r)
      return text(
        (r.entered
          ? '已把剪贴板内容粘贴到输入框**并按下回车发送**。'
          : '已把剪贴板内容粘贴到输入框（**没有回车**，还在输入框里）。想核对内容就调 `uia_read_input`，想发送就再调 `uia_keys {"keys":"return"}`。') +
          (r.fg_title ? `（目标窗口：「${r.fg_title}」/ ${r.fg_proc}）` : '')
      )
    }
    case 'read_input': {
      const r = await call('read_input', { match: a.match, hwnd: a.hwnd })
      if (r.ok === false) return text(inputRefusal(r))
      return text(
        `当前输入框里的内容（${r.length} 个字，已复制到剪贴板）：\n"""\n${r.text}\n"""\n` +
          '拿它和你打算发送的内容对比：一致就按 `return` 发送；不一致就重新 set_clipboard 后 paste（粘贴前先 `ctrl+a` 覆盖旧的），不要把不对的内容发出去。'
      )
    }
    case 'foreground': {
      const r = await call('foreground')
      const selfNote = r.self
        ? '\n⚠️ 这个窗口**就是青鸟自己**：此时发任何按键都会被拒绝，请先指定目标窗口（`uia_window_focus` 或让 `uia_keys` / `uia_paste` 带上 `match`）。'
        : ''
      return text(`当前前台窗口：「${r.title || '(无标题)'}」进程 ${r.proc} pid=${r.pid} hwnd=${r.hwnd}${selfNote}`)
    }
    default:
      return text(`未知工具：${name}`)
  }
}

// ---------------------------------------------------------------- 预热宿主
// 宿主是 PowerShell 进程，首次启动要现场 Add-Type 编译 C#（实测 2~4 秒，还叠杀软扫描）。
// 若第一次真调用正好赶上这段冷启动，容易被判成超时。开机后台先 ping 一次（零副作用），
// 把宿主拉起来并编译完，之后每次调用都是常驻响应。
void call('ping').catch(() => {})

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method } = req
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'qn-uia', version: '1.0.0' }
      }
    })
  } else if (method === 'notifications/initialized') {
    // 通知无需响应
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    try {
      const result = await handleTool(name, req.params?.arguments)
      send({ jsonrpc: '2.0', id, result })
    } catch (e) {
      const msg = e?.message ?? String(e)
      const hint = stderrTail.length && /timeout|启动失败|已退出/.test(msg) ? `\n宿主 stderr：\n${stderrTail.slice(-4).join('\n')}` : ''
      send({ jsonrpc: '2.0', id, result: failText(explainError(msg) + hint) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})

function shutdown() {
  try {
    if (child) child.kill()
  } catch {}
}
process.on('exit', shutdown)
process.on('SIGTERM', () => {
  shutdown()
  process.exit(0)
})
process.on('SIGINT', () => {
  shutdown()
  process.exit(0)
})
