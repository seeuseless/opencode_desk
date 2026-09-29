#!/usr/bin/env node
// 音乐生成 MCP：音乐模型吐的是音频，当对话模型用必被拒（或回一坨没用的东西）。
// 这里把「提交 + 轮询」的异步音乐接口包成工具，任何对话模型都能让用户听上原创音乐。
// 目标清单（baseURL / apiKey / model）由主进程经 QN_MUSIC_TARGETS 注入，形态与 media / tts MCP 一致。
//
// 接口长这样（以阶跃 stepaudio-3-music 为准）：
//   POST {baseURL}/audio/music/submit  → { task_id }
//   POST {baseURL}/audio/music/query   → { status: PENDING|RUNNING|SUCCESS|FAILED, audio?: <base64> }
// 音乐是自回归长任务（数十秒到数分钟），拆成 generate_music + check_music 两步，
// 与生视频的 create_video + check_video 同一套思路，避免卡死在一次工具调用里。
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorize, deniedText, markUsed } from './gate.mjs'

const parse = (v) => {
  try {
    return JSON.parse(v || '[]')
  } catch {
    return []
  }
}
const MUSIC_TARGETS = parse(process.env.QN_MUSIC_TARGETS)
const OUT_DIR = process.env.QN_MEDIA_DIR || join(homedir(), '.qingniaoai', 'media')

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const text = (t) => ({ content: [{ type: 'text', text: t }] })

/** 轮询间隔与次数：单次 check 内部最多等 ~15 秒（3 次 × 5s，官方建议 5 秒一轮） */
const POLL_ROUNDS = 3
const POLL_INTERVAL_MS = 5000

const TOOLS = [
  {
    name: 'generate_music',
    description:
      '生成音乐/歌曲（原创曲子、纯音乐配乐、翻唱、给干声配伴奏）。用户要求「生成音乐 / 写首歌 / 做个 BGM / ' +
      '配个背景音乐 / 把这段清唱配上伴奏 / 翻唱一首」时都必须调用本工具——不要回答「我不会作曲」，' +
      '也不要试图用对话模型自己产出音乐。' +
      'mode 选类型：song=带人声的完整歌曲（默认）、instrumental=纯器乐（不唱歌）、cover=翻唱（跟随参考歌曲旋律）、' +
      'vocal_to_music=给无伴奏干声配伴奏。' +
      'prompt 放风格描述（曲风/人声/情绪/乐器/调式/制作质感，越具体越好，如「city pop，女声，温暖怀旧，中速，D 小调」）；' +
      'lyrics 放歌词，用 [Verse 1] / [Chorus] / [Bridge] / [Outro] 这类标签独占一行分段（mode=song 不传则由服务端自动写词；' +
      'cover 与 vocal_to_music 必传）。' +
      '素材路径放 reference（cover 传参考歌曲、vocal_to_music 传干声），' +
      '用户消息里形如 [Attached audio/mpeg: 路径] 的附件直接把该路径原样填进来，不要改写成文件名。' +
      '本工具只返回 task_id，不会等待出曲——拿到后一句话告知用户"音乐生成中"，随后反复调用 check_music 轮询：' +
      '每次查询内部已静默等约 15 秒，返回"还在生成中"就立即再查。轮询期间不要再向用户播报进度' +
      '（界面的工具状态已可见，中间的话是多余的），只在拿到 task_id 时和完成/失败时说一次话。' +
      '产物成功后有本地文件路径，必须原样告诉用户：路径用反引号包起来（防止 Markdown 吞掉转义），' +
      '并直接用 ![音频](本地路径) 的形式内嵌——客户端会渲染成播放器，远程 URL 可能过期。' +
      '没有可用音乐模型时工具会返回明确提示，此时如实告知需要先在 设置 → 模型 配一个音乐模型并把生成角色设为「音乐」。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '曲风/人声/情绪/乐器/调式/制作质感等风格描述，中英文皆可，越具体越好'
        },
        mode: {
          type: 'string',
          description: '生成类型：song=歌曲（默认）/ instrumental=纯器乐 / cover=翻唱 / vocal_to_music=干声配伴奏',
          enum: ['song', 'instrumental', 'cover', 'vocal_to_music']
        },
        lyrics: {
          type: 'string',
          description:
            '歌词，结构标签独占一行（[Intro]/[Verse 1]/[Chorus 1]/[Bridge]/[Outro] 等）。song 可不传（服务端自动写词）；cover 与 vocal_to_music 必传'
        },
        reference: {
          type: 'string',
          description: '素材本地路径或 URL：cover 传参考歌曲、vocal_to_music 传无伴奏干声。其他模式不需要'
        },
        model: { type: 'string', description: '可选：指定音乐模型（见返回报错里的可用清单），不传用默认第一个' },
        format: { type: 'string', description: '可选：输出格式 mp3 / wav / flac / opus / pcm，默认 mp3' },
        rewrite_lyrics: { type: 'boolean', description: '可选：是否让模型改写传入的歌词，默认 false' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'check_music',
    description:
      '查询音乐生成任务的结果。generate_music 返回 task_id 后就用本工具轮询，直到 status 变成 SUCCESS 或 FAILED。' +
      '每次调用内部已静默等约 15 秒；返回"还在生成中"就直接再调本工具继续查，不要向用户播报进度——' +
      '界面上工具调用本身有"进行中"状态提示，用户看得见；只在完成/失败时说一句结果。' +
      '完成后把本地文件路径原样转达并用 ![音频](本地路径) 内嵌给用户试听；失败则把原因说清楚。' +
      '同一个 task_id 不要重复 generate_music。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'generate_music 返回的任务 ID' },
        model: { type: 'string', description: '可选：该任务用的音乐模型，与 generate_music 保持一致' }
      },
      required: ['task_id']
    }
  }
]

