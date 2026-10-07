#!/usr/bin/env node
// 语音合成 MCP：TTS 模型吐的是音频不是文字，当对话模型用必被拒（或回一坨没用的东西）。
// 这里把各家的合成接口包成一个工具，任何对话模型都能给用户配音。
// 目标清单（baseURL / apiKey / model）由主进程经 QN_TTS_TARGETS 注入，形态与 media MCP 一致。
//
// 各家接口不统一，和生图同一套思路：按形态依次试、问通的记账，不做按家硬编码的适配表。
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorize, deniedText, markUsed } from './gate.mjs'

const parse = (v) => {
  try {
    return JSON.parse(v || '[]')
  } catch {
    return []
  }
}
const TTS_TARGETS = parse(process.env.QN_TTS_TARGETS)
const OUT_DIR = process.env.QN_MEDIA_DIR || join(homedir(), '.qingniaoai', 'media')

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const text = (t) => ({ content: [{ type: 'text', text: t }] })

const TOOLS = [
  {
    name: 'generate_speech',
    description:
      '把文字合成为语音（配音 / 朗读 / 做音频）。用户要求「配音 / 朗读这段 / 念出来 / 生成语音 / 做成音频 / ' +
      '换个音色读 / 说一段话」时都必须调用本工具——不要回答「我不会生成音频」，也不要试图用对话模型自己出音频。' +
      'text 放要念的正文（一次别超过上千字，长文分段多次调用）；风格、情绪、语速等要求放 style，' +
      '不要混进 text（例：style「用温柔的语气，语速稍慢」）；音色放 voice，不确定就别传，用服务端默认音色。' +
      '成功后结果里有本地音频文件路径，必须原样告诉用户：路径用反引号包起来（防止 Markdown 吞掉转义），' +
      '并直接用 ![音频](本地路径) 的形式内嵌——客户端会渲染成播放器，远程 URL 可能过期，不要把 URL 当地址贴出来。' +
      '没有可用语音模型时工具会返回明确提示，此时如实告诉用户需要先在 设置 → 模型 配一个 TTS 模型，不要硬编音频。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要合成的正文（自然语言，不含风格指令）' },
        model: { type: 'string', description: '可选：指定语音模型（见返回报错里的可用清单），不传用默认第一个' },
        voice: {
          type: 'string',
          description:
            '可选：音色名（如 MiMo 的 冰糖 / 茉莉，阶跃的 wenrounansheng / cixingnansheng / elegantgentle-female 等，以提供商文档为准），不传用该模型默认音色（阶跃会兜一个官方音色）'
        },
        style: {
          type: 'string',
          description:
            '可选：语气/情绪/语速等风格指令，如「兴奋的运动解说，语速偏快」；支持自然语言指令的模型才有效（阶跃的 stepaudio-3-tts 走 instruction 字段，上限 500 字）'
        },
        format: { type: 'string', description: '可选：输出格式 mp3 / wav / flac / opus / aac / pcm，默认 mp3' },
        speed: { type: 'number', description: '可选：语速倍率，一般 0.5~2，默认 1' }
      },
      required: ['text']
    }
  }
]

/** 选语音目标：model 参数匹配 id 或展示名（包含即可），缺省取第一个 */
function pickTarget(list, model) {
  if (!list.length) return undefined
  if (!model) return list[0]
  const q = String(model).toLowerCase()
  return list.find((t) => ((t.id ?? '') + ' ' + (t.label ?? '')).toLowerCase().includes(q))
}

/**
 * 候选顺序：用户显式点了 model 就只试它；否则按清单顺序依次试**全部**目标。
 *
 * 原来只挑第一个目标，撞 404 就整单失败——但「第一个」只是主进程按提供商顺序挑的，
 * 不代表它可用：同一个中转账号配了 Base URL 与语音端点不匹配（如阶跃的 step_plan
 * 计划端点里没有语音模型，得换 /v1），或某家额度用尽，都会让明明配了可用的第二家
 * （如 MiMo）却报「语音合成失败」。多个目标时挨个试到通为止，才是「配置里有的都能用」。
 */
