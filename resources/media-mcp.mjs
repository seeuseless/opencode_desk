#!/usr/bin/env node
// 媒体生成 MCP：agnes 这类生成模型不走 chat 接口（只认 images-generations / videos 端点），
// 当对话模型用必被拒。这里把这两类端点包成工具，任何对话模型都能生图/生视频。
// 目标清单（baseURL / apiKey / model）由主进程经 QN_IMAGE_TARGETS / QN_VIDEO_TARGETS 注入。
// 视频是异步任务（数分钟），拆成 create_video + check_video 两步，避免卡死在一次工具调用里。
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
const IMAGE_TARGETS = parse(process.env.QN_IMAGE_TARGETS)
const VIDEO_TARGETS = parse(process.env.QN_VIDEO_TARGETS)
const OUT_DIR = process.env.QN_MEDIA_DIR || join(homedir(), '.qingniaoai', 'media')

const imgResult = (t) => ({ content: [{ type: 'text', text: t }] })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const TOOLS = [
  {
    name: 'generate_image',
    description:
      '文字生成图片（或基于已有图片改图）。用户要求「生图 / 画一张 / 设计图片 / 出图 / 改这张图」时都必须调用本工具——' +
      '不要回答「我不会生成图片」，也不要试图用对话模型自己出图。' +
      '用户发来图片附件（或图片+一句话）时同样适用：文字里出现「换成/改成/去掉/加上/换成…风格/把这张…」等改动意图，' +
      '就属于改图——必须调用本工具并把附件路径放进 image 参数，不要只描述图片或反问用户；' +
      '纯提问（「这是什么」「好看吗」）才按图片理解回答，不必出图。' +
      '成功后结果里有图片 URL 和本地文件路径，两者都要原样告诉用户：本地路径用反引号包起来（防止 Markdown 吞掉转义），' +
      '展示图片直接用 ![图片](本地路径) 的形式内嵌——客户端优先显示本地文件，远程 URL 可能过期，不要把 URL 当图片地址贴出来。' +
      '一次出图约需几十秒，属正常，不要中途放弃。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（中英文皆可，越具体越好），如「卡通风格的柴犬宇航员，明亮配色」' },
        model: {
          type: 'string',
          description: '可选：指定生图模型（见返回报错里的可用清单），不传用默认的第一个生图模型'
        },
        size: { type: 'string', description: '可选：分辨率档位 1K / 2K / 3K / 4K，默认由服务端决定' },
        ratio: {
          type: 'string',
          description: '可选：宽高比，如 1:1、16:9、9:16、4:3、3:4、2:3、3:2、21:9'
        },
        image: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选：参考图/被改图列表（图生图、改图时才传）。每项可以是 URL、data URL，或用户上传附件的本地路径——' +
            '用户消息里形如 [Attached image/png: 路径] 的附件，直接把该路径原样填进来即可，不要自己编造或改写成文件名'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'create_video',
    description:
      '创建视频生成任务（异步，出片通常要几分钟）。用户要求「生视频 / 做个视频 / 让这张图动起来 / ' +
      '按这段音乐出片 / 照这段视频的风格再生成」时都调用本工具——素材是图就传 images、音频传 audios、' +
      '视频传 videos（首尾帧约束构图用 first_frame / last_frame），文字照样放 prompt；什么都不传就是纯文字生视频。' +
      '本工具只返回 video_id，不会等待出片——拿到 video_id 后告知用户"视频生成中"，随后反复调用 check_video 轮询：' +
      '每次查询内部已静默等约 12 秒，返回"还在生成中"就立即再查即可，两次之间用一句话向用户播报进度（让用户看到事情在推进，不会手误点停止）。' +
      '完成或失败都要把结果原样转达。同一 video_id 不要重复 create。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频内容描述（画面、运镜、氛围，中英文皆可）' },
        model: { type: 'string', description: '可选：指定生视频模型，不传用默认的第一个' },
        seconds: { type: 'string', description: '可选：时长秒数，字符串 "4"-"12"，默认 "5"' },
        aspect_ratio: { type: 'string', description: '可选：画幅如 16:9、9:16、1:1、4:3、3:4、21:9，默认 16:9' },
        size: {
          type: 'string',
          description: '可选：分辨率档位，默认 "720P"（flash 只认 720P，填别的会 400；1080P/1K/2K 需模型本身支持）'
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：参考图列表（≤5 张，URL / data URL / 用户上传附件的本地路径均可），传了即按参考模式生成'
        },
        audios: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：参考音频列表（≤3 段，URL / data URL / 本地路径），用于配着音乐/人声出片'
        },
        videos: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选：参考视频列表（≤5 段，URL / data URL / 本地路径），视频生视频（续写、换风格）时传。' +
            '注意：并非所有模型都吃参考视频——若返回 "videos is not supported" 之类错误，' +
            '说明当前模型不支持，改用 images（取一帧当参考）或纯文字生成'
        },
        first_frame: { type: 'string', description: '可选：首帧图（URL、data URL 或本地路径；首尾帧模式）' },
        last_frame: { type: 'string', description: '可选：尾帧图（URL、data URL 或本地路径；首尾帧模式）' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'check_video',
    description:
      '查询 create_video 任务的进度。返回 生成中 / 已完成（含视频 URL 与本地文件路径）/ 失败（含原因）。' +
      '每次调用内部已静默等待约 12 秒；返回"还在生成中"时先给用户播报一句进度，然后立即再调本工具，直到完成或失败。',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'create_video 返回的 video_id' },
        model: { type: 'string', description: '可选：与 create_video 所用模型一致（非纯文字模式必传）' }
      },
      required: ['video_id']
    }
  }
]

