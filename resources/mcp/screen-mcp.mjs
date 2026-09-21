#!/usr/bin/env node
// 电脑控制「视觉叠加」MCP：给收不了图的对话模型（如 deepseek）装上眼睛。
//
// 为什么需要它：computer-use-mcp 的 get_screenshot 回的是 MCP image content（base64 PNG），
// 内核按模型真实能力分发——纯文本模型只拿到 image_width/image_height 两行 JSON，等于闭眼点鼠标。
// 实测模型会弃用工具、改去写 PowerShell 模拟键鼠，越搞越乱。
//
// 做法：把 computer 工具原样代理一层，**只改 get_screenshot 的返回**——
// 截图照原样透传（能看图的模型零损耗），同时**附上一段视觉模型写的文字描述**。
// 内核按模型真实能力分发 content：收不了图的模型自动丢掉 image 只留文字，
// 能看图的模型图文都拿到。这样无需知道对话模型是谁，也不会误判。
// 键鼠动作（left_click / type / key / scroll）返回的都是 JSON，原样透传，不受影响。
//
// 视觉目标由主进程经 QN_VISION_TARGETS 注入，与 vision-mcp.mjs 同一份清单。
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { authorize, deniedText, markUsed } from './gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 原生键盘输入脚本（与 uia 宿主共用同一份实现），见文件头的说明 */
const WIN_INPUT_PS = join(HERE, 'win-input.ps1')

const parse = (v) => {
  try {
    return JSON.parse(v || '[]')
  } catch {
    return []
  }
}
const VISION_TARGETS = parse(process.env.QN_VISION_TARGETS)
/** 被代理的 computer-use-mcp 启动方式（主进程注入，跟随其 npx 调用约定） */
const UPSTREAM_CMD = process.env.QN_SCREEN_UPSTREAM_CMD || 'npx'
const UPSTREAM_ARGS = parse(process.env.QN_SCREEN_UPSTREAM_ARGS)
if (!UPSTREAM_ARGS.length) UPSTREAM_ARGS.push('-y', 'computer-use-mcp')

/**
 * 兜底超时（毫秒）：**桌面控制的每一步都必须有上限，绝不能无限等**。
 *
 * 为什么必须有：computer-use-mcp 的截图回包是一整行 ~170KB 的 base64 JSON，
 * Node 的裸 `'data'` 事件按 64KB 切片下发——早期版本在每个分片里单独 JSON.parse，
 * 三片全部解析失败被静默丢弃，那次 tools/call 的 Promise **永远不 resolve**，
 * 界面表现就是「AI 正在控制你的电脑」一动不动地挂着。
 *
 * 所以这里一层层都设上限：单次工具调用总预算 25s（内核侧再兜一层 30s），
 * 其中等上游回包最多 20s、单次识图最多 10s。超时按下面三档：
 *   CALL_BUDGET_MS      —— 一次 computer 调用的**总预算**，超时必有回包（isError）
 *   UPSTREAM_TIMEOUT_MS —— 等上游某个回包的上限（截图实际只要 1~2s）
 *   VISION_TIMEOUT_MS   —— 单次问视觉模型的上限
 * 宁可让模型拿到一句明确的「超时，请重试」去继续对话，也不要让整个任务悬着。
 */
const CALL_BUDGET_MS = 25000
const UPSTREAM_TIMEOUT_MS = 20000
const VISION_TIMEOUT_MS = 10000

/**
 * 截图预算：**一段时间内最多截几次图**。超了直接熔断（isError 回执），不再往上游发。
 *
 * 为什么要有：早期版本没有预算，「点一下 → 截一张 → 再点一下 → 再截一张」在用户眼里就是
 * **反复截屏死循环**——每张截图都要额外调一次视觉模型（10s 级、消耗额度）。
 *
 * **上限取多少取决于主通道是哪一条**（这里踩过一次坑，别再收紧回去了）：
 * 桌面控制一度把「无障碍树 uia_*」当成首选、截图降为「最后兜底」，于是这里被压到 3 次/2 分钟。
 * 但**无障碍树对自绘界面（微信 4.0 等）是空的**，而截图预算又只剩 3 次——两条路同时走不通，
 * 任务直接卡死。实测「截图 + 识别图片」才是能用到底的那条路，它的正常节奏本来就是**每步一张**。
 *
 * 所以现在放回到「够跑完一个完整任务」的量级：允许每步一张，靠**动作间隔**而不是靠次数来防死循环
 * （真正的死循环是「截 → 什么都没做 → 再截」，那由工具描述里的硬规则管，熔断只兜最后一道底）。
 *
 * 阈值可用环境变量调（QN_SCREEN_SHOT_MAX / QN_SCREEN_SHOT_WINDOW_MS）。
 */
const SHOT_MAX = Number(process.env.QN_SCREEN_SHOT_MAX) > 0 ? Number(process.env.QN_SCREEN_SHOT_MAX) : 20
const SHOT_WINDOW_MS =
  Number(process.env.QN_SCREEN_SHOT_WINDOW_MS) > 0 ? Number(process.env.QN_SCREEN_SHOT_WINDOW_MS) : 120000
const shotAt = []
/** 记一次截图并回答「这次允许吗」：窗口内已达上限则拒绝（且不再记账） */
function shootAllowed() {
  const now = Date.now()
  while (shotAt.length && now - shotAt[0] > SHOT_WINDOW_MS) shotAt.shift()
  if (shotAt.length >= SHOT_MAX) return false
  shotAt.push(now)
  return true
}

/** 给一个 promise 套上截止时间：到点以 Error 结束，绝不悬着 */
function withDeadline(p, ms, msg) {
  let timer
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(msg)), Math.max(1, ms))
    })
  ]).finally(() => clearTimeout(timer))
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
/** 工具回执（含超时/失败说明）：用 isError 而非 JSON-RPC error——模型拿到的是可读原因，能据此继续 */
const textResult = (text) => ({ content: [{ type: 'text', text }] })
const errResult = (text) => ({ content: [{ type: 'text', text }], isError: true })
const fail = (id, text) => send({ jsonrpc: '2.0', id, result: errResult(text) })