function targetOrder(list, model) {
  if (!list.length) return []
  const one = pickTarget(list, model)
  if (model) return one ? [one] : []
  return list
}

/**
 * 这个错误说明「整个目标不可用」还是「只是这条请求形态不对」。
 *
 * 关键是 404 要分两种情况看：
 *  - 错误体里有服务端的业务文案（`model_invalid` / `does not exist` / `no access`）→
 *    模型或凭证有问题，换形态也是同样的错，放弃整个目标；
 *  - 只有一张 HTML 404 或没有可辨认文案 → 多半是**路径不存在**（如 MiMo 就没有
 *    /audio/speech，它的语音在 /chat/completions 上），必须继续试下一种形态，
 *    否则会把明明可用的目标误判为不可用。
 * 401/403 是凭证问题，与形态无关，直接放弃目标。
 */
function isTargetDead(msg) {
  if (/HTTP (401|403)/.test(msg)) return true
  if (!/HTTP 404/.test(msg)) return false
  return /model_invalid|does not exist|no access|无权限|not have access/i.test(msg)
}

function outName(ext) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}.${ext}`
}

const CT_EXT = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/pcm': 'wav',
  'audio/L16': 'wav'
}
const FMTS = ['mp3', 'wav', 'flac', 'opus', 'aac', 'pcm']

/** 请求里的格式名 → 落盘扩展名（pcm / L16 是无头裸流，补个 WAV 头再存，否则播放器不认） */
function extOf(fmt, ct) {
  const c = String(ct || '').split(';')[0].trim().toLowerCase()
  if (c === 'audio/pcm' || c === 'audio/l16') return 'pcm'
  return CT_EXT[c] || (FMTS.includes(fmt) ? (fmt === 'pcm' ? 'pcm' : fmt) : 'mp3')
}

/** 裸 PCM 补 44 字节 WAV 头：这类返回没写采样率，按常见的 24k/16bit/单声道封，不对也能当数据文件用 */
function wavWrap(pcm, rate = 24000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44)
  const byteRate = (rate * channels * bits) / 8
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE((bits / 8) * channels, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function saveBuf(buf, ext) {
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    const file = join(OUT_DIR, outName(ext))
    writeFileSync(file, ext === 'pcm' ? wavWrap(buf) : buf)
    return file
  } catch {
    return null
  }
}

/** 下载远端音频到本地（结果里给的是 URL 时），失败返回 null */
async function saveRemote(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!res.ok) return null
    const ext = extOf('', res.headers.get('content-type'))
    return saveBuf(Buffer.from(await res.arrayBuffer()), ext)
  } catch {
    return null
  }
}

/**
 * 三种请求形态，依次试：
 * ① OpenAI 标准：POST {baseURL}/audio/speech，正文放 input，响应是音频字节流（多数兼容端点与 stepfun 的 url 变体都在这条上）；
 * ② chat 带 audio：POST {baseURL}/chat/completions + audio:{voice,format}，音频在 choices[0].message.audio.data（MiMo 那套）；
 * ③ 同上但显式声明 modalities 含 audio（OpenAI gpt-4o-audio 一类要它才回音频）。
 */
function speechAttempts(t, body, chatMessages, voice, fmt) {
  const base = t.baseURL.replace(/\/+$/, '')
  const out = [{ name: 'audio/speech', url: base + '/audio/speech', json: body }]
  const chat = { model: t.model, messages: chatMessages }
  if (voice) chat.audio = { voice, format: fmt }
  else chat.audio = { format: fmt }
  out.push({ name: 'chat+audio', url: base + '/chat/completions', json: chat })
  out.push({ name: 'chat+modalities', url: base + '/chat/completions', json: { ...chat, modalities: ['audio', 'text'] } })
  return out
}

/**
 * StepFun 家的语音合成：端点同为 /audio/speech，但请求体与 OpenAI 有几处硬性差异，
 * 撞不出兼容形态就得单独摆一套（实测照 OpenAI 那套发会被拒）。
 *
 *  - `voice` **必填**，不给默认音色会直接 400，所以这里兜一个官方音色；
 *  - `stepaudio-3-tts` / `stepaudio-2.5-tts` **不接受 voice_label**（传了报错），
 *    情绪与风格只能走 `instruction`（自然语言，500 字内）或正文里的 `()`；
 *  - `speed` 0.5~2、`volume` 0.1~2、`sample_rate` 支持 8000/16000/22050/24000/48000；
 *  - 默认返回音频二进制流；`return_url=true` 才回 JSON 带 data.url。
 */
function stepfunAttempts(t, body, voice, fmt, style, speed) {
  const base = t.baseURL.replace(/\/+$/, '')
  // 官方音色里最通用的一个：不传 voice 必 400，宁可给个默认也别让用户先踩一次
  const v = voice || 'wenrounansheng'
  const json = {
    model: t.model,
    input: body,
    voice: v,
    ...(FMTS.includes(fmt) ? { response_format: fmt } : {}),
    ...(typeof speed === 'number' ? { speed } : {}),
    // 全局情绪/人设指令（仅 stepaudio-2.5-tts / stepaudio-3-tts 生效，3 代上限 500 字）
    ...(style ? { instruction: style } : {})
  }
  return [
    { name: 'stepfun/speech', url: base + '/audio/speech', json },
    // 有些部署把音频塞进 OpenAI 风格 JSON（b64），留一条兜底
    { name: 'stepfun/speech+url', url: base + '/audio/speech', json: { ...json, return_url: true } }
  ]
}

/** 这家是不是 StepFun（按 baseURL 域名判，不靠模型名——用户可能用中转站） */
function isStepfun(t) {
  return /(^|\.)stepfun\.(com|ai)$/i.test(safeHost(t.baseURL))
}

function safeHost(u) {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}

/** 长 base64（音频体）：不含空格与常见标点，所以不会把 assistant 的正文文本当成音频 */
const B64_RE = /^[A-Za-z0-9+/]{200,}={0,2}$/

/**
 * JSON 返回里找音频：各家字段名不统一（data.url / data.b64_json / choices[0].message.audio.data），
 * 所以按值判而不是按字段名判。base64 优先——它当场就能落盘，外链还可能过期。
 */
function pickAudio(j) {
  const urls = []
  const b64s = []
  const walk = (n, d) => {
    if (!n || d > 6) return
    if (typeof n === 'string') {
      if (/^data:audio[^,]*;base64,(.+)$/i.test(n)) b64s.push(n.replace(/^data:audio[^,]*;base64,/i, ''))
      else if (/^https?:\/\//i.test(n)) urls.push(n)
      else if (B64_RE.test(n)) b64s.push(n)
      return
    }
    if (Array.isArray(n)) {
      for (const x of n) walk(x, d + 1)
      return
    }
    if (typeof n === 'object') for (const v of Object.values(n)) walk(v, d + 1)
  }
  walk(j, 0)
  if (b64s.length) return { b64: b64s[0] }
  if (urls.length) return { url: urls[0] }
  return null
}

async function runAttempt(t, att) {
  let res
  try {
    res = await fetch(att.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t.apiKey },
      body: JSON.stringify(att.json),
      signal: AbortSignal.timeout(180000)
    })
  } catch (e) {
    return { error: `请求发不出去：${e?.message ?? e}` }
  }
  const ct = res.headers.get('content-type') || ''
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let j = null
    try {
      j = JSON.parse(body)
    } catch {
      /* 原样带 text */
    }
    return { error: `HTTP ${res.status}：${j?.error?.message ?? j?.message ?? j?.detail ?? body.slice(0, 200)}` }
  }
  if (ct.startsWith('audio/')) return { buf: Buffer.from(await res.arrayBuffer()), ct }
  const body = await res.text().catch(() => '')
  let j = null
  try {
    j = JSON.parse(body)
  } catch {
    return { error: `返回不是音频也不是 JSON（content-type=${ct}）：${body.slice(0, 200)}` }
  }
  const hit = pickAudio(j)
  if (!hit) {
    const why = j?.error?.message ?? j?.message ?? ''
    return { error: why || `返回里没有音频（既不是音频字节流，也没有 url/base64）：${JSON.stringify(j).slice(0, 240)}` }
  }
  if (hit.b64) {
    const buf = Buffer.from(hit.b64, 'base64')
    if (!buf.length) return { error: '返回的 base64 音频解出来是空的' }
    return { buf }
  }
  const file = await saveRemote(hit.url)
  return file ? { file, url: hit.url } : { url: hit.url }
}

/** 问通的请求形态（按目标记账）：合成一次几秒到几十秒，别每次都从头撞三堵墙 */
const speechPicks = new Map()

async function generateSpeech(args) {
  if (!TTS_TARGETS.length)
    return '未配置任何语音模型。请在 设置 → 模型 添加/启用一个带语音合成模型的提供商（如 mimo-v2.5-tts），保存并重启内核后重试。'
  let body = String(args.text ?? '').trim()
  if (/^(@|file:\/\/|[a-z]:[\\/])/i.test(body)) {
    // 模型有时把「要念的内容」写成附件路径（用户传了 txt 的场景）；当文件读进来，读不到就别把路径念出来
    const p = body.startsWith('file://') ? fileURLToPath(body) : body.replace(/^@/, '')
    if (!existsSync(p)) return `text 看着像文件路径但文件不存在：${p}。请把要合成的正文本身传进来。`
    if (statSync(p).size > 2 * 1024 * 1024) return `文件超过 2MB，不适合直接合成：${p}`
    body = readFileSync(p, 'utf8').trim()
  }
  if (!body) return 'text 不能为空：请传入要合成的正文'
  const targets = targetOrder(TTS_TARGETS, args.model)
  if (!targets.length) return '找不到语音模型「' + args.model + '」。可用：' + TTS_TARGETS.map((x) => x.id).join('、')

  const fmt = String(args.format ?? '').trim().toLowerCase()
  const voice = String(args.voice ?? '').trim()
  const style = String(args.style ?? '').trim()
  // 必须在函数作用域里先取出来：stepfunAttempts 与下面的请求体都要用
  const speed = typeof args.speed === 'number' ? args.speed : undefined

  // 多目标时挨个试到通为止（见 targetOrder 注释）：一家不可用不该拖死整次合成
  const failed = []
  for (const t of targets) {
    // 配音是在调另一个模型（另一家、另一份计费），先问过用户。
    // 放在循环里是刻意的：多目标回退时换了模型就是换了消费对象，该分别问。
    // 用户拒绝 → 立刻停手（不能拿「换下一家」当成绕过拒绝的办法）。
    const who = { role: 'tts', id: t.id, label: t.label || t.id, provider: t.provider }
    const grant = await authorize(who)
    if (!grant.allowed) return deniedText(who, grant)
    const r = await synthWith(t, body, fmt, voice, style, speed)
    if (r.ok) {
      await markUsed(who)
      return r.text
    }
    failed.push({ t, errs: r.errs })
    // 目标只有一个时不用再往下试（也没得试），保留完整报错
    if (targets.length === 1) break
  }

  const detail = failed
    .map((f) => `〔${f.t.provider || f.t.id} / ${f.t.label || f.t.id}〕\n  ${f.errs.join('\n  ')}`)
    .join('\n')
  const nextOne = TTS_TARGETS.find((x) => !failed.some((f) => f.t.id === x.id))
  // 命中「模型不存在」时给出最可能的真因：Base URL 指到了没有语音模型的计划端点
  const modelMissing = failed.some((f) => f.errs.some((e) => /model_invalid|does not exist/i.test(e)))
  const host = failed[0]?.t?.baseURL ?? ''
  return (
    `语音合成失败，已试过 ${failed.length} 个语音模型：\n${detail}\n` +
    (nextOne ? `\n还有未试用的目标：${nextOne.id}，可在调用时用 model 参数指定。\n` : '\n') +
    '排查：' +
    (modelMissing
      ? `① 报「模型不存在」多半是 Base URL 不对——确认它指到的是通用接口（如阶跃是 https://api.stepfun.com/v1），` +
        `而不是某个不含语音模型的计划端点（如 /step_plan/v1）。当前用的是 ${host}。`
      : '① Base URL 是否与该家的语音接口匹配；') +
    '② API Key 有没有该模型的权限；③ 音色名是否该模型支持。' +
    '若这家提供商的语音接口不长这样，告诉我接口路径我再补。'
  )
}

