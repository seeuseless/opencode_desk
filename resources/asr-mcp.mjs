#!/usr/bin/env node
// 语音识别 MCP：ASR 模型吃音频吐文字，当对话模型用必被拒。
// 这里把「音频 → 文字」的接口包成工具，任何对话模型都能替用户听写录音、会议、视频音轨。
// 目标清单（baseURL / apiKey / model）由主进程经 QN_ASR_TARGETS 注入，形态与 media / tts MCP 一致。
//
// 接口长这样（以阶跃 stepaudio-3-asr-max 为准）：
//   POST {baseURL}/audio/asr/sse
//   请求头 Content-Type: application/json、Accept: text/event-stream
//   请求体 { audio: { data: <base64>, input: { transcription: {...}, format: {...} } } }
//   响应是 SSE：transcript.text.delta（增量）/ transcript.text.done（完整文本）/ error
// 之所以走 SSE 而不是等一个 JSON：这是官方推荐（也是唯一）的服务端转写形态，
// 一次性提交整段音频、服务端边识别边推，我们读到 done 就把完整文本交出去。
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const parse = (v) => {
  try {
    return JSON.parse(v || '[]')
  } catch {
    return []
  }
}
const ASR_TARGETS = parse(process.env.QN_ASR_TARGETS)

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const text = (t) => ({ content: [{ type: 'text', text: t }] })

/** 接口认的容器格式；pcm 需要额外带 codec/rate/bits/channel */
const FORMATS = ['ogg', 'mp3', 'wav', 'pcm', 'm4a']
/** 扩展名 → 接口格式名（容器名与扩展名大部分一致，个别要归一） */
const EXT_TO_FMT = {
  '.mp3': 'mp3',
  '.mp2': 'mp3',
  '.wav': 'wav',
  '.wave': 'wav',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'ogg',
  '.m4a': 'm4a',
  '.mp4': 'm4a',
  '.aac': 'm4a',
  '.flac': 'flac',
  '.pcm': 'pcm',
  '.raw': 'pcm',
  '.l16': 'pcm'
}

const TOOLS = [
  {
    name: 'transcribe_audio',
    description:
      '把音频/视频里的语音转成文字（听写、会议纪要、字幕、录音转文本）。' +
      '用户要求「把这段录音转成文字 / 听写 / 转录 / 生成字幕 / 这个音频说了什么 / 会议记要」时都必须调用本工具——' +
      '不要回答「我听不了音频」，也不要用对话模型硬猜内容。' +
      'audio 填音频的本地路径或 URL；**用户消息里形如 [Attached audio/mpeg: 路径] 的附件直接把该路径原样填进来**，' +
      '不要改写成文件名、也不要只转述用户说了什么。视频文件（.mp4/.mov）也支持，会自动按容器音轨识别。' +
      'language 留空即自动识别；hotwords 放人名、地名、专有名词、术语等易错词，能明显提升准确率。' +
      '结果里是识别出的完整文本，请原样转达给用户（用户就是在要这段文字，别复述、别总结，除非用户另外要求）。' +
      '没有可用识别模型时工具会返回明确提示，此时如实告知需要先在 设置 → 模型 配一个语音识别模型并把生成角色设为「识别」。',
    inputSchema: {
      type: 'object',
      properties: {
        audio: {
          type: 'string',
          description: '音频/视频文件的本地路径或 URL（用户上传的附件填其 [Attached ...: 路径] 里的路径）'
        },
        language: { type: 'string', description: '可选：识别语言，如 zh / en；不确定就别传，服务端会自动识别' },
        hotwords: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：热词列表，放人名/地名/专有名词/术语等容易听错的词，可显著提升准确率'
        },
        model: { type: 'string', description: '可选：指定识别模型（见返回报错里的可用清单），不传用默认第一个' },
        format: {
          type: 'string',
          description: '可选：音频容器格式 ogg / mp3 / wav / pcm / m4a，默认按文件扩展名推断，一般不用传'
        },
        sample_rate: { type: 'number', description: '可选：采样率，仅 pcm 裸流需要（如 16000）' },
        bits: { type: 'number', description: '可选：位深，仅 pcm 裸流需要（如 16）' },
        channels: { type: 'number', description: '可选：声道数，仅 pcm 裸流需要（如 1）' },
        itn: { type: 'boolean', description: '可选：是否开启文本规范化（数字/单位/日期转成规范写法），默认 true' }
      },
      required: ['audio']
    }
  }
]

