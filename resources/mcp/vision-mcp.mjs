#!/usr/bin/env node
// 图片理解 MCP：对话模型自己看不了图时，把「看图」外包给视觉模型。
//
// 为什么需要它：内核按模型真实能力分发附件——对话模型不支持 image 输入时，用户上传的图
// 不会进上下文，只剩一行 [Attached image/png: 路径] 占位文本，模型于是回答「我看不了图片」。
// 本工具用那个路径读本地图片（MCP 与用户同机，零成本）转 data URL，走 OpenAI 兼容
// /chat/completions 的多模态 content 数组问视觉模型，把文字答案交还给对话模型。
//
// 目标清单（baseURL / apiKey / model）由主进程经 QN_VISION_TARGETS 注入。
// 多个目标会依次重试：挑错模型的概率不低，第一个报「不支持图片」时自动换下一个。
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const parse = (v) => {
  try {
    return JSON.parse(v || '[]')
  } catch {
    return []
  }
}
const VISION_TARGETS = parse(process.env.QN_VISION_TARGETS)
const MEDIA_DIR = process.env.QN_MEDIA_DIR || join(homedir(), '.qingniaoai', 'media')
/** 单张图转 base64 后的体积上限（≈5MB）：再大上游基本拒收，先提示而不是干等超时 */
const MAX_BYTES = 5 * 1024 * 1024

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const TOOLS = [
  {
    name: 'describe_image',
    description:
      '看懂图片内容（视觉问答）：识别画面里的物体、人物、场景，读取图中的文字，或回答关于这张图的问题。\n' +
      '**只在你看不到图片画面时才调用**——典型信号是用户消息里图片只以 `[Attached image/png: 路径]` 这类占位文本出现，' +
      '或者你被告知当前模型不支持读图。这时不要回答「我看不了图片 / 请描述一下这张图」，' +
      '直接调用本工具并把占位里的路径原样填进 images。如果你已经能直接看到图片，就不要调用，直接作答。\n' +
      '典型场景：用户发图后问「这是什么」「图里几个人」「这单据上的金额是多少」「按这张图写文案」；' +
      '或需要先看清原图再决定怎么改（改图本身仍用 generate_image，本工具只负责看懂）。\n' +
      'images 支持本地绝对路径、URL、data URL，可一次传多张做对比。拿到结果后据此回答用户。',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '想从图里知道什么（越具体越好，如「列出图中的文字」「这个报错信息说了什么」）'
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            '图片列表（至少一张）。本地绝对路径 / URL / data URL 均可；' +
            '用户消息里 `[Attached image/png: 路径]` 直接把路径原样填进来，不要改写成文件名'
        },
        model: { type: 'string', description: '可选：指定识图模型（见报错里的可用清单），不传用默认第一个' }
      },
      required: ['question', 'images']
    }
  }
]

/** 选目标：model 参数匹配 id 或展示名（包含即可）；传了就必须命中，否则报错 */
function pickTargets(model) {
  if (!model) return VISION_TARGETS
  const q = String(model).toLowerCase()
  const hit = VISION_TARGETS.filter((t) => ((t.id ?? '') + ' ' + (t.label ?? '')).toLowerCase().includes(q))
  return hit.length ? hit : VISION_TARGETS
}

const REF_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

/** 图片归一化：http(s)/data 直传；本地绝对路径或裸文件名（媒体目录兜底）读文件转 data URL */
function normalizeImageRef(v) {
  const s = String(v ?? '').trim()
  if (!s) return { url: '' }
  if (/^(https?|data):/i.test(s)) return { url: s }
  let p = s
  if (/^file:\/\//i.test(p)) p = fileURLToPath(p)
  if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('/')) p = join(MEDIA_DIR, p)
  if (!existsSync(p)) return { url: '', error: `文件不存在：${p}` }
  // 扩展名要算上数字：.mp3/.mp4 这类用 [a-z]+ 匹配不上（media-mcp 踩过），图片虽都是纯字母也一并对齐
  const mime = REF_MIME[p.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '']
  if (!mime) return { url: '', error: `不支持的图片格式：${p}` }
  const size = statSync(p).size
  if (size > MAX_BYTES)
    return { url: '', error: `图片过大（${(size / 1024 / 1024).toFixed(1)}MB，上限 5MB）：${p}` }
  try {
    return { url: `data:${mime};base64,${readFileSync(p).toString('base64')}` }
  } catch (e) {
    return { url: '', error: `读图失败：${e?.message ?? e}` }
  }
}