// ---------- 上游 computer-use-mcp 子进程：JSON-RPC 行协议透传 ----------
/** 上游初始化失败时用它把 upstreamReady 打下去（声明在前，error 回调里才不会踩 TDZ） */
let upReadyReject
/**
 * 必须给上游带 `ELECTRON_RUN_AS_NODE=1`。
 *
 * 主进程注入的 UPSTREAM_CMD 就是 **Electron 二进制本身**（`process.execPath`，打包态靠它充当 node，
 * 不依赖用户机器上有没有装 node）。但 Windows 上 Electron 以 **GUI app 模式**启动时 stdout 不接管道
 * ——上游的 JSON-RPC 回包一个都收不到，每次 tools/call 都会等到 20 秒超时。用户看到的就是
 * 「桌面控制这一步超时了（截屏连续两次没返回）」。置 1 后走纯 Node 模式，stdout 正常；
 * 对真正的 node / npx 这一项会被忽略，无副作用。
 */
const upEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const up = spawn(UPSTREAM_CMD, UPSTREAM_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: upEnv })
up.stderr.on('data', (d) => process.stderr.write(d))
up.on('error', (e) => {
  process.stderr.write(`[screen-mcp] 上游启动失败：${e?.message ?? e}\n`)
  upReadyReject?.(e)
})

/** 待回包：上游请求 id → 本层处理器（改写的返回经它发回内核） */
const pending = new Map()
let nextId = 1
/** 上游进程没了：把所有在等的调用就地了结，免得同一个请求又被悬住一次 */
function rejectAll(reason) {
  for (const [id, w] of pending) {
    clearTimeout(w.timer)
    pending.delete(id)
    w.reject(new Error(reason))
  }
}
up.on('exit', (code) => {
  rejectAll('computer-use-mcp 进程已退出（可能被系统或安全软件结束）')
  process.exit(code ?? 0)
})

/** 向上游发一个请求，返回其 result（Promise）；到点没回包就 reject，不等死 */
function askUpstream(method, params, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`computer-use-mcp 超过 ${Math.round(timeoutMs / 1000)} 秒没回包，已中止本次调用`))
    }, timeoutMs)
    pending.set(id, {
      timer,
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    try {
      up.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    } catch (e) {
      clearTimeout(timer)
      pending.delete(id)
      reject(new Error('写不进 computer-use-mcp：' + (e?.message ?? e)))
    }
  })
}

/**
 * 读上游 stdout：**必须自己攒行**。
 *
 * 一个 data 块不等于一行——截图那条回包实测被切成 64KB + 64KB + 38KB 三段，
 * 逐块 parse 只能解析出第三段之前的小回包，大回包全丢。这里用 StringDecoder 累积缓冲
 * （顺带保证多字节字符不会被块边界劈坏），凑齐整行再解析。
 */
const decoder = new StringDecoder('utf8')
let upBuf = ''
function handleUpstreamLine(line) {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const wait = msg.id !== undefined ? pending.get(msg.id) : undefined
  if (!wait) return
  pending.delete(msg.id)
  if (msg.error) wait.reject(new Error(msg.error.message ?? 'upstream error'))
  else wait.resolve(msg.result)
}
up.stdout.on('data', (buf) => {
  upBuf += decoder.write(buf)
  let i
  while ((i = upBuf.indexOf('\n')) >= 0) {
    const line = upBuf.slice(0, i)
    upBuf = upBuf.slice(i + 1)
    handleUpstreamLine(line)
  }
})

// ---------- 上游握手「快答应」：不让上游的启动耗时拖垮内核的 MCP 握手 ----------
//
// 坑：内核拉起本脚本后会**立刻**做 initialize + tools/list，超时就判定这个 MCP 启动失败
// —— 表现就是「桌面控制开了，却只有 app_running、没有截屏/点击/输入」。
// 上游 computer-use-mcp 走 npx 时实测 ~8 秒才吐第一行（本地直连也要 1.4 秒），
// 老老实实转发握手的話，这个耗时必然超时。
//
// 解法：initialize / tools/list 由本层**静态应答**（schema 取自上游真包，稳定），
// 上游在后台慢慢启；等模型真的来调工具时它早就起来了。
/** 上游 initialize 完成的信号；所有 tools/call 都等它 */
const upstreamReady = new Promise((resolve, reject) => {
  upReadyReject = reject
  askUpstream('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'screen-mcp', version: '1.0.0' }
  }).then(resolve, reject)
})
/**
 * 预置一个 no-op 处理器，**不能删**。
 *
 * 这个 promise 只在真有 tools/call 进来时才被 await。若上游在第一次调用之前就挂了
 * （`npx` 不在 PATH、包没装、安全软件拦截），裸 reject 会变成 **unhandled rejection**，
 * Node 15+ 默认直接把进程带走——用户看到的是「桌面控制整块消失」，而不是「这一次截图失败」。
 * 实测就是这么崩的：`spawn npx ENOENT` 之后 MCP 进程当场退出，内核侧连 tools/list 都拿不到。
 * 挂上 catch 之后，reject 仍会正常传给 await 它的那次调用（错误信息照旧），进程活着。
 */
upstreamReady.catch(() => {})