/** 选生成目标：model 参数匹配 id 或展示名（包含即可），缺省取第一个 */
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

const REF_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac'
}

/** 本地素材路径解析：file:// 还原、裸文件名落到媒体目录 */
function resolveLocalPath(v) {
  let p = String(v ?? '').trim()
  if (/^file:\/\//i.test(p)) p = fileURLToPath(p)
  if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('/')) p = join(OUT_DIR, p)
  return p
}

/** 参考素材归一化：http(s)/data 直传；本地绝对路径或裸文件名（媒体目录兜底）读文件转 data URL；无效返回空串 */
function normalizeImageRef(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^(https?|data):/i.test(s)) return s
  const p = resolveLocalPath(s)
  if (!existsSync(p)) return ''
  // 扩展名必须把数字算进去：.mp3 / .mp4 / .m4a 这类带数字的，用 [a-z]+ 会匹配不上，素材就被误判成不支持
  const mime = REF_MIME[p.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '']
  if (!mime) return ''
  try {
    return `data:${mime};base64,${readFileSync(p).toString('base64')}`
  } catch {
    return ''
  }
}
function normalizeImageList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeImageRef).filter(Boolean)
}

/** 本地素材转 base64 会再膨胀三分之一，超过这个体积就没必要送了（本地视频动辄几十上百 MB） */
const MAX_LOCAL_BYTES = 50 * 1024 * 1024

/**
 * 归一化 + 丢项报告。静默丢素材最坑：模型以为传成功了，出片却是另一回事，
 * 所以丢掉的每一项都要带原因回给模型，让它能明确告诉用户。
 */
function normalizeWithReport(list, limit = MAX_LOCAL_BYTES) {
  const ok = []
  const dropped = []
  for (const v of Array.isArray(list) ? list : []) {
    const r = normalizeImageRef(v)
    if (r) {
      ok.push(r)
      continue
    }
    const p = resolveLocalPath(v)
    const why =
      existsSync(p) && statSync(p).size > limit
        ? `文件 ${(statSync(p).size / 1024 / 1024).toFixed(1)}MB，超过 ${Math.round(limit / 1024 / 1024)}MB 上限，请改用公开可访问的 URL`
        : '路径不存在或格式不支持'
    dropped.push(`${v}（${why}）`)
  }
  return { ok, dropped }
}

/** 下载远端文件到本地媒体目录，失败返回 null（不算任务失败） */
async function saveRemote(url, ext) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!res.ok) return null
    mkdirSync(OUT_DIR, { recursive: true })
    const file = join(OUT_DIR, outName(ext))
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    return file
  } catch {
    return null
  }
}

