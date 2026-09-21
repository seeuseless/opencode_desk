#!/usr/bin/env node
// 面板浏览器 MCP：把右侧面板里的 webview 暴露给 AI 操控。
// AI 与用户看到的是同一个浏览器（共享登录态）；元素用 snapshot 里的 ref 编号定位，不需要图片输入。
// 主进程侧的 HTTP 控制端点端口由 argv 传入。
import { createInterface } from 'node:readline'

const base = 'http://127.0.0.1:' + (process.argv[2] || '39521')

// 工具名**不要带 panel_ 前缀**：内核注册 MCP 工具时会自动拼上服务名（配置里的 key 就叫 panel），
// 写成 panel_snapshot 会被注册成 panel_panel_snapshot，跟提示词里说的 panel_snapshot 对不上，
// 模型按文档调用就报「工具不存在」。这里只写后半截。
const TOOLS = [
  {
    name: 'navigate',
    description: '在应用内右侧的面板浏览器中打开网址。打开网页/链接/上网一律默认用本工具：面板与用户看的是同一个浏览器（共享登录态），打开后先 panel_snapshot 获取页面元素再操作。**不要为「看看有没有打开」去 computer-use_computer 截屏**——面板的页面状态用 panel_snapshot 读文本就够了，截屏又慢又要求模型支持图片输入。只有用户明确点名要在桌面上、外部真实浏览器里打开时，才改用 computer-use_computer。\n**要进站点的某个页面时，优先从 panel_snapshot 的清单里找链接点进去**：清单里 a 标签后面 `→ /path` 就是站点自己给出的真实地址，点它的 ref 即可，比猜地址可靠得多。**只有你确知完整地址时才直接用本工具**——不要靠拼 /invite、/my/xxx 这类路径去试探站点有没有那个页面（回执里的 ok:false /「导航未生效」就是这条路走不通的信号）。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '完整网址，http(s):// 开头' } }, required: ['url'] }
  },
  {
    name: 'snapshot',
    description: '读面板浏览器当前页面：返回可交互元素清单（[ref] 角色「文本」值 → 链接地址）与页面标题，用 ref 定位点击与输入。这就是「看面板页面」的唯一方式，不需要截屏。页面导航后需重新 snapshot。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'click',
    description: '点击面板浏览器页面中的元素（ref 来自 panel_snapshot）。',
    inputSchema: { type: 'object', properties: { ref: { type: 'number', description: 'panel_snapshot 返回的元素编号' } }, required: ['ref'] }
  },
  {
    name: 'type',
    description: '向面板浏览器页面的输入框填入文本（ref 来自 panel_snapshot）；submit 为 true 时回车提交。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean', description: '填完回车提交' } },
      required: ['ref', 'text']
    }
  }
]

async function call(action, body) {
  const r = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  return await r.json()
}

const okText = (t) => ({ content: [{ type: 'text', text: t }] })
// 失败必须带 isError：只回一段「操作失败：…」的普通文本，模型未必当成失败，
// 会原样重试或换个地址再试——用户看到的就是「一直在找」。
const errText = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

// ---------- 导航熔断：拦住「猜地址」式的穷举 ----------
// 真实案例：一条「打开我的邀请」的任务里，模型连猜 /account/referral、/my/invite、
// /account/friend、/account/promotion… 十几个地址（53 次工具调用），因为它看不到
// 「这个地址根本不存在」的反馈。这里在协议层做机械拦截，不指望模型自觉。
const NAV_WINDOW_MS = 90000
const navLog = [] // { url, landed, effective, t }

const pruneNav = (now) => {
  while (navLog.length && now - navLog[0].t > NAV_WINDOW_MS) navLog.shift()
}

const NAV_WAY_OUT =
  '改做法（按顺序试）：\n' +
  '① `panel_snapshot` 看当前页面里**真实存在的链接**——清单里 a 标签后 `→ /path` 就是站点给出的地址，点它的 ref 进去，比猜地址可靠；\n' +
  '② 页面上确实没有你要的入口 → **停下来直接告诉用户「没找到 XX 入口」**，并说明你试过哪些地址；\n' +
  '③ 让用户给出准确链接。**不要继续换地址试探。**'