/** 上游 tools/list 的真实返回（1.8.0 实测抄录）：握手阶段直接交出，不等上游 */
const STATIC_TOOLS = [
  {
    name: 'computer',
    title: 'Computer Control',
    description:
      // ---- 青鸟前置约束（必须放在上游英文之前：模型对描述里靠前的硬规则更买账，
      //      而上游原文明确鼓励「多截几张看结果 / 看截图定坐标」，那正是截屏死循环的源头）----
      '【青鸟桌面控制 · 最高优先级，与下面通用说明冲突时以本段为准】\n' +
      '**主通道是「截图 → 看画面 → 动作」**：`{"action":"get_screenshot"}` 拿画面 → ' +
      '按画面里的位置 `{"action":"left_click","coordinate":[x,y]}` 点、或 `{"action":"key","text":"ctrl+f"}` 发键。\n' +
      '每一步之前都可以截一张来判断「该点哪儿 / 上一步成没成」——**这是正常节奏，不要憋着不截**。\n' +
      '**禁止的是空转截屏：两张截图之间必须夹一个真实动作**（点击 / 按键 / 输入 / 滚动）。' +
      '「截一张 → 什么都没做 → 再截一张」才是死循环，会被熔断。\n' +
      '看不到图也照样能定位：截图回执会附一段「【电脑画面（由 X 识别）】」的文字描述（视觉模型代看），以它为准；' +
      '坐标按截图尺寸估，图上那个红色十字是当前鼠标位置，点偏了就按它的偏移量成比例修正（偏差往往比你想的大）。\n' +
      '**中文 / 文件 / 图片一律走剪贴板**：`computer-use_set_clipboard` 放好内容 → ' +
      '`{"action":"key","text":"ctrl+v"}` 粘贴；要指定窗口就改用 `uia_paste {"match":"微信"}`（先切前台再粘）。' +
      '**`type` 直接打中文会被输入法拦掉**，不要走那条路。\n' +
      '无障碍树（`uia_windows` / `uia_tree` / `uia_click`）只在**原生控件应用**（资源管理器、记事本、Office）上顺手一用；' +
      '**读不到元素就立刻回到截图通道，不要反复试树**——自绘界面（微信 4.0 这类把 UI 画在画布上的应用）' +
      '`uia_tree` 是空的，实测只剩标题栏三个按钮。\n' +
      '**青鸟自己的窗口永远不会被输入**：当前最前面是青鸟（用户正在对话的这个窗口）时，key/type 会被**直接拒绝**——' +
      '这是保护用户输入框的一道闸，不是故障；照回执改用带 `match` 的 `uia_keys` / `uia_paste` 即可。\n\n' +
      'Use a mouse and keyboard to interact with a computer, and take screenshots.\n' +
      '* This is an interface to a desktop GUI. You do not have access to a terminal or applications menu. You must click on desktop icons to start applications.\n' +
      '* Always prefer using keyboard shortcuts rather than clicking, where possible.\n' +
      '* If you see boxes with two letters in them, typing these letters will click that element. Use this instead of other shortcuts or clicking, where possible.\n' +
      '* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Firefox and a window doesn\'t open, try taking another screenshot.\n' +
      '* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n' +
      '* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.\n' +
      '* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don\'t click boxes on their edges unless asked.\n\n' +
      'Window focus:\n' +
      '* On macOS, clicking on a window that is not focused (e.g. behind another application) may only bring that window to the front without triggering the actual click on the element. If your click doesn\'t seem to have had an effect, take a screenshot to verify and click again — the window should now be focused and the second click will register.\n\n' +
      'Using the crosshair:\n' +
      '* Screenshots show a red crosshair at the current cursor position.\n' +
      '* After clicking, check where the crosshair appears vs your target. If it missed, adjust coordinates proportionally to the distance - start with large adjustments and refine. Avoid small incremental changes when the crosshair is far from the target (distances are often further than you expect).\n' +
      '* Consider display dimensions when estimating positions. E.g. if it\'s 90% to the bottom of the screen, the coordinates should reflect this.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'key',
            'type',
            'mouse_move',
            'left_click',
            'left_click_drag',
            'right_click',
            'middle_click',
            'double_click',
            'scroll',
            'get_screenshot',
            'get_cursor_position'
          ],
          description:
            'The action to perform. The available actions are:\n' +
            '* key: Press a key or key-combination on the keyboard.\n' +
            '* type: Type a string of text on the keyboard.\n' +
            '* get_cursor_position: Get the current (x, y) pixel coordinate of the cursor on the screen.\n' +
            '* mouse_move: Move the cursor to a specified (x, y) pixel coordinate on the screen.\n' +
            '* left_click: Click the left mouse button. If coordinate is provided, moves to that position first.\n' +
            '* left_click_drag: Click and drag the cursor to a specified (x, y) pixel coordinate on the screen.\n' +
            '* right_click: Click the right mouse button. If coordinate is provided, moves to that position first.\n' +
            '* middle_click: Click the middle mouse button. If coordinate is provided, moves to that position first.\n' +
            '* double_click: Double-click the left mouse button. If coordinate is provided, moves to that position first.\n' +
            '* scroll: Scroll the screen in a specified direction. Requires coordinate (moves there first) and text parameter with direction: "up", "down", "left", or "right". Optionally append ":N" to scroll N pixels (default 300), e.g. "down:500".\n' +
            '* get_screenshot: Take a screenshot of the screen.'
        },
        coordinate: {
          minItems: 2,
          maxItems: 2,
          type: 'array',
          items: { type: 'number' },
          description: '(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates'
        },
        text: {
          description:
            'The text to type, or the key combination to press.\n' +
            '* For action "type": the literal string to type, e.g. "文件传输助手".\n' +
            '* For action "key": an xdotool-style key string, e.g. "return", "ctrl+f", "alt+tab", "win". This is where the key(s) go — there is NO separate "key" field.\n' +
            '* For action "scroll": direction, optionally ":N", e.g. "down:500".',
          type: 'string'
        }
      },
      required: ['action'],
      // 故意放开额外字段：模型偶发把按键串写成 key/keys 等，本层归一化会把它翻成 text。
      // 若这里设成 false，内核会先一步拒收，模型只看到「参数不完整」，反而更容易改成乱试。
      additionalProperties: true
    },
    annotations: { readOnlyHint: false },
    execution: { taskSupport: 'forbidden' }
  }
]

/**
 * 本层自有工具（不代理上游）：剪贴板。
 *
 * 为什么要造它——用户实测卡在这一步过：
 * 「生成一个鹈鹕图片并发送给微信好友」时，生图工具已经回了本地绝对路径，
 * 但模型不知道怎么把一个**本地文件**交给微信（自绘界面里没有可点的「发送文件」元素），
 * 于是它去调 vision_describe_image「看」这张图，还凭空编了个路径（工作目录下的 image.png），
 * 报错后又 glob **\/*.png 找不到，最后只能回一句「未能读取到图片文件路径」摆烂。
 *
 * Windows 上把内容交给另一个程序，可靠手段其实只有**剪贴板 + Ctrl+V**：
 *  · 中文文本：模拟按键打中文会被输入法拦掉（ID 里既有的老坑），剪贴板一步到位；
 *  · 文件/图片：在微信、QQ 的聊天窗口里粘贴剪贴板中的文件或位图，等于直接发送该文件。
 * 以前模型只能自己 `bash` 跑 PowerShell Set-Clipboard（能成，但绕、还常写错编码），
 * 现在给它一个正经工具。
 */