/**
 * 用单个目标合成一次：三种请求形态依次试，成功返回文本回执。
 *
 * 被判定为 targetDead 时**立刻放弃这个目标**——模型不存在或凭证无效，
 * 再换 chat/completions 形态也是同样的错，白等三轮。
 */
async function synthWith(t, body, fmt, voice, style, speed) {
  let attempts = speechAttempts(
    t,
    {
      model: t.model,
      input: body,
      response_format: FMTS.includes(fmt) ? fmt : undefined,
      speed,
      // OpenAI 的 gpt-4o-mini-tts 用 instructions 收风格指令
      instructions: style || undefined,
      voice: voice || undefined
    },
    // MiMo 那套：待合成文本放 assistant，风格指令放 user
    [
      ...(style ? [{ role: 'user', content: style }] : []),
      { role: 'assistant', content: body }
    ],
    voice,
    FMTS.includes(fmt) ? fmt : 'mp3'
  )
  // StepFun 的请求体硬要求 voice、且拒收 voice_label，通用形态撞不出来，整套换自己的
  if (isStepfun(t)) attempts = [...stepfunAttempts(t, body, voice, fmt, style, speed), ...attempts]
  const hit = speechPicks.get(t.id)
  if (hit) attempts = [attempts.find((a) => a.name === hit), ...attempts.filter((a) => a.name !== hit)].filter(Boolean)

  const errs = []
  let dead = false
  for (const att of attempts) {
    const r = await runAttempt(t, att)
    if (r.error) {
      errs.push(`〔${att.name}〕${r.error}`)
      if (isTargetDead(r.error)) {
        dead = true
        break
      }
      continue
    }
    speechPicks.set(t.id, att.name)
    const parts = [`语音已生成（配音由 ${t.provider || t.id} 提供，模型 ${t.label || t.id}）：`]
    if (r.file) parts.push(`本地文件：${r.file}`)
    else if (r.buf) {
      const file = saveBuf(r.buf, extOf(fmt, ''))
      if (file) parts.push(`本地文件：${file}`)
      else parts.push('（音频已在内存里但落盘失败）')
    } else if (r.url) parts.push(`音频 URL：${r.url}（本地下载失败，注意它可能过期）`)
    parts.push('请把上面的本地路径原样转达，并用 ![音频](本地路径) 内嵌给用户试听。')
    return { ok: true, text: parts.join('\n') }
  }
  return { ok: false, errs, dead }
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
        serverInfo: { name: 'qingniao-tts', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    const args = req.params?.arguments ?? {}
    try {
      if (name !== 'generate_speech') throw new Error('未知工具：' + name)
      send({ jsonrpc: '2.0', id, result: text(await generateSpeech(args)) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: text('调用失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