/** 选识别目标：model 参数匹配 id 或展示名（包含即可），缺省取第一个 */
function pickTarget(list, model) {
  if (!list.length) return undefined
  if (!model) return list[0]
  const q = String(model).toLowerCase()
  return list.find((t) => ((t.id ?? '') + ' ' + (t.label ?? '')).toLowerCase().includes(q))
}

/** 扩展名（含 query 的 URL 也认）→ 接口格式名 */
function fmtFromName(name) {
  const clean = String(name).split(/[?#]/)[0]
  const i = clean.lastIndexOf('.')
  if (i < 0) return ''
  return EXT_TO_FMT[clean.slice(i).toLowerCase()] ?? ''
}

/**
 * 读音频并转 base64。
 *
 * 阶跃的音频输入要求「原始文件字节的 Base64，**不含** data: 前缀」，
 * 所以这里只取裸 base64。
 */
async function readAudio(src, fmtOverride) {
  const s = String(src ?? '').trim()
  if (!s) return { error: 'audio 为空' }
  if (/^data:/.test(s)) {
    const m = s.match(/^data:([^;,]*)[^,]*,([\s\S]*)$/)
    return { b64: (m?.[2] ?? '').replace(/\s/g, ''), fmt: fmtOverride || fmtFromName(m?.[1] ?? ''), inline: true }
  }
  if (/^https?:\/\//i.test(s)) {
    try {
      const res = await fetch(s, { signal: AbortSignal.timeout(300000) })
      if (!res.ok) return { error: `音频下载失败 HTTP ${res.status}` }
      const buf = Buffer.from(await res.arrayBuffer())
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const ctFmt = ct === 'audio/mpeg' ? 'mp3' : ct === 'audio/wav' || ct === 'audio/x-wav' ? 'wav' : ct === 'audio/mp4' ? 'm4a' : ct === 'audio/ogg' ? 'ogg' : ct === 'audio/flac' ? 'flac' : ''
      return { b64: buf.toString('base64'), fmt: fmtOverride || fmtFromName(s) || ctFmt }
    } catch (e) {
      return { error: `音频下载失败：${e?.message ?? e}` }
    }
  }
  const p = /^file:\/\//i.test(s) ? fileURLToPath(s) : s.replace(/^@/, '')
  if (!existsSync(p)) return { error: `音频文件不存在：${p}` }
  const size = statSync(p).size
  // base64 后会再涨 1/3，超长音频内联进请求体不现实，让用户先切分
  if (size > 100 * 1024 * 1024) return { error: `音频文件超过 100MB（${Math.round(size / 1048576)}MB），请先切分成较短片段再转写` }
  try {
    return { b64: readFileSync(p).toString('base64'), fmt: fmtOverride || fmtFromName(p) }
  } catch (e) {
    return { error: `音频读取失败：${e?.message ?? e}` }
  }
}

/**
 * 读 SSE 流直到拿到完整文本。
 *
 * 只认真实数据行（`data: ` 开头），按事件类型分派：
 *  - transcript.text.delta → 增量文本，只用来在最终缺失时兜底拼接；
 *  - transcript.text.done  → text 字段是完整文本，直接采用；
 *  - error                → 抛出去当失败。
 * 不依赖单次 chunk 的边界（SSE 一帧可能被拆包），所以按行缓冲累积。
 */
async function streamTranscribe(url, apiKey, body, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        accept: 'text/event-stream',
        authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      let j = null
      try {
        j = JSON.parse(raw)
      } catch {
        /* 保留原文 */
      }
      return { error: `HTTP ${res.status}：${j?.error?.message ?? j?.error?.type ?? j?.message ?? raw.slice(0, 300)}` }
    }
    if (!res.body) return { error: '服务端没返回响应体（不是 SSE 流）' }

    const dec = new TextDecoder()
    let buf = ''
    let deltas = ''
    let done = ''
    let errMsg = ''
    const handle = (line) => {
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') return
      let ev = null
      try {
        ev = JSON.parse(payload)
      } catch {
        return
      }
      const type = String(ev?.type ?? '')
      if (type === 'transcript.text.delta') deltas += String(ev.delta ?? '')
      else if (type === 'transcript.text.done') done = String(ev.text ?? '')
      else if (type === 'error') errMsg = String(ev.message ?? '未知错误')
      // 有的部署可能只给 text.done 之外的形态，兜一手常见字段名
      else if (!done && typeof ev?.text === 'string' && ev.text) done = ev.text
    }

    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        handle(line)
      }
    }
    if (buf) handle(buf.replace(/\r$/, ''))
    if (errMsg) return { error: errMsg }
    const out = (done || deltas).trim()
    if (!out) return { error: '识别完了但没返回任何文本（可能是纯静音或纯音乐片段）' }
    return { text: out }
  } catch (e) {
    if (e?.name === 'AbortError') return { error: `识别超时（超过 ${Math.round(timeoutMs / 1000)} 秒），音频过长时请先切分` }
    return { error: `请求失败：${e?.message ?? e}` }
  } finally {
    clearTimeout(timer)
  }
}