async function generateImage(args) {
  if (!IMAGE_TARGETS.length) return '未配置任何生图模型。请在 设置 → 模型 添加/启用一个带生图模型（如 agnes-image-*）的提供商，保存并重启内核后重试。'
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return 'prompt 不能为空：请传入画面描述'
  const t = pickTarget(IMAGE_TARGETS, args.model)
  if (!t) return '找不到生图模型「' + args.model + '」。可用：' + IMAGE_TARGETS.map((x) => x.id).join('、')

  const body = { model: t.model, prompt }
  if (args.size) body.size = String(args.size)
  if (args.ratio) body.ratio = String(args.ratio)
  const extra = { response_format: 'url' }
  const imgs = normalizeImageList(args.image)
  if (imgs.length) extra.image = imgs
  body.extra_body = extra

  const url = t.baseURL.replace(/\/+$/, '') + '/images/generations'
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000)
    })
  } catch (e) {
    return `生图请求发不出去（${t.id}）：${e?.message ?? e}。检查 Base URL 与网络后重试。`
  }
  const text = await res.text().catch(() => '')
  let j = null
  try { j = JSON.parse(text) } catch { /* 非 JSON 错误体，原样带给模型 */ }
  if (!res.ok) return `生图失败（${t.id}，HTTP ${res.status}）：${j?.error?.message ?? j?.detail ?? j?.message ?? text.slice(0, 300)}`

  const item = j?.data?.[0] ?? {}
  const parts = [`生图成功（模型 ${t.id}）：`]
  let b64 = null
  let ext = 'png'
  if (item.url) {
    parts.push(`图片 URL：${item.url}`)
    const m = item.url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i)
    if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg')
    // 外链随时可能过期，落一份本地文件兜底
    b64 = null
    const file = await saveRemote(item.url, ext)
    if (file) parts.push(`本地文件：${file}`)
  } else if (item.b64_json) {
    b64 = item.b64_json
    if (/^\/9j\/|^data:image\/jpe?g/i.test(item.b64_json)) ext = 'jpg'
  } else {
    return '生图返回异常：既没有 url 也没有 b64_json。原始返回：' + text.slice(0, 300)
  }
  if (b64) {
    try {
      mkdirSync(OUT_DIR, { recursive: true })
      const file = join(OUT_DIR, outName(ext))
      writeFileSync(file, Buffer.from(b64, 'base64'))
      parts.push(`本地文件：${file}`)
    } catch (e) {
      parts.push(`（本地保存失败：${e?.message ?? e}）`)
    }
  }
  return parts.join('\n')
}

async function apiFetch(t, url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t.apiKey, ...(init?.headers ?? {}) }
  })
  const text = await res.text().catch(() => '')
  let j = null
  try { j = JSON.parse(text) } catch { /* 原样带 text */ }
  return { ok: res.ok, status: res.status, j, text }
}

function originOf(baseURL) {
  try {
    return new URL(baseURL).origin
  } catch {
    return baseURL.replace(/^(https?:\/\/[^/]+).*$/, '$1')
  }
}

async function createVideo(args) {
  if (!VIDEO_TARGETS.length) return '未配置任何生视频模型。请在 设置 → 模型 添加/启用一个带生视频模型（如 agnes-video-*）的提供商，保存并重启内核后重试。'
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return 'prompt 不能为空：请传入视频内容描述'
  const t = pickTarget(VIDEO_TARGETS, args.model)
  if (!t) return '找不到生视频模型「' + args.model + '」。可用：' + VIDEO_TARGETS.map((x) => x.id).join('、')

  const body = { model: t.model, prompt, size: '720P', seconds: '5', mode: 'text' }
  if (args.seconds) body.seconds = String(args.seconds)
  if (args.size) body.size = String(args.size)
  if (args.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio)
  const im = normalizeWithReport(args.images)
  const au = normalizeWithReport(args.audios)
  const vi = normalizeWithReport(args.videos)
  const ff = normalizeImageRef(args.first_frame)
  const lf = normalizeImageRef(args.last_frame)
  const wanted = [...(Array.isArray(args.images) ? args.images : []), ...(Array.isArray(args.audios) ? args.audios : []), ...(Array.isArray(args.videos) ? args.videos : [])]
  const dropped = [...im.dropped, ...au.dropped, ...vi.dropped]
  // 素材全废却不报错的话，请求会静默退化成纯文字生视频，出片和用户预期完全不同——必须拦下
  if (wanted.length && !im.ok.length && !au.ok.length && !vi.ok.length && !ff && !lf)
    return '参考素材全部处理失败，无法按素材生成：\n' + dropped.join('\n') + '\n请改用公开可访问的 URL，或先确认文件在本地存在。'
  // 三种模式互斥：首尾帧（keyframe）优先，否则只要带了任一参考素材就走 reference
  if (ff || lf) {
    body.mode = 'keyframe'
    if (ff) body.first_frame = ff
    if (lf) body.last_frame = lf
  } else if (im.ok.length || au.ok.length || vi.ok.length) {
    body.mode = 'reference'
    if (im.ok.length) body.images = im.ok.slice(0, 5)
    if (au.ok.length) body.audios = au.ok.slice(0, 3)
    if (vi.ok.length) body.videos = vi.ok.slice(0, 5)
  }

  const r = await apiFetch(t, t.baseURL.replace(/\/+$/, '') + '/videos', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  })
  if (!r.ok) return `创建视频任务失败（${t.id}，HTTP ${r.status}）：${r.j?.error?.message ?? r.j?.detail ?? r.j?.message ?? r.text.slice(0, 300)}`
  const videoId = r.j?.video_id ?? r.j?.id ?? r.j?.data?.video_id ?? r.j?.data?.id ?? r.j?.task_id
  if (!videoId) return '创建视频任务返回异常：响应里没有 video_id。原始返回：' + r.text.slice(0, 300)
  const warn = dropped.length ? `\n注意：以下素材没能用上（已按其余素材生成）：${dropped.join('；')}` : ''
  return (
    `视频任务已创建（模型 ${t.id}，mode=${body.mode}）：video_id=${videoId}。出片通常要几分钟：请告知用户"视频生成中"，` +
    `然后先调 check_video（video_id=${videoId}）轮询，每次返回"还在生成中"就播报名进度并立即再查，直到完成或失败。` +
    warn
  )
}