/** 选音乐目标：model 参数匹配 id 或展示名（包含即可），缺省取第一个 */
function pickTarget(list, model) {
  if (!list.length) return undefined
  if (!model) return list[0]
  const q = String(model).toLowerCase()
  return list.find((t) => ((t.id ?? '') + ' ' + (t.label ?? '')).toLowerCase().includes(q))
}

function outName(ext) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}.${ext}`
}

const FMTS = ['mp3', 'wav', 'flac', 'opus', 'pcm']

function saveBuf(buf, ext) {
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    const file = join(OUT_DIR, outName(ext))
    writeFileSync(file, buf)
    return file
  } catch {
    return null
  }
}

/**
 * 把本地素材做成可直接进请求体的 base64。
 *
 * 阶跃的音频输入要求「原始文件字节的 Base64，**不含** data: 前缀」，
 * 所以这里只取裸 base64。URL 素材也支持：先下载再转，省得模型自己拼。
 */
async function toBase64(src) {
  const s = String(src ?? '').trim()
  if (!s) return { error: '素材路径为空' }
  if (/^data:/.test(s)) return { b64: s.replace(/^data:[^,]*,/, '') }
  if (/^https?:\/\//i.test(s)) {
    try {
      const res = await fetch(s, { signal: AbortSignal.timeout(120000) })
      if (!res.ok) return { error: `素材下载失败 HTTP ${res.status}` }
      return { b64: Buffer.from(await res.arrayBuffer()).toString('base64') }
    } catch (e) {
      return { error: `素材下载失败：${e?.message ?? e}` }
    }
  }
  const p = /^file:\/\//i.test(s) ? fileURLToPath(s) : s.replace(/^@/, '')
  if (!existsSync(p)) return { error: `素材文件不存在：${p}` }
  const size = statSync(p).size
  // 音乐参考音频动辄几十兆，base64 后还要再涨 1/3，超过内联上限就该让用户换小文件
  if (size > 20 * 1024 * 1024) return { error: `素材文件超过 20MB（${Math.round(size / 1048576)}MB），不适合内联进请求，请先裁剪或压缩` }
  try {
    return { b64: readFileSync(p).toString('base64') }
  } catch (e) {
    return { error: `素材读取失败：${e?.message ?? e}` }
  }
}

/** 音乐模式 → 接口的 task 值（song / instrumental 都走 text_to_music，器乐靠 instrumental 开关） */
function taskOf(mode) {
  const m = String(mode ?? '').trim().toLowerCase()
  if (m === 'cover') return { task: 'music_cover' }
  if (m === 'vocal_to_music' || m === 'vocal') return { task: 'vocal_to_music' }
  if (m === 'instrumental' || m === 'bgm') return { task: 'text_to_music', instrumental: true }
  return { task: 'text_to_music' }
}

async function generateMusic(args) {
  if (!MUSIC_TARGETS.length)
    return (
      '未配置任何音乐模型。请在 设置 → 模型 添加/启用一个音乐模型（如阶跃 stepaudio-3-music-preview），' +
      '并把它的生成角色设为「音乐」，保存并重启内核后重试。'
    )
  const caption = String(args.prompt ?? '').trim()
  if (!caption) return 'prompt 不能为空：请传入曲风等风格描述'
  // 多目标时挨个试到提交成为止：一家提交不了（Base URL 不对 / 没额度）不该拖死整次生成
  const order = args.model ? [pickTarget(MUSIC_TARGETS, args.model)].filter(Boolean) : MUSIC_TARGETS
  if (!order.length) return '找不到音乐模型「' + args.model + '」。可用：' + MUSIC_TARGETS.map((x) => x.id).join('、')

  const { task, instrumental } = taskOf(args.mode)
  const lyrics = String(args.lyrics ?? '').trim()
  const fmt = String(args.format ?? '').trim().toLowerCase()

  // 歌词与器乐互斥（接口层会 400，这里先拦掉，省一次白跑）
  if (instrumental && lyrics)
    return '纯器乐模式不能同时传 lyrics：请二选一——要伴奏就清空歌词，要唱歌就把 mode 改成 song。'
  // 这两个模式必须给歌词与素材，缺了必被拒，同样先说清楚
  if ((task === 'music_cover' || task === 'vocal_to_music') && !lyrics)
    return `mode=${args.mode} 必须提供 lyrics（歌词），请先补上再调用。`

  const body = {
    task,
    model_id: '',
    caption,
    ...(lyrics ? { lyrics } : {}),
    ...(instrumental ? { instrumental: true } : {}),
    response_format: FMTS.includes(fmt) ? fmt : 'mp3',
    ...(typeof args.rewrite_lyrics === 'boolean' ? { lyrics_rewrite: args.rewrite_lyrics } : {})
  }

  // 参考素材：cover 用 song_audio，vocal_to_music 用 vocal_audio
  const ref = String(args.reference ?? '').trim()
  if (ref) {
    const r = await toBase64(ref)
    if (r.error) return '参考素材处理失败：' + r.error
    if (task === 'music_cover') body.song_audio = r.b64
    else if (task === 'vocal_to_music') body.vocal_audio = r.b64
    // 其余模式不吃参考音频，忽略即可（不报错，模型可能只是顺手传了）
  } else {
    if (task === 'music_cover')
      return 'mode=cover 必须提供 reference（参考歌曲的本地路径或 URL），请先补上再调用。'
    if (task === 'vocal_to_music')
      return 'mode=vocal_to_music 必须提供 reference（无伴奏干声的本地路径或 URL），请先补上再调用。'
  }

  const errs = []
  for (const t of order) {
    // 生成音乐同样是另一次模型调用（另一家、另一份计费），先问过用户；拒绝即停手。
    // 只在**提交**时问：check_music 只是查同一个任务进度，不该重复打扰。
    const who = { role: 'music', id: t.id, label: t.label || t.id, provider: t.provider }
    const grant = await authorize(who)
    if (!grant.allowed) return deniedText(who, grant)
    body.model_id = t.model
    const r = await submitMusic(t, body, task)
    if (r.ok) {
      await markUsed(who)
      return r.text
    }
    errs.push(`〔${t.provider || t.id} / ${t.label || t.id}〕${r.error}`)
    if (order.length === 1) break
  }
  return (
    `提交音乐任务失败，已试过 ${errs.length} 个音乐模型：\n${errs.join('\n')}\n` +
    '常见原因：Base URL 不对（阶跃要 https://api.stepfun.com/v1，不能是计划端点）、模型 ID 不对、' +
    '账号没开该模型权限、Credit 不足、参数组合不合法。'
  )
}

/** 用单个目标提交一次音乐任务，返回文本回执 */
async function submitMusic(t, body, task) {
  const base = t.baseURL.replace(/\/+$/, '')
  let res
  try {
    res = await fetch(base + '/audio/music/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + t.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    })
  } catch (e) {
    return { ok: false, error: `请求发不出去：${e?.message ?? e}` }
  }
  const raw = await res.text().catch(() => '')
  let j = null
  try {
    j = JSON.parse(raw)
  } catch {
    /* 保留原文 */
  }
  if (!res.ok) {
    const why = j?.error?.message ?? j?.error?.type ?? j?.message ?? raw.slice(0, 300)
    return { ok: false, error: `HTTP ${res.status}：${why}（端点 ${base}/audio/music/submit，model_id=${t.model}，task=${task}）` }
  }
  const taskId = j?.task_id ?? j?.id ?? j?.data?.task_id
  if (!taskId) return { ok: false, error: `提交返回里没有 task_id，无法查询。原始返回：${raw.slice(0, 400)}` }

  return {
    ok: true,
    text:
      `音乐任务已创建（音乐由 ${t.provider || t.id} 提供，模型 ${t.label || t.id}，task=${task}）：\n` +
      `task_id：${taskId}\n` +
      `请告知用户"音乐生成中"（一首歌通常要数十秒到几分钟），` +
      `然后调用 check_music（task_id=${taskId}）轮询，每次返回"还在生成中"就立即再查（不要播报进度、不要停），直到完成或失败。`
  }
}

/** 从 SUCCESS 响应里取音频：base64 优先，也兼容外链（不同部署可能给 URL） */
function pickAudio(j) {
  if (!j || typeof j !== 'object') return null
  for (const k of ['audio', 'audio_base64', 'data', 'result', 'song_audio']) {
    const v = j[k]
    if (typeof v === 'string' && v.length > 200 && !/^https?:\/\//i.test(v)) return { b64: v.replace(/^data:[^,]*,/, '') }
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return { url: v }
    if (v && typeof v === 'object') {
      const n = pickAudio(v)
      if (n) return n
    }
  }
  const url = j.url ?? j.audio_url
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return { url }
  return null
}

async function saveRemote(url, ext) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180000) })
    if (!res.ok) return null
    return saveBuf(Buffer.from(await res.arrayBuffer()), ext)
  } catch {
    return null
  }
}

async function checkMusic(args) {
  if (!MUSIC_TARGETS.length) return '未配置任何音乐模型，无法查询。'
  const taskId = String(args.task_id ?? '').trim()
  if (!taskId) return 'task_id 不能为空'
  const t = pickTarget(MUSIC_TARGETS, args.model)
  if (!t) return '找不到音乐模型「' + args.model + '」。可用：' + MUSIC_TARGETS.map((x) => x.id).join('、')

  const base = t.baseURL.replace(/\/+$/, '')
  let last = null

  // 单次内部最多等 ~15 秒就返回"还在生成中"——短轮询让模型能在两次调用之间给用户播报进度，
  // 挂几分钟没反馈反而诱导用户点停止把回合打断（与生视频 check_video 同一考量）
  for (let i = 0; i < POLL_ROUNDS; i++) {
    let res
    try {
      res = await fetch(base + '/audio/music/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + t.apiKey },
        body: JSON.stringify({ task_id: taskId }),
        signal: AbortSignal.timeout(60000)
      })
    } catch (e) {
      return `查询失败（请求发不出去）：${e?.message ?? e}`
    }
    const raw = await res.text().catch(() => '')
    let j = null
    try {
      j = JSON.parse(raw)
    } catch {
      /* 保留原文 */
    }
    if (!res.ok) {
      const why = j?.error?.message ?? j?.error?.type ?? j?.message ?? raw.slice(0, 300)
      // 任务不存在/超保留期是终态，别让模型无脑重试
      return `查询失败（HTTP ${res.status}）：${why}。若为 task_not_found，说明任务已过期或 ID 有误，请重新 generate_music。`
    }
    last = j

    const status = String(j?.status ?? j?.state ?? '').toUpperCase()
    if (status === 'FAILED' || status === 'ERROR') {
      const err = j?.error ?? {}
      const stage = err.stage ? `（失败阶段：${err.stage}）` : ''
      const hint =
        err.stage === 'censor'
          ? '内容被安全审核拦截，请调整歌词或风格描述后重新提交。'
          : err.stage === 'no_speech_detected'
            ? '干声里没检测到有效人声，请换一段更清晰、空白更少的干声。'
            : err.stage === 'audio_transcode'
              ? '参考音频无法解码，请检查音频格式与参数。'
              : '可稍后重试并保留 task_id。'
      return `音乐生成失败${stage}：${err.message ?? j?.message ?? JSON.stringify(j).slice(0, 400)}\n${hint}`
    }

    const hit = pickAudio(j)
    if (status === 'SUCCESS' || (status !== 'PENDING' && status !== 'RUNNING' && hit)) {
      const fmt = String(j?.response_format ?? 'mp3').toLowerCase()
      const ext = FMTS.includes(fmt) ? fmt : 'mp3'
      const parts = [`音乐已完成（音乐由 ${t.provider || t.id} 提供，模型 ${t.label || t.id}，task_id=${taskId}）：`]
      if (hit?.b64) {
        const buf = Buffer.from(hit.b64, 'base64')
        const file = buf.length ? saveBuf(buf, ext) : null
        if (file) parts.push(`本地文件：${file}`)
        else parts.push('（音频已在返回里但落盘失败）')
      } else if (hit?.url) {
        const file = await saveRemote(hit.url, ext)
        parts.push(`音频 URL：${hit.url}`)
        if (file) parts.push(`本地文件：${file}`)
      } else {
        parts.push(`（返回里没找到音频字段，原始返回：${JSON.stringify(j).slice(0, 400)}）`)
      }
      if (j?.rewritten_caption) parts.push(`实际采用的风格：${j.rewritten_caption}`)
      parts.push('请把上面的本地路径原样转达，并用 ![音频](本地路径) 内嵌给用户试听。')
      return parts.join('\n')
    }

    if (i < POLL_ROUNDS - 1) await new Promise((ok) => setTimeout(ok, POLL_INTERVAL_MS))
  }

  return (
    `还在生成中（task_id=${taskId}，status=${last?.status ?? last?.state ?? '未知'}）。` +
    '这很正常，一首歌通常要数十秒到几分钟：直接再调用一次 check_music（task_id=${taskId}）继续查，' +
    '不要停，也不要向用户播报进度——界面的工具状态已可见，中间的话是多余的。'
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
        serverInfo: { name: 'qingniao-music', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    const args = req.params?.arguments ?? {}
    try {
      const fn = { generate_music: generateMusic, check_music: checkMusic }[name]
      if (!fn) throw new Error('未知工具：' + name)
      send({ jsonrpc: '2.0', id, result: text(await fn(args)) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: text('调用失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