const LOCAL_TOOLS = [
  {
    name: 'set_clipboard',
    description:
      '把内容放进 Windows 剪贴板，然后**用 `uia_paste {"match":"微信"}` 粘进目标窗口**（粘贴一律走这个组合，' +
      '不要自己拼 `ctrl+v`——那样容易打进别的窗口）。三种模式：\n' +
      '· `mode:"text"`（默认）——放文字。**往任何程序里输入中文都必须走这条路**（直接 type 会被输入法拦掉或出乱码）。\n' +
      '· `mode:"image"`——把本地图片放进剪贴板（位图）。在微信/QQ 聊天窗口里粘贴会**作为图片消息发送**。\n' +
      '· `mode:"file"`——把本地文件放进剪贴板（文件形式）。在微信/QQ 里粘贴会**作为文件发送**。\n' +
      'files 传**本地绝对路径**：生图 / 生视频 / 转音频等工具回执里「本地文件：」那一行，原样照抄即可，不要改写、不要猜路径。\n' +
      '**发送给真人/群之前，先用 `uia_read_input` 核对输入框里真实的内容**，确认无误再回车——粘错了就重新 set_clipboard 再粘一次。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['text', 'image', 'file'], description: '放什么进剪贴板，默认 text' },
        text: { type: 'string', description: 'mode="text" 时要放进剪贴板的文字' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'mode="image"/"file" 时的本地文件绝对路径（image 只用第一个）'
        }
      }
    },
    annotations: { readOnlyHint: false }
  }
]

// ---------- 识图：把截图转成文字，交给收不了图的对话模型 ----------
const SYSTEM_PROMPT =
  '你是电脑屏幕截图分析助手，正在协助 AI 操作桌面。只描述画面里**实际能看见**的内容，不要推测、不要编造。\n' +
  '按下面的格式回答（简洁，不要客套）：\n' +
  '1. 当前最前面的窗口是什么应用、什么标题；\n' +
  '2. 画面里主要有哪些区域与可点击的按钮/菜单/输入框，各自的大致位置；\n' +
  '3. 红色十字准星（鼠标）现在落在哪里、压着什么元素；\n' +
  '4. 有无弹窗、报错、加载中或需要用户处理的提示。\n' +
  '如果画面看不清，直接说明看不清，不要脑补。'

/** 问视觉模型：返回 { ok, answer, error }；ok=false 时可换下一个目标。到点没回就是不用它 */
async function askVision(t, pngBuffer, timeoutMs = VISION_TIMEOUT_MS) {
  const body = {
    model: t.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + pngBuffer.toString('base64') } },
          // 「假视觉」模型不报错、拿文字编一段像模像样的描述，这是最坑的情况；用 NO_IMAGE 协议揪出来
          { type: 'text', text: '请分析这张屏幕截图。\n（若你根本看不到图片画面，只回复 NO_IMAGE 这七个字母，不要编造内容。）' }
        ]
      }
    ]
  }
  const url = t.baseURL.replace(/\/+$/, '') + '/chat/completions'
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t.apiKey },
      body: JSON.stringify(body),
      // 识图同样不能无限等：单次上限 VISION_TIMEOUT_MS，且不超过整次调用剩下的预算
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    return { ok: false, error: `请求失败（${Math.round(timeoutMs / 1000)}s 超时或网络异常）：${e?.message ?? e}` }
  }
  const raw = await res.text().catch(() => '')
  let j = null
  try {
    j = JSON.parse(raw)
  } catch {
    /* 非 JSON 错误体，原样带给模型 */
  }
  if (!res.ok) {
    const msg = j?.error?.message ?? j?.detail ?? j?.message ?? raw.slice(0, 300)
    return { ok: false, error: `HTTP ${res.status}：${msg}` }
  }
  const answer = String(j?.choices?.[0]?.message?.content ?? j?.content?.[0]?.text ?? '')
  if (!answer) return { ok: false, error: '识图返回为空' }
  if (answer.trim().toUpperCase().startsWith('NO_IMAGE'))
    return { ok: false, error: '该模型看不到图片画面（返回 NO_IMAGE）' }
  return { ok: true, answer }
}

/**
 * 截图 content → 截图 + 文字描述。
 *
 * 原图原样保留（能看图的模型直接看），并额外追一段视觉模型写的文字：
 * 收不了图的模型被内核丢掉 image 后，靠这段文字照样知道屏幕长什么样。
 * 识图失败时不阻断——照原样回图与尺寸信息，并由文字说明原因，避免模型以为是工具坏了。
 */
async function describeScreen(result, deadline) {
  const content = Array.isArray(result?.content) ? result.content : []
  const img = content.find((c) => c?.type === 'image' && c?.data)
  // 上游没回图（被截断/异常）：原样交出，至少让模型看到尺寸信息
  if (!img) return result
  if (!VISION_TARGETS.length) {
    /**
     * 没有配任何视觉代看，且当前模型（大概率）收不了图 → 直接熔断。
     * 软提示会让模型以为「也许能看见」继续截屏空转；这里明确：看不到就是看不到，
     * 停止重试，去让用户配视觉模型。
     */
    if (img) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              '【电脑控制失败：看不到屏幕】你（当前对话模型）不能直接读取本截图（只能收到尺寸信息），' +
              '而当前也没有配置任何视觉代看模型。不要再 get_screenshot 重试了。' +
              '请如实告诉用户：桌面控制需要视觉模型代看画面，请到 设置 → 模型 给真正带视觉能力的模型勾选「图片」输入，' +
              '保存并重开内核后再操作桌面。'
          }
        ]
      }
    }
    // 没图可看的情况极罕见，原样交还让内核自行处理
    return result
  }
  const png = Buffer.from(String(img.data), 'base64')
  const errs = []
  for (const [i, t] of VISION_TARGETS.slice(0, 4).entries()) {
    const who = { role: 'vision', id: t.id, label: t.label ?? t.model, provider: t.provider }
    // 第 0 个目标已在外面（预算开始前）问过用户，这里不重复问——否则用户选「仅这一次」会被连问两遍
    if (i > 0) {
      const grant = await authorize(who)
      if (!grant.allowed) {
        errs.push(`${t.id} → 用户未授权调用该模型`)
        break
      }
    }
    const left = deadline - Date.now()
    // 预算见底就别再试下一个了：再问一次必然会拖到整次调用超时，截图也一并作废
    if (left < 2500) {
      errs.push(`${t.id} → 本次识图预算已用尽，未再尝试`)
      break
    }
    const r = await askVision(t, png, Math.min(VISION_TIMEOUT_MS, left - 1000))
    if (r.ok) {
      await markUsed(who)
      return {
        content: [...content, { type: 'text', text: `【电脑画面（由 ${t.id} 识别）】\n${r.answer}` }]
      }
    }
    errs.push(`${t.id} → ${r.error}`)
  }
  /**
   * 代看全部失败：**硬终止**，绝不让模型再截屏重试。
   *
   * 为什么必须 isError + 强硬措辞：死循环最常见的形态就是模型「get_screenshot → 收不到可靠画面
   * → 再 get_screenshot」，一直空转到用户看得不耐烦。软文案（早先是「请在设置里勾图片后重试」）
   * 模型经常无视、继续拼截图。这里直接声明本轮桌面操作无法继续，明确要求模型**停手并转告用户**，
   * 让「反复截屏」在 1 次内被熔断，而不是无限打转。
   */
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          '【电脑控制失败：视觉不可用】你（当前对话模型）拿不到屏幕画面，且所有代看模型也都失败：\n' +
          errs.join('\n') +
          '\n\n不要再重复 get_screenshot 重试——数你刚才的截图，已经证明这条路走不通，再截多少张也看不到画面。' +
          '请如实向用户说明：桌面控制的视觉代看不可用，需要到 设置 → 模型 里给真正带视觉能力的模型（如名字带 vl/vision、或确实支持读图的模型）' +
          '勾选「图片」输入，保存并重开内核后再让 AI 操作桌面。'
      }
    ]
  }
}