/** 问一个目标：返回 { ok, answer, error }；ok=false 且 retryable=true 时可换下一个目标再试 */
async function askOnce(t, question, urls) {
  const body = {
    model: t.model,
    temperature: 0.2,
    messages: [
      {
        // 实测：不加这条，部分视觉模型会「看图说话」编得头头是道（把应用图标说成一整个软件界面）。
        // 明确要求只讲看得见的、看不清就说看不清，能压掉大部分幻觉。
        role: 'system',
        content:
          '你是精确的图片分析助手。只描述图中**实际能看见**的内容，不推测、不联想、不补充背景知识，' +
          '也不要把图标/截图脑补成某个软件的界面。信息不足或看不清时，直接说明看不清。回答用中文，简明扼要。'
      },
      {
        role: 'user',
        content: [
          ...urls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
          // 「假视觉」模型不报错、直接拿文字编一段像模像样的描述——这是最坑的情况
          // （实测把应用图标说成整个软件界面）。用 NO_IMAGE 协议把它揪出来，换下一个目标。
          { type: 'text', text: question + '\n\n（若你根本看不到图片画面，只回复 NO_IMAGE 这七个字母，不要编造内容。）' }
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
    return { ok: false, retryable: true, error: `请求发不出去：${e?.message ?? e}` }
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
    // 4xx 基本是「这个模型不吃图片」，换下一个目标才有意义；5xx 同理多半是上游抽风
    return { ok: false, retryable: true, error: `HTTP ${res.status}：${msg}` }
  }
  const answer = String(j?.choices?.[0]?.message?.content ?? j?.content?.[0]?.text ?? '')
  if (!answer) return { ok: false, retryable: true, error: '识图返回为空。原始返回：' + raw.slice(0, 300) }
  // 看不到图就直说 NO_IMAGE：判定该模型不是真视觉，换下一个目标（返回内容不外泄）
  if (/^\s*NO_IMAGE\s*$/i.test(answer) || answer.trim().toUpperCase().startsWith('NO_IMAGE'))
    return { ok: false, retryable: true, error: '该模型看不到图片画面（返回 NO_IMAGE），不是可用的识图模型' }
  return { ok: true, answer }
}

async function describeImage(args) {
  if (!VISION_TARGETS.length)
    return '未配置任何识图模型。请在 设置 → 模型 给某个提供商勾选「图片」输入（或启用带视觉模型的内置模型），保存并重启内核后重试。'
  const question = String(args.question ?? '').trim()
  if (!question) return 'question 不能为空：请写明你想从图里知道什么'
  const list = Array.isArray(args.images) ? args.images : [args.images]
  if (!list.filter(Boolean).length) return 'images 不能为空：至少传一张图片路径'

  const urls = []
  for (const item of list) {
    const r = normalizeImageRef(item)
    if (!r.url) return '图片处理失败：' + (r.error ?? String(item)) + '。请检查路径是否为用户消息里 [Attached image/png: 路径] 给出的原样路径。'
    urls.push(r.url)
  }

  const targets = pickTargets(args.model)
  if (args.model && !targets.some((t) => ((t.id ?? '') + ' ' + (t.label ?? '')).toLowerCase().includes(String(args.model).toLowerCase())))
    return '找不到识图模型「' + args.model + '」。可用：' + VISION_TARGETS.map((x) => x.id).join('、')

  // 依次重试：挑错模型（名字像视觉、实际不支持）时第一个会报 4xx，换下一个往往就成了
  const errs = []
  for (const t of targets.slice(0, 4)) {
    const r = await askOnce(t, question, urls)
    if (r.ok) return `识图成功（模型 ${t.id}）：\n${r.answer}`
    errs.push(`${t.id} → ${r.error}`)
  }
  return (
    '识图失败，已试 ' + errs.length + ' 个模型：\n' + errs.join('\n') +
    '\n这些模型可能都不支持图片输入。请在 设置 → 模型 里给真正带视觉能力的模型勾选「图片」输入，保存并重启内核。'
  )
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
        serverInfo: { name: 'qingniao-vision', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    const args = req.params?.arguments ?? {}
    try {
      const fn = { describe_image: describeImage }[name]
      if (!fn) throw new Error('未知工具：' + name)
      send({ jsonrpc: '2.0', id, result: text(await fn(args)) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: text('调用失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
