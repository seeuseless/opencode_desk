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
import { authorize, deniedText, markUsed } from './gate.mjs'

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
 * 为什么要有（用户明确反馈过两次）：上游 computer-use-mcp 的工具描述里写着
 * 「you may need to wait and take successive screenshots」「consult a screenshot to determine
 * the coordinates」，模型照做就成了「点一下 → 截一张 → 再点一下 → 再截一张」——
 * 每一张截图都要额外调一次视觉模型（10s 级、消耗额度），在用户眼里就是**反复截屏死循环**。
 * 提示词层面已经反复写「截屏是最后兜底」，但模型并不总听；这里落成硬约束，
 * 让它想转也转不动，只能改用 uia_* / 键盘，或者如实把卡点告诉用户。
 *
 * 阈值可用环境变量调（QN_SCREEN_SHOT_MAX / QN_SCREEN_SHOT_WINDOW_MS）。
 */
const SHOT_MAX = Number(process.env.QN_SCREEN_SHOT_MAX) > 0 ? Number(process.env.QN_SCREEN_SHOT_MAX) : 3
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
const fail = (id, text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })

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

/** 上游 tools/list 的真实返回（1.8.0 实测抄录）：握手阶段直接交出，不等上游 */
const STATIC_TOOLS = [
  {
    name: 'computer',
    title: 'Computer Control',
    description:
      // ---- 青鸟前置约束（必须放在上游英文之前：模型对描述里靠前的硬规则更买账，
      //      而上游原文明确鼓励「多截几张看结果 / 看截图定坐标」，那正是截屏死循环的源头）----
      '【青鸟桌面控制 · 最高优先级，与下面通用说明冲突时以本段为准】\n' +
      '操作本机桌面应用，**先看能不能走无障碍树**：`uia_windows` 找窗口 → `uia_tree` 读元素 → ' +
      '`uia_click` / `uia_set_text` / `uia_focus` 操作。能用的应用（资源管理器、记事本、Office 等）' +
      '一律走这一档：纯文本、几十毫秒、不需要看画面，也**不需要也不许**截图。\n' +
      '自绘界面（微信 4.0 等把 UI 画在画布上的应用）`uia_tree` 会回「没有任何可操作元素」——**看到空树就立刻转纯键盘流程**：' +
      '`uia_window_focus "<窗口名>"` 提到前台（回执里的「前台窗口」不是目标时，**不要盲发按键**，' +
      '先 `{"action":"left_click","coordinate":[x,y]}` 点一下目标窗口把它点成前台），' +
      '再发快捷键：`{"action":"key","text":"ctrl+f"}` / `{"action":"key","text":"ctrl+v"}` / `{"action":"key","text":"return"}`。' +
      '**中文一律用剪贴板 + `ctrl+v`，不要直接 `type`**（会被输入法拦掉）。这一整条链路是确定性的，**一条截图都不用**。\n' +
      '**`get_screenshot` 是最后的兜底：同一轮最多用一次，而且只能用来做开局判断（先决定点哪儿）**。' +
      '**严禁用截图去确认某一步成没成**——下面英文里「take successive screenshots to see the results of your actions」' +
      '与「consult a screenshot to determine the coordinates of the element」这两条**在青鸟里一律不适用**：' +
      '每次截图都要额外调用一次视觉模型，又慢又费额度，还会把任务钉在原地反复截图。' +
      '截图次数超限会被直接熔断。\n\n' +
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
    send({ jsonrpc: '2.0', id, result: { tools: STATIC_TOOLS } })
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
   * 截图熔断：先于授权闸门判断——既然这次调用注定要被拒，就别再弹卡片打扰用户。
   */
  if (isComputerCall && callParams?.arguments?.action === 'get_screenshot' && !shootAllowed()) {
    fail(
      id,
      `【截图已被熔断：这一轮别再截了】你在 ${Math.round(SHOT_WINDOW_MS / 1000)} 秒内已经截了 ${SHOT_MAX} 次图。` +
        '反复截图不会让画面变清楚，每一步都截一张只会把任务钉在原地——每张截图都要额外调一次视觉模型，又慢又费额度。\n' +
        '请改用：① `uia_windows` / `uia_tree` 读无障碍树（原生控件应用，纯文本、几十毫秒）；' +
        '② 自绘界面（如微信）走纯键盘流程：`uia_window_focus "<窗口名>"` → ' +
        '`{"action":"key","text":"ctrl+f"}` / `{"action":"key","text":"ctrl+v"}` / `{"action":"key","text":"return"}`；' +
        '③ 真的要判断画面，就用你手上已有的那段「【电脑画面】」文字描述，不要再截新的。\n' +
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