// ---------- 入参归一化：把模型常见的「近义写法」翻译成上游的严格 schema ----------
/**
 * 上游 computer-use-mcp 的入参是 `z.object({action, coordinate?, text?}).strict()`：
 * **多一个字段名就整次调用失败**（内核回「The computer tool was called with invalid arguments」，
 * 界面显示成「调用参数不完整」）。实测最高频的两种错法：
 *   ① 按哪个键写成 `key` / `keys` / `hotkey` —— 上游只认 `text`（`{"action":"key","text":"ctrl+f"}`）；
 *   ② 缺 `text` 直接调 `{"action":"key"}` —— 上游抛 `Text required for key`。
 * 这两类错误一旦发生，模型往往接着改叫裸名 `computer`（内核里不存在这个名字）而连续扑空。
 * 所以在这一层做翻译与校验，别指望模型每次都写对。
 */
const VALID_ACTIONS = [
  'key',
  'type',
  'mouse_move',
  'left_click',
  'left_click_drag',
  'right_click',
  'middle_click',
  'double_click',
  'scroll',
  'get_screenshot',
  'get_cursor_position'
]
const ACTION_ALIASES = {
  screenshot: 'get_screenshot',
  take_screenshot: 'get_screenshot',
  screen_shot: 'get_screenshot',
  click: 'left_click',
  move: 'mouse_move',
  move_mouse: 'mouse_move',
  drag: 'left_click_drag',
  press: 'key',
  keyboard: 'key',
  hotkey: 'key',
  write: 'type',
  input: 'type'
}
/** 模型可能把「按键串」塞进这些字段名：全部归一到 text */
const KEY_FIELDS = ['key', 'keys', 'keyCombination', 'key_combination', 'combo', 'hotkey', 'shortcut', 'shortcutKeys']

/** 把一次 computer 调用的入参收敛成上游只认的三个字段；返回 { args } 或 { bad: 原因 } */
function normalizeComputerArgs(raw) {
  const a = raw && typeof raw === 'object' ? raw : {}
  const action = ACTION_ALIASES[String(a.action ?? '').trim().toLowerCase()] ?? a.action
  const out = { action }
  // 坐标：coordinate / coordinates / [x,y] / "x,y" / {x,y} / {x:..,y:..} —— 全部收成 [x, y]
  let c = a.coordinate
  if (!(Array.isArray(c) && c.length === 2)) {
    if (Array.isArray(a.coordinates) && a.coordinates.length === 2) c = a.coordinates
    else if (typeof c === 'string') {
      const n = c.split(/[\s,]+/).filter(Boolean).map(Number)
      c = n.length === 2 && n.every(Number.isFinite) ? n : undefined
    } else if (typeof a.x === 'number' && typeof a.y === 'number') c = [a.x, a.y]
    else if (a.point && typeof a.point.x === 'number' && typeof a.point.y === 'number') c = [a.point.x, a.point.y]
    else c = undefined
  }
  if (Array.isArray(c) && c.length === 2 && c.every((v) => Number.isFinite(v))) {
    out.coordinate = [Math.round(Number(c[0])), Math.round(Number(c[1]))]
  }
  // 文本 / 按键串
  let t = a.text ?? a.content
  if (typeof t !== 'string') t = undefined
  if (t === undefined) {
    for (const k of KEY_FIELDS) {
      if (typeof a[k] === 'string') {
        t = a[k]
        break
      }
    }
  }
  if (typeof t === 'string') out.text = t
  if (!VALID_ACTIONS.includes(String(out.action ?? ''))) {
    return { bad: `action 取了个不认识的值：${JSON.stringify(a.action ?? null)}` }
  }
  // 这三个动作没有 text 上游必然抛错，在这里就挡住并给出正确写法
  if ((out.action === 'key' || out.action === 'type' || out.action === 'scroll') && !out.text) {
    return { bad: `action="${out.action}" 缺少 text 参数` }
  }
  return { args: out }
}

/** 入参不对时的回执：给模型一份可直接照抄的正确形状，避免它继续猜字段名 */
const correctShape = (why) =>
  `【computer 调用参数不对】${why}。\n` +
  '本工具**只有三个字段**：action（必填）、coordinate（`[x, y]`，点击/滚动用）、text（要输入的文字或按键串）。\n' +
  '**没有 `key` / `keys` / `hotkey` 这类字段——按键串一律放 `text`**。正确示例：\n' +
  '- `{"action":"get_screenshot"}`\n' +
  '- `{"action":"key","text":"ctrl+f"}`  ← 按 Ctrl+F\n' +
  '- `{"action":"key","text":"return"}`\n' +
  '- `{"action":"type","text":"文件传输助手"}`  ← 输入文字\n' +
  '- `{"action":"left_click","coordinate":[640,360]}`\n' +
  '- `{"action":"scroll","coordinate":[640,360],"text":"down:500"}`\n' +
  '请严格按上面的形状改一次再调用，不要增删字段。'