async function transcribe(args) {
  if (!ASR_TARGETS.length)
    return (
      '未配置任何语音识别模型。请在 设置 → 模型 添加/启用一个识别模型（如阶跃 stepaudio-3-asr-max），' +
      '并把它的生成角色设为「识别」，保存并重启内核后重试。'
    )
  const t = pickTarget(ASR_TARGETS, args.model)
  if (!t) return '找不到语音识别模型「' + args.model + '」。可用：' + ASR_TARGETS.map((x) => x.id).join('、')

  const fmtOverride = String(args.format ?? '').trim().toLowerCase()
  const got = await readAudio(args.audio, FORMATS.includes(fmtOverride) ? fmtOverride : '')
  if (got.error) return '音频处理失败：' + got.error

  const fmt = FORMATS.includes(fmtOverride) ? fmtOverride : got.fmt || 'mp3'
  const transcription = {
    model: t.model,
    ...(String(args.language ?? '').trim() ? { language: String(args.language).trim() } : {}),
    ...(Array.isArray(args.hotwords) && args.hotwords.length ? { hotwords: args.hotwords.map(String) } : {}),
    ...(typeof args.itn === 'boolean' ? { enable_itn: args.itn } : {})
  }
  const format = { type: fmt }
  // pcm / L16 是无头裸流，采样率等信息必须显式带上，否则服务端无法解析
  if (fmt === 'pcm') {
    format.codec = 'pcm_s16le'
    format.rate = Number(args.sample_rate) > 0 ? Number(args.sample_rate) : 16000
    format.bits = Number(args.bits) > 0 ? Number(args.bits) : 16
    format.channel = Number(args.channels) > 0 ? Number(args.channels) : 1
  } else {
    if (Number(args.sample_rate) > 0) format.rate = Number(args.sample_rate)
    if (Number(args.bits) > 0) format.bits = Number(args.bits)
    if (Number(args.channels) > 0) format.channel = Number(args.channels)
  }

  const base = t.baseURL.replace(/\/+$/, '')
  const body = { audio: { data: got.b64, input: { transcription, format } } }
  const r = await streamTranscribe(base + '/audio/asr/sse', t.apiKey, body, 600000)
  if (r.error) {
    return (
      `语音识别失败（${t.label || t.id}）：${r.error}\n` +
      `（识别端点：${base}/audio/asr/sse，模型 ${t.model}，格式 ${fmt}）\n` +
      '请核对 Base URL、API Key、模型 ID 与音频格式；若这家提供商的识别接口不长这样，告诉我接口路径我再补。'
    )
  }
  return (
    `语音识别完成（识别由 ${t.provider || t.id} 提供，模型 ${t.label || t.id}）：\n` +
    '--- 以下是识别出的正文 ---\n' +
    r.text
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
        serverInfo: { name: 'qingniao-asr', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    const args = req.params?.arguments ?? {}
    try {
      if (name !== 'transcribe_audio') throw new Error('未知工具：' + name)
      send({ jsonrpc: '2.0', id, result: text(await transcribe(args)) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: text('调用失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