/** 在任意 JSON 里找视频直链（mp4/webm/mov），字段名以实际返回为准 */
function findVideoUrl(node, depth = 0) {
  if (depth > 6 || node == null) return ''
  if (typeof node === 'string') return /\.(mp4|webm|mov)(\?|$)/i.test(node) ? node : ''
  if (Array.isArray(node)) {
    for (const x of node) {
      const hit = findVideoUrl(x, depth + 1)
      if (hit) return hit
    }
    return ''
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) {
      const hit = findVideoUrl(v, depth + 1)
      if (hit) return hit
    }
  }
  return ''
}

async function checkVideo(args) {
  if (!VIDEO_TARGETS.length) return '未配置任何生视频模型，无法查询。'
  const videoId = String(args.video_id ?? '').trim()
  if (!videoId) return 'video_id 不能为空'
  const t = pickTarget(VIDEO_TARGETS, args.model)
  if (!t) return '找不到生视频模型「' + args.model + '」。可用：' + VIDEO_TARGETS.map((x) => x.id).join('、')

  // 单次查询内部最多等 ~12 秒（4 次 × 3s）就返回"还在生成中"——短轮询让模型能在两次调用之间
  // 给用户播报进度，挂 50 秒没反馈反而诱导用户点停止把回合打断
  let last = null
  for (let i = 0; i < 4; i++) {
    const r = await apiFetch(
      t,
      originOf(t.baseURL) + '/agnesapi?video_id=' + encodeURIComponent(videoId) + '&model_name=' + encodeURIComponent(t.model),
      { method: 'GET', signal: AbortSignal.timeout(20000) }
    )
    if (!r.ok) return `查询失败（HTTP ${r.status}）：${r.j?.error?.message ?? r.j?.detail ?? r.j?.message ?? r.text.slice(0, 300)}`
    last = r.j ?? {}
    const status = String(last.status ?? last.state ?? '').toLowerCase()
    if (status === 'failed' || status === 'error')
      return `视频生成失败：${last.error ?? last.message ?? last.detail ?? JSON.stringify(last).slice(0, 400)}`
    const file = findVideoUrl(last)
    if (status === 'completed' || (status !== 'queued' && status !== 'processing' && file)) {
      const parts = [`视频已完成（video_id=${videoId}）：`, `视频 URL：${file || '（响应里没有直链，原始返回：' + JSON.stringify(last).slice(0, 400) + '）'}`]
      if (file) {
        const local = await saveRemote(file, 'mp4')
        if (local) parts.push(`本地文件：${local}`)
      }
      return parts.join('\n')
    }
    await new Promise((ok) => setTimeout(ok, 3000))
  }
  return `还在生成中（video_id=${videoId}，status=${last?.status ?? last?.state ?? '未知'}）。这很正常，出片通常要几分钟：请先用一句话向用户播报进度（如"还在渲染中，请稍等"），再直接调用一次 check_video（video_id=${videoId}）继续查，不要停。`
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
        serverInfo: { name: 'qingniao-media', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    const args = req.params?.arguments ?? {}
    try {
      const fn = { generate_image: generateImage, create_video: createVideo, check_video: checkVideo }[name]
      if (!fn) throw new Error('未知工具：' + name)
      send({ jsonrpc: '2.0', id, result: imgResult(await fn(args)) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: imgResult('调用失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