// ---------- 本层自有工具的实现：剪贴板 ----------
/**
 * `set_clipboard` 起一个**一次性** PowerShell，干完就退。三个约束缺一不可：
 *  · **必须 STA**——`System.Windows.Forms.Clipboard` 在 MTA 线程上直接抛异常，所以带 `-STA`；
 *  · **脚本必须纯 ASCII**——PS 5.1 会把无 BOM 的脚本按系统 ANSI 解码，脚本里写中文必乱码。
 *    这里用 `-EncodedCommand`（UTF-16LE base64）把脚本送进去，业务数据（中文文本、中文路径）
 *    再经 `QN_CLIP_B64`（UTF-8 base64）送，整条链路上没有一处会被编码搞坏；
 *  · **SetImage / SetFileDropList 是「立即复制」语义**——数据已经交给系统剪贴板，
 *    PowerShell 退出后内容依然有效，所以不必为它常驻一个进程。
 */
const CLIP_PS = process.env.QN_SCREEN_POWERSHELL || 'powershell.exe'
const CLIP_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  "$j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:QN_CLIP_B64))|ConvertFrom-Json",
  'function Emit($o){[Console]::Out.WriteLine(($o|ConvertTo-Json -Compress))}',
  '$mode=[string]$j.mode',
  "if($mode -eq 'file'){",
  '  $c=New-Object System.Collections.Specialized.StringCollection',
  '  foreach($f in @($j.files)){ if($f -and (Test-Path -LiteralPath $f)){ [void]$c.Add((Resolve-Path -LiteralPath $f).Path) } }',
  "  if($c.Count -eq 0){Emit @{ok=$false;error='no_existing_file'};exit 0}",
  '  [System.Windows.Forms.Clipboard]::SetFileDropList($c)',
  "  Emit @{ok=$true;mode='file';count=$c.Count}",
  '  exit 0',
  '}',
  "if($mode -eq 'image'){",
  "  $f=[string]($j.files|Select-Object -First 1)",
  "  if(-not $f -or -not (Test-Path -LiteralPath $f)){Emit @{ok=$false;error='no_existing_file'};exit 0}",
  '  $p=(Resolve-Path -LiteralPath $f).Path',
  '  $img=[System.Drawing.Image]::FromFile($p)',
  '  [System.Windows.Forms.Clipboard]::SetImage($img)',
  "  Emit @{ok=$true;mode='image';width=$img.Width;height=$img.Height}",
  '  exit 0',
  '}',
  '$t=[string]$j.text',
  '[System.Windows.Forms.Clipboard]::SetText($t)',
  "Emit @{ok=$true;mode='text';length=$t.Length}"
].join('\n')
const CLIP_ENC = Buffer.from(CLIP_SCRIPT, 'utf16le').toString('base64')

/** 跑一次剪贴板写入，返回 PowerShell 回执解析出的对象 */
function runClipboard(payload) {
  return new Promise((resolve) => {
    let ps
    try {
      ps = spawn(CLIP_PS, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', CLIP_ENC], {
        env: { ...process.env, QN_CLIP_B64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') },
        windowsHide: true
      })
    } catch (e) {
      resolve({ ok: false, error: '启动 PowerShell 失败：' + (e?.message ?? e) })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        ps.kill()
      } catch {}
      resolve({ ok: false, error: '写剪贴板超时（15s）' })
    }, 15000)
    ps.stdout.on('data', (d) => (out += d.toString('utf8')))
    ps.stderr.on('data', (d) => (err += d.toString('utf8')))
    ps.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e?.message ?? String(e) })
    })
    ps.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      let j = null
      try {
        j = JSON.parse(line)
      } catch {
        /* 非 JSON：把原始输出带给模型 */
      }
      if (!j) {
        resolve({ ok: false, error: (err.trim() || out.trim() || '没有任何输出').slice(-300) })
        return
      }
      resolve(j)
    })
  })
}

/** files 里路径不对时的说明：直接点出「照抄回执里那条路径」，比泛泛报错有用 */
const clipWhy = (error) =>
  error === 'no_existing_file'
    ? '路径在磁盘上不存在。请照抄生图 / 生视频 / 转音频工具回执里「本地文件：」那一行的**绝对路径**，不要改写、不要自己拼路径。'
    : error

async function runSetClipboard(args) {
  const mode = String(args.mode ?? 'text').toLowerCase()
  if (mode === 'text') {
    const t = typeof args.text === 'string' ? args.text : ''
    if (!t) return errResult('mode="text" 需要 text 参数（要放进剪贴板的文字）。')
    const r = await runClipboard({ mode: 'text', text: t })
    if (!r.ok) return errResult(`写剪贴板失败：${clipWhy(r.error)}`)
    return textResult(
      `已把 ${r.length ?? t.length} 个字符放进剪贴板。现在用 \`{"action":"key","text":"ctrl+v"}\` 粘贴到目标窗口的输入框里。`
    )
  }
  if (mode !== 'image' && mode !== 'file') return errResult(`mode 只能是 text / image / file，收到的是 ${JSON.stringify(args.mode ?? null)}。`)
  const files = (Array.isArray(args.files) ? args.files : []).map((x) => String(x)).filter(Boolean)
  if (!files.length) return errResult(`mode="${mode}" 需要 files 参数（本地文件的绝对路径）。`)
  const r = await runClipboard({ mode, files })
  if (!r.ok) return errResult(`写剪贴板失败：${clipWhy(r.error)}`)
  if (mode === 'image')
    return textResult(
      `已把图片放进剪贴板（位图 ${r.width}x${r.height}）。现在切到聊天窗口，用 \`{"action":"key","text":"ctrl+v"}\` 粘贴，` +
        '再按一次 `{"action":"key","text":"return"}` 发送（微信里粘贴位图即作为图片消息）。'
    )
  return textResult(
    `已把 ${r.count} 个文件放进剪贴板（文件形式）。现在切到聊天窗口，用 \`{"action":"key","text":"ctrl+v"}\` 粘贴，` +
      '再按一次 `{"action":"key","text":"return"}` 发送（微信里粘贴文件即作为文件发送）。'
  )
}

