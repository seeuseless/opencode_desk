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
    description: '在应用内右侧的面板浏览器中打开网址。打开网页/链接/上网一律默认用本工具：面板与用户看的是同一个浏览器（共享登录态），打开后先 panel_snapshot 获取页面元素再操作。**不要为「看看有没有打开」去 computer-use_computer 截屏**——面板的页面状态用 panel_snapshot 读文本就够了，截屏又慢又要求模型支持图片输入。只有用户明确点名要在桌面上、外部真实浏览器里打开时，才改用 computer-use_computer。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '完整网址，http(s):// 开头' } }, required: ['url'] }
  },
  {
    name: 'snapshot',
    description: '读面板浏览器当前页面：返回可交互元素清单（[ref] 角色「文本」值）与页面标题，用 ref 定位点击与输入。这就是「看面板页面」的唯一方式，不需要截屏。页面导航后需重新 snapshot。',
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

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

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
    try {
      const r = await call(action, req.params?.arguments ?? {})
      if (r.error) {
        send({ jsonrpc: '2.0', id, result: text('操作失败：' + r.error) })
      } else {
        const parts = []
        if (r.url) parts.push('URL: ' + r.url)
        if (r.title) parts.push('标题: ' + r.title)
        if (r.snapshot) parts.push(r.snapshot)
        if (!parts.length) parts.push('完成')
        send({ jsonrpc: '2.0', id, result: text(parts.join('\n')) })
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: text('操作失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
