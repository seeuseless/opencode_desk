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
  '无障碍树是空的，UIA 对它无效——不要反复重试，改走键盘快捷键。'

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
      'UIA 对它无效——**不要再对同一个窗口重试 uia_tree / uia_windows**。请改走**纯键盘流程**：' +
      '`uia_window_focus "<窗口名>"` 提到前台（若回执说没能置为前台，先用一个真实点击把它点成前台），' +
      '再用桌面控制的 `{"action":"key","text":"ctrl+f"}` 这类按键（按键串放 `text` 字段，多数 IM 用 Ctrl+F 打开搜索框）、' +
      '中文输入走剪贴板 + `{"action":"key","text":"ctrl+v"}`。**这条链路不需要看画面，也不要为了确认去截图**。'
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
        '注：标了「不可见」的元素属于后台或最小化的窗口。uia_click / uia_set_text 会**先把它的窗口还原并提到前台**再操作，' +
          '所以通常不必自己先 uia_window_focus；但如果你要连着发键盘按键，请先 uia_window_focus 确保焦点在目标窗口上。'
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
  if (err === 'no_value_pattern')
    return (
      '该元素不支持直接赋值（没有 Value 模式）。请改用：先 uia_focus 聚焦它，' +
      '再用桌面控制的 `{"action":"type","text":"要输入的文字"}` 把文字打进去。'
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
      '不走模拟按键、不受输入法状态影响。若元素不支持直接赋值，会提示你改用 uia_focus + 桌面控制的 type。',
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
    description: '把某个元素设为键盘焦点，并把它的窗口提到前台（ref 来自 uia_tree）。用于「先聚焦、再用桌面控制的 key/type 输入」这种组合。',
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
      '需要操作一个当前被盖住的窗口时，先用它激活，再 uia_tree（不传参即读前台窗口）或发键盘快捷键。',
    inputSchema: {
      type: 'object',
      properties: { match: { type: 'string', description: '窗口标题或进程名的关键词，不区分大小写' } },
      required: ['match']
    }
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
        ? '已置为前台'
        : '**没能置为前台**（Windows 不允许后台进程抢前台，已试过 AttachThreadInput 与 SwitchToThisWindow 两种兜底）。' +
          '此时**不要盲发按键**——键会打进当前前台那个窗口。' +
          '请改用桌面键鼠的 `{"action":"left_click","coordinate":[x,y]}` 点一下这个窗口的可见区域（真实点击能拿到前台权），再发按键。'
      return text(`窗口「${r.name}」进程 ${r.proc} (hwnd ${r.hwnd})：${fg}。接下来 uia_tree 不传参即可读它的元素。`)
    }
    default:
      return text(`未知工具：${name}`)
  }
}

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