// ---------- 键盘动作：本层用原生 SendInput 接管，不走上游 nut-js ----------
/**
 * 为什么必须接管。
 *
 * 上游 computer-use-mcp 的 `key` 是 `keyboard.pressKey(...toKeys(text))`（nut-js）。在 Windows 上
 * 组合键的修饰键经常不生效：`ctrl+v` 会变成往目标窗口里打一个**裸的 v**，`ctrl+f` 变成一个 f。
 * 用户实测的原话是「发了个 F，明显是黏贴有问题」——粘贴退化成了输入单个字符，而整条链路
 * 没有任何一步发现这件事。这里改用 win-input.ps1 的 SendInput（修饰键按住 → 主键 → 逆序释放，
 * 分两批提交，实测按键序列完全正确），并在发送前加一道**青鸟自身窗口守卫**。
 *
 * `type` 同理：逐字符模拟按键既打不了中文（会被输入法拦掉），在自绘界面里也常常丢字，
 * 所以改成「写剪贴板 + Ctrl+V」，与 set_clipboard 共用同一条可靠通路。
 */
function runWinInput(payload) {
  return new Promise((resolve) => {
    let ps
    try {
      ps = spawn(CLIP_PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_INPUT_PS], {
        env: { ...process.env, QN_INPUT_B64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') },
        windowsHide: true
      })
    } catch (e) {
      resolve({ ok: false, error: 'spawn_failed', message: e?.message ?? String(e) })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        ps.kill()
      } catch {}
      resolve({ ok: false, error: 'timeout' })
      // 冷启动实测约 4 秒（powershell 起 + Add-Type 现场编译 C#），首次执行还可能叠上杀软扫描。
      // 给 20 秒：宁可多等一会，也不要让「第一次发按键」变成一次莫名其妙的超时失败。
    }, 20000)
    ps.stdout.on('data', (d) => (out += d.toString('utf8')))
    ps.stderr.on('data', (d) => (err += d.toString('utf8')))
    ps.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: 'spawn_failed', message: e?.message ?? String(e) })
    })
    ps.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      let j = null
      try {
        j = JSON.parse(line)
      } catch {
        /* 非 JSON：把原始输出交给上层 */
      }
      if (!j) {
        resolve({ ok: false, error: 'bad_output', message: (err.trim() || out.trim() || '没有任何输出').slice(-300) })
        return
      }
      resolve(j)
    })
  })
}

/** 模型偶尔把组合键写成 `Ctrl-V` / `Ctrl + V`，统一成 `ctrl+v` 再交给 SendInput */
function normalizeKeyString(raw) {
  let t = String(raw ?? '').trim()
  if (!t) return ''
  t = t.replace(/\s*\+\s*/g, '+').replace(/\s+/g, '')
  t = t.replace(/(ctrl|control|alt|shift|win|meta)[-](?=[a-z0-9])/gi, '$1+')
  return t.toLowerCase()
}

/**
 * 键盘类拒绝的人话文案。
 *
 * self_window 是用户明确要求的一道闸：「控制电脑的时候，我们自己的聊天窗口不要输入」。
 * 落到模型侧必须是**明确改做法**，而不是「重试一次」。
 */
function keyRefusal(r) {
  const msg = String(r?.message ?? '')
  if (r?.error === 'self_window') {
    return errResult(
      '【已拒绝发送按键：当前最前面的窗口是青鸟自己】' +
        (r.title ? `（「${r.title}」/ ${r.proc}）` : '') +
        '\n按键会直接打进用户正在跟你对话的那个输入框，把用户正在写的内容搅乱。\n' +
        '请带目标窗口改用 `uia_keys`（它会先把目标窗口切到前台、确认成功后才发键）：' +
        '`uia_keys {"keys":"ctrl+v","match":"微信"}`；粘贴整段内容用 `uia_paste {"match":"微信"}`。'
    )
  }
  if (r?.error === 'focus_refused') {
    return errResult(
      `【已放弃发送按键：没能把「${r?.name || r?.proc || r?.hwnd}」切到最前面】` +
        '此时发键会打进当前前台那个窗口。请如实告诉用户请他手动点一下那个窗口，不要改用点坐标或截图硬试。'
    )
  }
  if (msg.startsWith('unknown_key:')) {
    return errResult(
      `不认识这个按键名：${msg.slice('unknown_key:'.length)}。` +
        '按键串请用 `ctrl+v` / `ctrl+f` / `shift+tab` / `return` / `esc` 这种写法（小写、用 + 连接）。'
    )
  }
  if (r?.error === 'exception' && /empty_keys/.test(msg)) return errResult('按键串是空的，请给出具体按键，如 `"ctrl+v"`。')
  if (r?.error === 'send_failed' || r?.error === 'exception') {
    return errResult(
      '按键没有送出去（`' + (msg || r.error) + '`）。最常见的原因是目标窗口属于**管理员权限**进程，' +
        '普通权限的输入会被系统挡下；请如实告诉用户这一步没能执行。'
    )
  }
  if (r?.error === 'timeout') {
    return errResult(
      '这一步没能在时限内完成（多半是输入层首次启动偏慢，或系统当时正忙）。\n' +
        '**直接再做一次同样的调用即可**——第二次通常是秒回。不要改用点坐标或截图硬试。'
    )
  }
  return errResult(`键盘操作失败：${msg || r?.error || '未知原因'}`)
}

async function runKeyboardAction(action, args) {
  if (action === 'type') {
    const text = String(args?.text ?? '')
    if (!text) return errResult('action="type" 需要 text 参数。')
    const w = await runClipboard({ mode: 'text', text })
    if (!w.ok) return errResult('写剪贴板失败：' + clipWhy(w.error))
    const r = await runWinInput({ mode: 'keys', keys: 'ctrl+v' })
    if (r.ok !== true) return keyRefusal(r)
    return textResult(
      '已把这段文字输入到当前焦点窗口（改用**写剪贴板 + Ctrl+V**：逐字符模拟按键打不了中文，还会被输入法拦掉）。\n' +
        '注意：系统剪贴板现在装的是这段文字——如果你之前往剪贴板放过文件/图片，那个内容已经被覆盖，要重发得重新 set_clipboard。'
    )
  }
  const keys = normalizeKeyString(args?.text)
  if (!keys) return errResult('action="key" 需要 text 参数（按键串，如 "ctrl+v"）。')
  const r = await runWinInput({ mode: 'keys', keys })
  if (r.ok !== true) return keyRefusal(r)
  return textResult(`已按 ${keys}（原生 SendInput，按键序列确定生效）。`)
}

