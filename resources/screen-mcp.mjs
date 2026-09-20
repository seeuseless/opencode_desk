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

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

// ---------- 上游 computer-use-mcp 子进程：JSON-RPC 行协议透传 ----------
const up = spawn(UPSTREAM_CMD, UPSTREAM_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
up.stderr.on('data', (d) => process.stderr.write(d))
up.on('exit', (code) => process.exit(code ?? 0))

/** 待回包：上游请求 id → 本层处理器（改写的返回经它发回内核） */
const pending = new Map()
let nextId = 1

/** 向上游发一个请求，返回其 result（Promise） */
function askUpstream(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    up.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

up.stdout.on('data', (buf) => {
  for (const line of String(buf).split('\n')) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const wait = msg.id !== undefined ? pending.get(msg.id) : undefined
    if (!wait) continue
    pending.delete(msg.id)
    if (msg.error) wait.reject(new Error(msg.error.message ?? 'upstream error'))
    else wait.resolve(msg.result)
  }
})

// ---------- 识图：把截图转成文字，交给收不了图的对话模型 ----------
const SYSTEM_PROMPT =
  '你是电脑屏幕截图分析助手，正在协助 AI 操作桌面。只描述画面里**实际能看见**的内容，不要推测、不要编造。\n' +
  '按下面的格式回答（简洁，不要客套）：\n' +
  '1. 当前最前面的窗口是什么应用、什么标题；\n' +
  '2. 画面里主要有哪些区域与可点击的按钮/菜单/输入框，各自的大致位置；\n' +
  '3. 红色十字准星（鼠标）现在落在哪里、压着什么元素；\n' +
  '4. 有无弹窗、报错、加载中或需要用户处理的提示。\n' +
  '如果画面看不清，直接说明看不清，不要脑补。'

/** 问视觉模型：返回 { ok, answer, error }；ok=false 时可换下一个目标 */
async function askVision(t, pngBuffer) {
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
      signal: AbortSignal.timeout(120000)
    })
  } catch (e) {
    return { ok: false, error: `请求发不出去：${e?.message ?? e}` }
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
async function describeScreen(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const img = content.find((c) => c?.type === 'image' && c?.data)
  // 上游没回图（被截断/异常）：原样交出，至少让模型看到尺寸信息
  if (!img) return result
  if (!VISION_TARGETS.length) {
    return {
      content: [
        ...content,
        {
          type: 'text',
          text:
            '【电脑画面说明】上面是本次屏幕截图。若你看到的是图片，直接看即可；' +
            '若当前模型不支持图片输入、只看到尺寸信息，请让用户到 设置 → 模型 给带视觉能力的模型勾选「图片」输入，' +
            '保存并重开内核后重试——否则你无法看到屏幕，不要凭猜测点击。'
        }
      ]
    }
  }
  const png = Buffer.from(String(img.data), 'base64')
  const errs = []
  for (const t of VISION_TARGETS.slice(0, 4)) {
    const r = await askVision(t, png)
    if (r.ok)
      return {
        content: [...content, { type: 'text', text: `【电脑画面（由 ${t.id} 识别）】\n${r.answer}` }]
      }
    errs.push(`${t.id} → ${r.error}`)
  }
  return {
    content: [
      ...content,
      {
        type: 'text',
        text:
          '【电脑画面说明】如果你看不到上面的截图，那么本次识图也失败了：\n' +
          errs.join('\n') +
          '\n请在 设置 → 模型 里给真正带视觉能力的模型勾选「图片」输入后重试；在此之前不要凭猜测点击。'
      }
    ]
  }
}

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
  // 通知类（无 id）直接透传，不需要回包
  if (id === undefined) {
    up.stdin.write(line + '\n')
    return
  }
  try {
    const result = await askUpstream(method, params)
    if (method === 'tools/call' && String(params?.name ?? '') === 'computer' && params?.arguments?.action === 'get_screenshot') {
      send({ jsonrpc: '2.0', id, result: await describeScreen(result) })
      return
    }
    send({ jsonrpc: '2.0', id, result })
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } })
  }
})