/** 返回拒绝文案；空字符串表示放行 */
function navGuard(url) {
  const now = Date.now()
  pruneNav(now)
  const same = navLog.filter((x) => x.url === url)
  if (same.length) {
    const last = same[same.length - 1]
    // 上次就成功打开了这个地址 → 不必重复开；上次没生效 → 再开一次也不会生效。
    // 两种都拦，但把话说明白，避免模型以为是「网络偶发失败」而重试。
    return (
      (last.effective
        ? `⛔ 无需重复打开：1 分半内你已经成功打开过「${url}」（当前页面就是它）。要刷新/重看请用 panel_snapshot 读当前页面。\n`
        : `⛔ 已熔断：1 分半内你已经试过同一个地址「${url}」，上次**没有生效**（页面停在「${last.landed || '原地址'}」），再试一次结果一样。\n`) +
      NAV_WAY_OUT
    )
  }
  // 连续两次「导航未生效」= 在瞎试地址
  const recent = navLog.slice(-2)
  if (recent.length === 2 && recent.every((x) => x.effective === false)) {
    return (
      '⛔ 已熔断：你连续两次导航都没有生效（页面停在原地址），说明这些地址站点里并不存在。\n' +
      '已试过：' +
      navLog.map((x) => x.url).join('、') +
      '\n' +
      NAV_WAY_OUT
    )
  }
  if (navLog.length >= 8) {
    return (
      `⛔ 已熔断：1 分半内你已经导航了 ${navLog.length} 次，这是在穷举猜地址。\n` +
      '已试过：' +
      navLog.map((x) => x.url).join('、') +
      '\n' +
      NAV_WAY_OUT
    )
  }
  return ''
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method } = req
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'panel-browser', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    // 内核转发过来的是「声明名」（navigate），但也容忍带前缀的写法（panel_navigate）
    const action = name.replace(/^panel_/, '')
    const args = req.params?.arguments ?? {}
    try {
      // 导航熔断：注定要被拒的调用先拦下来，不再打到主进程去（省一次往返，也避免页面被反复 load）
      if (action === 'navigate') {
        const refusal = navGuard(String(args.url ?? '').trim())
        if (refusal) {
          send({ jsonrpc: '2.0', id, result: errText(refusal) })
          return
        }
      }
      const r = await call(action, args)
      if (r.error) {
        send({ jsonrpc: '2.0', id, result: errText('操作失败：' + r.error) })
        return
      }
      if (action === 'navigate') {
        const url = String(args.url ?? '').trim()
        const effective = r.ok !== false
        navLog.push({ url, landed: r.url, effective, t: Date.now() })
        if (effective) {
          const lines = ['导航成功：URL: ' + r.url]
          if (r.title) lines.push('标题: ' + r.title)
          if (r.timedOut) lines.push('（注意：20 秒仍未加载完，页面可能还在渲染，snapshot 前可稍等）')
          if (r.elements === 0) {
            // 未知路径常被站点兜成一个空壳错误页：地址变了、加载成功，但页面上没有内容。
            // 不提示的话模型会以为「打开了、只是没渲染」，继续换地址。
            lines.push(
              '⚠️ 但这个页面上**没有任何可交互元素**，看起来是错误页/空页——你要的地址很可能不存在。' +
                '**别换近似地址再试**：直接告诉用户没找到，或回到有内容的页面从链接进去。'
            )
          } else if (typeof r.elements === 'number') {
            lines.push(`（页面上有 ${r.elements} 个可交互元素）`)
          }
          lines.push('接着用 panel_snapshot 读页面元素；要进别的页面优先点清单里的链接。')
          send({ jsonrpc: '2.0', id, result: okText(lines.join('\n')) })
        } else {
          const lines = [
            `⛔ 这次导航**没有生效**：你请求「${url}」，但页面仍停在「${r.url}」` +
              (r.title ? `（标题：${r.title}）` : '') +
              '。',
            r.error ? '原因：' + r.error : '',
            '',
            '**不要换一个近似地址接着试**（拼 /invite、/my/xxx 这类试探不会有用）。',
            NAV_WAY_OUT
          ]
          send({ jsonrpc: '2.0', id, result: errText(lines.join('\n')) })
        }
        return
      }
      const parts = []
      if (r.url) parts.push('URL: ' + r.url)
      if (r.title) parts.push('标题: ' + r.title)
      if (r.snapshot) parts.push(r.snapshot)
      if (!parts.length) parts.push('完成')
      send({ jsonrpc: '2.0', id, result: okText(parts.join('\n')) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: errText('操作失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
