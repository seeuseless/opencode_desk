#!/usr/bin/env node
// 全局记忆 MCP：让 AI 在对话里读写「设置 → 记忆」那段全局记忆。
// 主进程侧的 HTTP 控制端点端口由 argv 传入（与内置浏览器共用那台只监听 127.0.0.1 的服务）。
//
// 工具只有两个：memory_read（读全文）、memory_append（追加一条）。
// **没有覆盖/删除口**：全局记忆会进用户之后所有项目、所有会话（含手机端）的指令，
// 让模型整段重写一次就可能长期污染；删改保留在设置界面由人来做。
import { createInterface } from 'node:readline'

const base = 'http://127.0.0.1:' + (process.argv[2] || '39521')

const TOOLS = [
  {
    name: 'read',
    description:
      '读取当前的全局记忆全文（用户在「设置 → 记忆」里维护、对所有项目和会话生效的那段内容）。' +
      '用户问「我的全局记忆里有什么」「你记住了哪些」时先用它，不要凭印象回答。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'append',
    description:
      '往全局记忆里**追加一条**长期规则。只在用户明确表达「记住…」「以后都…」「写进全局记忆」时用。' +
      '一次一条，写成规则本身（如「包管理统一用 pnpm，不要用 npm」），不要写成「用户希望…」的转述，' +
      '不要塞进当前项目的临时上下文。删除或改写已有条目请让用户去「设置 → 记忆」做，本工具做不到。',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'string', description: '要追加的一条记忆，单条、自包含、别人读得懂；不要带「- 」前缀或多行' }
      },
      required: ['line']
    }
  }
]

const okText = (t) => ({ content: [{ type: 'text', text: t }] })
// 失败必须带 isError：只回一段「操作失败：…」的普通文本，模型未必当成失败，会反复重试。
const errText = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function call(action, body) {
  const r = await fetch(`${base}/memory/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  return await r.json()
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
        serverInfo: { name: 'qingniao-memory', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    // 内核转发的是声明名（read/append），也容忍带前缀的写法（memory_read）
    const action = name.replace(/^memory_/, '')
    const args = req.params?.arguments ?? {}
    try {
      const r = await call(action, args)
      if (r.error) {
        send({ jsonrpc: '2.0', id, result: errText('操作失败：' + r.error) })
        return
      }
      if (action === 'read') {
        const text = String(r.memory ?? '').trim()
        send({
          jsonrpc: '2.0',
          id,
          result: okText(text ? '当前全局记忆：\n' + text : '当前没有全局记忆（「设置 → 记忆」是空的）')
        })
        return
      }
      if (action === 'append') {
        if (!r.added) {
          send({
            jsonrpc: '2.0',
            id,
            result: errText('没有新增：这条记忆已经在全局记忆里了（内容重复的条目不会记第二遍）。')
          })
          return
        }
        send({
          jsonrpc: '2.0',
          id,
          result: okText(
            '已追加一条全局记忆。当前全文：\n' + String(r.memory ?? '').trim() + '\n\n' +
              '生效说明：这段内容下一次内核重启后会带进所有会话的常驻指令' +
              '（包括手机端发起的对话）；本次对话里你已经知道它，无需重启。' +
              '要删除或改写其中某条，请让用户到「设置 → 记忆」里改。'
          )
        })
        return
      }
      send({ jsonrpc: '2.0', id, result: errText('未知工具：' + name) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: errText('操作失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
