#!/usr/bin/env node
// 桌面辅助 MCP：给桌面控制（computer 工具）提供确定性的系统查询，弥补它只有键鼠+截图的短板。
// app_running 用系统进程表判断应用是否已运行——比让模型看图认任务栏图标可靠得多，
// 专治「微信明明开着，AI 又启动了一个新实例」。
import { createInterface } from 'node:readline'
import { execSync } from 'node:child_process'

const TOOLS = [
  {
    name: 'app_running',
    description:
      '查询某些应用是否已在运行（读系统进程表，结果确定，不要靠截屏猜）。' +
      'keywords 传进程名关键词（英文/拼音，小写即可），一个应用可给多个候选，如 微信=["wechat","weixin"]、QQ=["qqnt","tencent qq"]、Chrome=["chrome"]。' +
      '已在运行 → 绝对不要再通过 Win+R / 双击图标启动新实例：先 uia_windows 找到它的窗口，用 uia_window_focus 把它提到前台；' +
      '若该窗口无障碍树为空（自绘 UI，uia_tree 会明确告知），再改用桌面控制的纯键盘动作（不要截图确认）；' +
      '未在运行 → 正常走启动流程。',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '进程名关键词候选（不区分大小写），命中任意一个即视为在运行'
        }
      },
      required: ['keywords']
    }
  }
]

/** 取全量进程名+PID：win 用 tasklist CSV，其余走 ps */
function listProcesses() {
  if (process.platform === 'win32') {
    const out = execSync('tasklist /fo csv /nh', { encoding: 'utf8', windowsHide: true })
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^"([^"]+)","(\d+)"/)
        return m ? { name: m[1], pid: m[2] } : null
      })
      .filter(Boolean)
  }
  const out = execSync('ps -axo pid=,comm=', { encoding: 'utf8' })
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.+)$/)
      return m ? { name: m[2].split('/').pop(), pid: m[1] } : null
    })
    .filter(Boolean)
}

function appRunning(keywords) {
  const keys = keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
  if (!keys.length) return 'keywords 为空：请传进程名关键词，如 ["wechat","weixin"]'
  const procs = listProcesses()
  const hits = procs.filter((p) => keys.some((k) => p.name.toLowerCase().includes(k)))
  if (!hits.length) return `未在运行：没有找到匹配 ${keys.join(' / ')} 的进程，可以走启动流程。`
  const uniq = [...new Map(hits.map((p) => [p.name.toLowerCase(), p])).values()]
  return (
    '已在运行（不要再启动新实例！用 uia_windows 找到它的窗口，再 uia_window_focus 提到前台；' +
    '若 uia_tree 告知该窗口无障碍树为空，则改走纯键盘流程（uia_window_focus → ctrl+f / ctrl+v / return，不需要截图）：\n' +
    uniq.map((p) => `- ${p.name} (PID ${p.pid})`).join('\n')
  )
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
        serverInfo: { name: 'desktop-helper', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    try {
      if (name !== 'app_running') throw new Error('未知工具：' + name)
      const kw = req.params?.arguments?.keywords
      send({ jsonrpc: '2.0', id, result: text(appRunning(Array.isArray(kw) ? kw : [])) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: text('查询失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
