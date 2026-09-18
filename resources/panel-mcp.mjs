#!/usr/bin/env node
// 面板浏览器 MCP：把右侧面板里的 webview 暴露给 AI 操控。
// AI 与用户看到的是同一个浏览器（共享登录态）；元素用 snapshot 里的 ref 编号定位，不需要图片输入。
// 主进程侧的 HTTP 控制端点端口由 argv 传入。
import { createInterface } from 'node:readline'

const base = 'http://127.0.0.1:' + (process.argv[2] || '39521')

const TOOLS = [
  {
    name: 'panel_navigate',
    description: '在应用内右侧的面板浏览器中打开网址。注意：这只控制青鸟窗口内的面板浏览器，不是用户桌面上的浏览器——用户要打开或操作桌面上的浏览器/软件时，改用 computer 工具。面板与用户看的是同一个浏览器（共享登录态），打开后先 panel_snapshot 获取页面元素再操作。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '完整网址，http(s):// 开头' } }, required: ['url'] }
  },
  {
    name: 'panel_snapshot',
    description: '获取面板浏览器当前页面的可交互元素清单（[ref] 角色「文本」值），用 ref 定位点击与输入。页面导航后需重新 snapshot。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'panel_click',
    description: '点击面板浏览器页面中的元素（ref 来自 panel_snapshot）。',
    inputSchema: { type: 'object', properties: { ref: { type: 'number', description: 'panel_snapshot 返回的元素编号' } }, required: ['ref'] }
  },
  {
    name: 'panel_type',
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
    const action = name.replace('panel_', '')
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