// ---------- 预热输入层 ----------
// powershell 启动 + Add-Type 现场编译 C# 实测约 4 秒；若第一次真发按键正好赶上这段冷启动，
// 很容易在时限上被判成超时（实测就撞过一次：第一次 computer key 超时、第二次秒回）。
// 开机后在后台先跑一次只读的 foreground（零副作用），把这段耗时挪出关键路径。
void runWinInput({ mode: 'foreground' })

// ---------- 主循环：透传 initialize / tools，只改 get_screenshot 的返回 ----------
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = req
  // 通知类（无 id）：等上游握完手再透传，不需要回包
  if (id === undefined) {
    void upstreamReady.then(() => up.stdin.write(line + '\n'), () => {})
    return
  }
  // 握手两步由本层静态应答（见上方说明）：上游可能还在 npx 拉包，等它必然超时
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'computer-use-mcp', version: '1.0.0' }
      }
    })
    return
  }
  if (method === 'tools/list') {
    // 自有工具与上游 computer 并列交出；前缀（computer-use_）由内核注册时统一加
    send({ jsonrpc: '2.0', id, result: { tools: [...STATIC_TOOLS, ...LOCAL_TOOLS] } })
    return
  }
  // 自有工具（set_clipboard）：本层直接处理，不走上游那条链路
  const localName = String(params?.name ?? '').replace(/^computer-use_/, '')
  if (method === 'tools/call' && LOCAL_TOOLS.some((t) => t.name === localName)) {
    try {
      send({ jsonrpc: '2.0', id, result: await runSetClipboard(params?.arguments ?? {}) })
    } catch (e) {
      fail(id, '写剪贴板失败：' + (e?.message ?? e))
    }
    return
  }
  // computer 的入参先在本层归一化 + 校验：上游是 z.strict()，字段名差一个字就整次调用失败，
  // 而「失败→重写→再失败」正是用户看到的连环报错。写错时直接回一份可照抄的正确形状。
  let callParams = params
  const isComputerCall = method === 'tools/call' && String(params?.name ?? '') === 'computer'
  if (isComputerCall) {
    const n = normalizeComputerArgs(params?.arguments)
    if (n.bad) {
      fail(id, correctShape(n.bad))
      return
    }
    callParams = { ...params, arguments: n.args }
  }
  /**
   * 键盘动作（key / type）由本层接管，**不转发给上游 nut-js**（见 runKeyboardAction 的说明）。
   * 放在截图熔断与授权闸门之前：它既不截图、也不调用别的模型，没有任何需要审批的东西。
   */
  if (isComputerCall && (callParams?.arguments?.action === 'key' || callParams?.arguments?.action === 'type')) {
    try {
      send({ jsonrpc: '2.0', id, result: await runKeyboardAction(callParams.arguments.action, callParams.arguments) })
    } catch (e) {
      fail(id, '键盘操作失败：' + (e?.message ?? e))
    }
    return
  }
  /**
   * 截图熔断：先于授权闸门判断——既然这次调用注定要被拒，就别再弹卡片打扰用户。
   */
  if (isComputerCall && callParams?.arguments?.action === 'get_screenshot' && !shootAllowed()) {
    fail(
      id,
      `【截图已到上限：先做动作，别再空截了】你在 ${Math.round(SHOT_WINDOW_MS / 1000)} 秒内已经截了 ${SHOT_MAX} 次图。` +
        '现在请**直接发出一个动作**（点击 / 按键 / 输入 / 滚动）再说：两张截图之间必须夹一个真实动作，' +
        '连续空截既拿不到新信息，每张还要多调一次视觉模型。\n' +
        '要判断画面就用你手上已有的那段「【电脑画面】」文字描述，不要再截新的。\n' +
        '如果确实卡住了，请如实告诉用户卡在哪一步、需要他做什么，不要再用截图试探。'
    )
    return
  }
  /**
   * 授权闸门（会**调用另一个模型**的只有 get_screenshot 这一条路：截图要交给视觉模型代看）。
   *
   * 刻意放在 deadline 之前：用户看卡片、想清楚、点按钮的时间**不该算进那次调用的 25 秒预算**，
   * 否则「认真读一遍再决定」会直接把这次截图判成超时。已授权时这里立即返回，零感知。
   */
  if (isComputerCall && callParams?.arguments?.action === 'get_screenshot' && VISION_TARGETS.length) {
    const t = VISION_TARGETS[0]
    const who = { role: 'vision', id: t.id, label: t.label ?? t.model, provider: t.provider }
    const grant = await authorize(who)
    if (!grant.allowed) {
      fail(id, deniedText(who, grant))
      return
    }
  }
  try {
    // 一次调用的截止时间：等上游就绪、回包、识图，全在这 25 秒里分
    const deadline = Date.now() + CALL_BUDGET_MS
    const left = () => Math.max(3000, deadline - Date.now())
    await withDeadline(upstreamReady, left(), 'computer-use-mcp 迟迟没能就绪，本次调用已放弃')
    const result = await askUpstream(method, callParams, left())
    if (isComputerCall && callParams?.arguments?.action === 'get_screenshot') {
      send({ jsonrpc: '2.0', id, result: await describeScreen(result, deadline) })
      return
    }
    send({ jsonrpc: '2.0', id, result })
  } catch (e) {
    /**
     * 失败/超时都以 isError 回执交还（不再用 JSON-RPC error）：
     * 模型拿到的是「为什么没成」的人话，能自己决定重试、换招或如实告诉用户，
     * 而不是整个回合卡在一条永远等不到的回包上。
     */
    fail(id, `【电脑控制】${String(e?.message ?? e)}。\n可以重试一次；若反复超时，如实告诉用户「桌面控制这一步超时了，请确认青鸟有屏幕录制/辅助功能权限」。`)
  }
})
