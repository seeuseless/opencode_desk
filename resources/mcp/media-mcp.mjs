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
import { authorize, deniedText, markUsed } from './gate.mjs'

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

/**
 * 失败回执：打成 isError，内核据此把这一步标成「工具失败」。
 *
 * 为什么要区分：一直用普通文本回错误时，模型把「创建视频任务失败」当成一次普通结果，
 * 接着换参数再试——实测就是这么连着试了 100+ 次。isError 是内核与模型都能看见的硬信号。
 */
const errResult = (t) => ({ __err: true, text: t })
const resOf = (v) =>
  v && typeof v === 'object' && v.__err
    ? { content: [{ type: 'text', text: v.text }], isError: true }
    : { content: [{ type: 'text', text: String(v) }] }
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

/**
 * 生成任务熔断 —— 机械刹车，不指望模型自觉。
 *
 * 为什么必须有（2026-09-21 实测）：视频创建被限流后，模型收到
 * `HTTP 429 您已达到免费用户的 API 速率限制` 并没有停，而是在 **7 分钟里换提示词、
 * 换 mode、换模型连续重试了 100+ 次**（10:30:21 → 10:37:44），每一发都真打到了服务端。
 * 回执里就算写「请勿重试」也拦不住——所以这里按生成目标记账：一旦判定为不可恢复的失败，
 * 后续调用直接拒绝，连请求都不发。
 *
 * 分档（越不可恢复，熔断越久）：
 *   quota —— 429 限流 / 402 欠费 / 401·403 鉴权：重试毫无意义，长熔断并要求立刻停手；
 *   net   —— 连接层失败（fetch failed）：短熔断，等网络缓过来；
 *   other —— 其他 4xx/5xx：中熔断，避免无脑刷。
 */
const BREAK_RULES = [
  {
    kind: 'quota',
    ms: 10 * 60_000,
    label: '配额 / 限流',
    re: /HTTP\s*429|HTTP\s*402|HTTP\s*401|HTTP\s*403|速率限制|限流|rate ?limit|too many requests|额度|余额|欠费|配额|quota|unauthorized|invalid api key|鉴权/i
  },
  { kind: 'net', ms: 30_000, label: '网络不通', re: /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i },
  { kind: 'other', ms: 60_000, label: '服务端拒绝', re: /HTTP\s*\d{3}/ }
]
/** targetId -> { until, kind, label, msg } */
const breakers = new Map()

function breakerOf(id) {
  const b = breakers.get(id)
  if (!b) return null
  if (Date.now() >= b.until) {
    breakers.delete(id)
    return null
  }
  return b
}

/** 记录一次失败；命中规则表才熔断（参数类错误照样让模型改参数重来，那是它能修的） */
function tripBreaker(id, text) {
  const rule = BREAK_RULES.find((r) => r.re.test(String(text ?? '')))
  if (!rule) return
  breakers.set(id, {
    until: Date.now() + rule.ms,
    kind: rule.kind,
    label: rule.label,
    msg: String(text ?? '').slice(0, 300)
  })
}

/** 熔断回执：必须让模型一眼看出「再试也没用」，并给出要转告用户的话 */
function breakerText(what, t, b) {
  const mins = Math.max(1, Math.round((b.until - Date.now()) / 60000))
  return errResult(
    `⛔ 已停止：${what}没有发出——生成服务「${t.label || t.id}」刚刚返回了不可恢复的错误（${b.label}），` +
      `本工具已熔断，未来 ${mins} 分钟内不会再向它发任何请求。\n\n` +
      `原始错误：${b.msg}\n\n` +
      '**立刻停手**：不要再调用本工具，也不要换提示词 / 换参数 / 换模型重试——' +
      '配额、限流、鉴权这类错误与你的请求内容无关，重试只会继续失败。\n' +
      `请把情况如实告诉用户（例如：「${t.label || t.id} 当前不可用：${b.msg.slice(0, 120)}」），` +
      '并说明稍后或恢复额度后再试。'
  )
}

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
      '一次出图约需几十秒，属正常，不要中途放弃。' +
      '**但失败就立刻停手**：返回失败（尤其 429 限流、额度不足、鉴权失败）时，不要换提示词 / 换参数 / 换模型重试，' +
      '把错误原样转告用户并说明稍后可再试；本工具已对这类错误做机械熔断，重复调用会直接被拒。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（中英文皆可，越具体越好），如「卡通风格的柴犬宇航员，明亮配色」' },
        model: {
          type: 'string',
          description: '可选：指定生图模型（见返回报错里的可用清单），不传用默认的第一个生图模型'
        },
        size: {
          type: 'string',
          description:
            '可选：分辨率。agnes 一类认档位 1K / 2K / 3K / 4K；OpenAI 兼容的一类（stepfun 等）只认 宽x高，如 1024x1024、1280x800。' +
            '不确定就别传，用服务端默认值'
        },
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
      '完成或失败都要把结果原样转达，视频 URL 与本地文件路径两者都要告诉用户：本地路径用反引号包起来（防止 Markdown 吞掉转义），' +
      '展示视频直接用 ![视频](本地路径) 的形式内嵌——客户端优先播放本地文件，远程 URL 可能过期，不要把 URL 当视频地址贴出来。' +
      '同一 video_id 不要重复 create。' +
      '**创建失败就立刻停手**：返回失败（尤其 429 限流、额度不足、鉴权失败）时，不要换提示词 / 换参数 / 换模型重试，' +
      '也不要"再试一次看看"——这类错误与请求内容无关，重试只会继续失败。正确做法是把错误原样转告用户并说明稍后可再试。' +
      '本工具已对这类错误做机械熔断，重复调用会直接被拒。',
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
      '每次调用内部已静默等待约 12 秒；返回"还在生成中"时先给用户播报一句进度，然后立即再调本工具，直到完成或失败。' +
      '**失败或"已停止查询"就停下**：不要重查、不要重新创建同一个任务，把原因如实告诉用户。' +
      '完成时把结果原样转达，并直接用 ![视频](本地路径) 的形式内嵌本地文件路径展示（路径用反引号包住另一行给出）——客户端优先播放本地文件，远程 URL 可能过期。',
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

/** 只有「宽x高」这种尺寸才敢往 OpenAI 兼容形态里塞：各家档位值域不同，1K/2K 送过去多半 400 */
function whSize(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '')
  return /^\d+x\d+$/.test(s) ? s : ''
}

/** 参考图取字节：data URL 直接解，http(s) 先拉下来（multipart 上传只吃文件内容） */
async function refBytes(ref) {
  const s = String(ref ?? '')
  const m = s.match(/^data:([^;,]+)[^,]*;base64,(.*)$/is)
  if (m) return { buf: Buffer.from(m[2], 'base64'), mime: m[1] || 'image/png' }
  if (/^https?:/i.test(s)) {
    try {
      const r = await fetch(s, { signal: AbortSignal.timeout(60000) })
      if (!r.ok) return null
      return { buf: Buffer.from(await r.arrayBuffer()), mime: (r.headers.get('content-type') || 'image/png').split(';')[0] }
    } catch {
      return null
    }
  }
  return null
}

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' }

/**
 * 生图请求的几种形态，依次试：
 * ① agnes——参考图放 extra_body.image，尺寸是 1K/2K 档位、宽高比单列一个 ratio；
 * ② OpenAI 兼容（stepfun 等）——response_format 在顶层，未知字段按各家网关脾气，
 *    所以只送 model/prompt/size，档位尺寸和 ratio 这种 agnes 说法一概不发；
 * ③ 图片编辑——改图的通用约定是 multipart 上传到 /images/edits（stepfun 的图生图只认这条）。
 * 问通的那种记在 imgShapePicks 上，后续直接用，不再每次都撞前两堵墙。
 */
function imageAttempts(t, args, prompt, imgs) {
  const base = t.baseURL.replace(/\/+$/, '')
  const out = []
  const agnes = { model: t.model, prompt, extra_body: { response_format: 'url' } }
  if (args.size) agnes.size = String(args.size)
  if (args.ratio) agnes.ratio = String(args.ratio)
  if (imgs.length) agnes.extra_body.image = imgs
  out.push({ name: 'agnes', url: base + '/images/generations', json: agnes })
  const plain = { model: t.model, prompt, response_format: 'url' }
  const wh = whSize(args.size)
  if (wh) plain.size = wh
  if (imgs.length) plain.image = imgs.length === 1 ? imgs[0] : imgs
  out.push({ name: 'openai', url: base + '/images/generations', json: plain })
  if (imgs.length) {
    out.push({
      name: 'edits',
      url: base + '/images/edits',
      prompt,
      // 多数家的编辑接口一次只吃一张参考图，第二张起就不送了（返回里会说明）
      refs: imgs.slice(0, 1),
      extra: imgs.slice(1)
    })
  }
  return out
}

async function runImageAttempt(t, att) {
  const init = { method: 'POST', signal: AbortSignal.timeout(300000) }
  if (att.refs) {
    const form = new FormData()
    form.append('model', t.model)
    form.append('prompt', String(att.prompt))
    form.append('response_format', 'url')
    for (const ref of att.refs) {
      const b = await refBytes(ref)
      if (!b) return { error: '参考图取不到内容（外链拉不下来或 data URL 解析失败）' }
      form.append('image', new Blob([b.buf], { type: b.mime }), 'ref.' + (MIME_EXT[b.mime] ?? 'png'))
    }
    init.body = form // 不设 content-type：fetch 要自己带 multipart boundary
  } else {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(att.json)
  }
  let res
  try {
    // **展开顺序有讲究**：`...init` 里带着上面刚设的 `headers`（content-type），
    // 写在 authorization 后面会把它整块覆盖掉 → 请求不带令牌，服务端一律 401「未提供令牌」
    // （实测 agnes 生图就是被这个坑到：工具挂得好好的，一调就是 401）。
    // 所以先展开 init，再单独盖一层 headers，两边合并。
    res = await fetch(att.url, { ...init, headers: { ...(init.headers ?? {}), authorization: 'Bearer ' + t.apiKey } })
  } catch (e) {
    return { error: `请求发不出去：${e?.message ?? e}` }
  }
  const text = await res.text().catch(() => '')
  let j = null
  try {
    j = JSON.parse(text)
  } catch {
    /* 非 JSON 错误体，原样带给模型 */
  }
  if (!res.ok)
    return { error: `HTTP ${res.status}：${j?.error?.message ?? j?.detail ?? j?.message ?? text.slice(0, 200)}` }
  const item = j?.data?.[0] ?? {}
  return { url: item.url ?? '', b64: item.b64_json ?? '', text }
}

/** 问通的请求形态（按目标记账） */
const imgShapePicks = new Map()

async function generateImage(args) {
  if (!IMAGE_TARGETS.length) return errResult('未配置任何生图模型。请在 设置 → 模型 添加/启用一个带生图模型（如 agnes-image-*）的提供商，保存并重启内核后重试。')
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return errResult('prompt 不能为空：请传入画面描述')
  const t = pickTarget(IMAGE_TARGETS, args.model)
  if (!t) return errResult('找不到生图模型「' + args.model + '」。可用：' + IMAGE_TARGETS.map((x) => x.id).join('、'))
  // 熔断检查先于授权：注定要被拒的调用不该再弹一次确认卡片
  const tripped = breakerOf(t.id)
  if (tripped) return breakerText('生图任务', t, tripped)
  // 出图要调用**另一个模型**（往往还是另一家、另一份计费），先问过用户
  const who = { role: 'image', id: t.id, label: t.label || t.id, provider: t.provider }
  const grant = await authorize(who)
  if (!grant.allowed) return errResult(deniedText(who, grant))

  const refs = normalizeWithReport(args.image)
  // 素材全丢了还照样出图的话，模型以为改图成功，用户拿到的却是另一回事——必须拦下来
  if (Array.isArray(args.image) && args.image.length && !refs.ok.length)
    return errResult(
      '参考图全部处理失败，无法改图：\n' + refs.dropped.join('\n') +
      '\n请确认附件路径原样填在这里（用户消息里 [Attached image/png: 路径] 的那段路径），或改用公开可访问的 URL。'
    )
  const imgs = refs.ok
  let attempts = imageAttempts(t, args, prompt, imgs)
  const hit = imgShapePicks.get(t.id)
  if (hit) attempts = [attempts.find((a) => a.name === hit), ...attempts.filter((a) => a.name !== hit)].filter(Boolean)

  const errs = []
  for (const att of attempts) {
    const r = await runImageAttempt(t, att)
    if (r.error) {
      errs.push(`〔${att.name}〕${r.error}`)
      // 限流 / 欠费 / 鉴权这类错误跟「用哪种请求形态」无关，换形态再试同样会被拒——
      // 熔断后立刻跳出循环，别再一个形态一个形态地撞。
      tripBreaker(t.id, r.error)
      if (breakerOf(t.id)) break
      continue
    }
    let ext = 'png'
    let file = null
    if (r.url) {
      const m = r.url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i)
      if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg')
      // 外链随时可能过期，落一份本地文件兜底
      file = await saveRemote(r.url, ext)
    } else if (r.b64) {
      if (/^\/9j\/|^data:image\/jpe?g/i.test(r.b64)) ext = 'jpg'
      try {
        mkdirSync(OUT_DIR, { recursive: true })
        file = join(OUT_DIR, outName(ext))
        writeFileSync(file, Buffer.from(r.b64, 'base64'))
      } catch (e) {
        file = null
      }
    } else {
      errs.push(`〔${att.name}〕返回里没有 url 也没有 b64_json：${r.text.slice(0, 200)}`)
      continue
    }
    imgShapePicks.set(t.id, att.name)
    await markUsed(who)
    // 回执要说清「这张图是谁家出的」：用户往往在 A 家聊天、B 家出图，
    // 只报模型名他还要自己回想是哪个提供商；t.provider 由主进程注入（见 config.ts 的 pick）。
    const parts = [`生图成功（生图由 ${t.provider || t.id} 提供，模型 ${t.label || t.id}）：`]
    if (r.url) parts.push(`图片 URL：${r.url}`)
    if (file) parts.push(`本地文件：${file}`)
    else parts.push(r.url ? '（外链下载失败，只有 URL 可用，注意它可能过期）' : '（本地文件写入失败，只拿到了 base64）')
    if (att.extra?.length) parts.push(`（注意：改图接口只接受一张参考图，多出的 ${att.extra.length} 张未使用）`)
    if (refs.dropped.length) parts.push(`（注意：以下参考图没能用上：${refs.dropped.join('；')}）`)
    if (file)
      parts.push(
        '（生成的图保存在上面这条本地路径里，直接把路径告诉用户即可：' +
          `mode="image" 或 "file"，files 填上面这条本地路径，然后到目标窗口按 Ctrl+V。` +
          '**不要用识图工具去「看」自己刚生成的图**，你不需要看见画面，路径就是全部证据。）'
      )
    return parts.join('\n')
  }
  const trippedNow = breakerOf(t.id)
  return errResult(
    `生图失败（${t.label || t.id}）：\n${errs.join('\n')}\n` +
      (trippedNow
        ? `\n⛔ 已自动熔断（${trippedNow.label}）：${Math.max(1, Math.round((trippedNow.until - Date.now()) / 60000))} 分钟内不再尝试生图。` +
          '**不要重试**——换提示词、换参数、换模型都不会改变结果。请把错误如实转告用户，说明稍后或恢复额度后再试。'
        : '已依次试过 agnes 形态、OpenAI 兼容形态' +
          (imgs.length ? '与图片编辑（/images/edits）三种接口' : '两种接口') +
          '。请检查 Base URL、API Key 与该模型的生图接口文档，并如实告知用户，不要连续重复调用。')
  )
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

/**
 * 任务查询地址候选：创建任务各家都是 POST {baseURL}/videos，但查询进度没有统一约定。
 * 提供商里填过的模板（QN 目标上的 poll）最优先，其次 agnes 的 /agnesapi，再试 OpenAI 兼容的 /videos/{id}。
 * 模板占位符：{origin} {baseURL} {video_id} {model}。
 */
function pollUrls(t, videoId) {
  const base = t.baseURL.replace(/\/+$/, '')
  const enc = encodeURIComponent
  const urls = []
  if (t.poll)
    urls.push(
      String(t.poll)
        .replace(/\{origin\}/g, originOf(base))
        .replace(/\{baseURL\}/g, base)
        .replace(/\{video_id\}/g, enc(videoId))
        .replace(/\{model\}/g, enc(t.model))
    )
  urls.push(`${originOf(base)}/agnesapi?video_id=${enc(videoId)}&model_name=${enc(t.model)}`)
  urls.push(`${base}/videos/${enc(videoId)}`)
  return [...new Set(urls)]
}

/** 探出来的可用查询地址（按目标记账）：一次出片要轮几十次，不该每次都把候选重问一遍 */
const pollPicks = new Map()

/** 查一次任务状态：候选地址依次问，问通的那个记下来；全问不通才把最后一次失败原因报出去 */
async function pollJob(t, videoId) {
  const urls = pollUrls(t, videoId)
  const hit = pollPicks.get(t.id)
  const order = hit ? [hit, ...urls.filter((u) => u !== hit)] : urls
  let err = ''
  for (const url of order) {
    let r
    try {
      r = await apiFetch(t, url, { method: 'GET', signal: AbortSignal.timeout(20000) })
    } catch (e) {
      err = err || `${url} —— ${e?.message ?? e}`
      continue
    }
    if (r.ok) {
      pollPicks.set(t.id, url)
      return { job: r.j ?? {} }
    }
    err = err || `${url} —— HTTP ${r.status}：${r.j?.error?.message ?? r.j?.detail ?? r.j?.message ?? r.text.slice(0, 200)}`
  }
  return { error: err }
}

/** 不给直链的各家实现（OpenAI 兼容那套）把成品挂在 /videos/{id}/content 上回字节流 */
async function saveVideoContent(t, videoId) {
  const url = t.baseURL.replace(/\/+$/, '') + '/videos/' + encodeURIComponent(videoId) + '/content'
  try {
    const res = await fetch(url, { headers: { authorization: 'Bearer ' + t.apiKey }, signal: AbortSignal.timeout(180000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return null
    mkdirSync(OUT_DIR, { recursive: true })
    const file = join(OUT_DIR, outName('mp4'))
    writeFileSync(file, buf)
    return file
  } catch {
    return null
  }
}

/**
 * mode 取值各家不统一：agnes-video-2.5-* 认 text / reference / keyframe，
 * 而 agnes-video-v2.0 只认 ti2vid / keyframes / multi_reference——
 * 填错直接 400（实测就是这个把任务挡在门外的：`Input should be 'ti2vid', 'keyframes' or 'multi_reference'`）。
 *
 * 这里按语义做候选映射，并且**从服务端的 400 文案里学一次合法值**（它把枚举原样列了出来），
 * 学到的按模型记下来，后续同模型直接命中，不再撞第二遍。
 */
const MODE_ALIAS = {
  text: ['text', 'ti2vid', 'txt2vid', 'text2video', 't2v'],
  reference: ['reference', 'multi_reference', 'multireference', 'image2video', 'ref'],
  keyframe: ['keyframe', 'keyframes', 'first_last_frame', 'keyframe2video']
}
/** model -> { text, reference, keyframe } */
const modePicks = new Map()

/** 从「Input should be 'a', 'b' or 'c'」里学出合法枚举，回映射成我们的三种语义 */
function learnModes(model, text) {
  const m = String(text ?? '').match(/Input should be\s+(.+)/i)
  if (!m) return null
  const allowed = [...m[1].matchAll(/'([a-z0-9_]+)'/gi)].map((x) => x[1].toLowerCase())
  if (!allowed.length) return null
  const map = {}
  for (const [sem, cands] of Object.entries(MODE_ALIAS)) map[sem] = cands.find((c) => allowed.includes(c)) ?? ''
  modePicks.set(model, map)
  return map
}

function modeFor(model, semantic) {
  return modePicks.get(model)?.[semantic] || semantic
}

async function createVideo(args) {
  if (!VIDEO_TARGETS.length) return errResult('未配置任何生视频模型。请在 设置 → 模型 添加/启用一个带生视频模型（如 agnes-video-*）的提供商，保存并重启内核后重试。')
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return errResult('prompt 不能为空：请传入视频内容描述')
  const t = pickTarget(VIDEO_TARGETS, args.model)
  if (!t) return errResult('找不到生视频模型「' + args.model + '」。可用：' + VIDEO_TARGETS.map((x) => x.id).join('、'))

  // 出片同样是调另一个模型、另一份计费，先问过用户。
  // 注意**只在创建时问**：check_video 只是轮询同一个任务的进度（同一模型、同一次消费），
  // 再问一遍会让用户为同一件事反复点确认。
  const who = { role: 'video', id: t.id, label: t.label || t.id, provider: t.provider }
  const grant = await authorize(who)
  if (!grant.allowed) return deniedText(who, grant)

  // 熔断检查放在最前面（连授权都不问：注定要拒的调用不该再弹一次确认卡片打扰用户）
  const tripped = breakerOf(t.id)
  if (tripped) return breakerText('创建视频任务', t, tripped)

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
    return errResult('参考素材全部处理失败，无法按素材生成：\n' + dropped.join('\n') + '\n请改用公开可访问的 URL，或先确认文件在本地存在。')
  // 三种模式互斥：首尾帧（keyframe）优先，否则只要带了任一参考素材就走 reference
  let semantic = 'text'
  if (ff || lf) {
    semantic = 'keyframe'
    if (ff) body.first_frame = ff
    if (lf) body.last_frame = lf
  } else if (im.ok.length || au.ok.length || vi.ok.length) {
    semantic = 'reference'
    if (im.ok.length) body.images = im.ok.slice(0, 5)
    if (au.ok.length) body.audios = au.ok.slice(0, 3)
    if (vi.ok.length) body.videos = vi.ok.slice(0, 5)
  }
  body.mode = modeFor(t.model, semantic)

  const post = () =>
    apiFetch(t, t.baseURL.replace(/\/+$/, '') + '/videos', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    })
  let r = await post()
  // 400 且服务端把合法枚举列了出来 = 只是 mode 用词不同（各家各叫各的）。
  // 学到正确取值后**只重发一次**——这是参数适配，不是盲目重试。
  if (!r.ok && r.status === 400) {
    const raw = String(r.j?.error?.message ?? r.j?.message ?? r.text ?? '')
    const learned = learnModes(t.model, raw)
    if (learned && learned[semantic] && learned[semantic] !== body.mode) {
      body.mode = learned[semantic]
      r = await post()
    }
  }
  if (!r.ok) {
    const detail = String(r.j?.error?.message ?? r.j?.detail ?? r.j?.message ?? r.text ?? '').slice(0, 300)
    const msg = `创建视频任务失败（${t.label || t.id}，HTTP ${r.status}）：${detail}`
    tripBreaker(t.id, `HTTP ${r.status} ${detail}`)
    const trippedNow = breakerOf(t.id)
    return errResult(
      msg +
        (trippedNow
          ? `\n\n⛔ 已自动熔断（${trippedNow.label}）：现在起 ${Math.max(1, Math.round((trippedNow.until - Date.now()) / 60000))} 分钟内不再尝试创建视频。\n` +
            '**不要重试**（换提示词 / 换参数 / 换模型都没用），把上面这句错误如实转告用户，说明稍后或恢复额度后再试。'
          : '\n\n请先检查传参（提示词、时长、画幅）后如实告知用户，不要连续重复调用。')
    )
  }
  const videoId = r.j?.video_id ?? r.j?.id ?? r.j?.data?.video_id ?? r.j?.data?.id ?? r.j?.task_id
  if (!videoId) return errResult('创建视频任务返回异常：响应里没有 video_id。原始返回：' + r.text.slice(0, 300))
  const warn = dropped.length ? `\n注意：以下素材没能用上（已按其余素材生成）：${dropped.join('；')}` : ''
  await markUsed(who)
  return (
    `视频任务已创建（生视频由 ${t.provider || t.id} 提供，模型 ${t.label || t.id}，mode=${body.mode}）：` +
    `video_id=${videoId}。出片通常要几分钟：请告知用户"视频生成中"，` +
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

/** videoId -> 连续查询失败次数。查询端点不通时模型会一直重查，这里兜住（3 次即停） */
const pollFails = new Map()

async function checkVideo(args) {
  if (!VIDEO_TARGETS.length) return errResult('未配置任何生视频模型，无法查询。')
  const videoId = String(args.video_id ?? '').trim()
  if (!videoId) return errResult('video_id 不能为空')
  const t = pickTarget(VIDEO_TARGETS, args.model)
  if (!t) return errResult('找不到生视频模型「' + args.model + '」。可用：' + VIDEO_TARGETS.map((x) => x.id).join('、'))

  // 单次查询内部最多等 ~12 秒（4 次 × 3s）就返回"还在生成中"——短轮询让模型能在两次调用之间
  // 给用户播报进度，挂 50 秒没反馈反而诱导用户点停止把回合打断
  let last = null
  for (let i = 0; i < 4; i++) {
    const r = await pollJob(t, videoId)
    if (r.error) {
      const n = (pollFails.get(videoId) ?? 0) + 1
      pollFails.set(videoId, n)
      if (n >= 3)
        return errResult(
          `⛔ 已停止查询：video_id=${videoId} 连续 ${n} 次查询都失败，再查下去不会有新结果。\n` +
            `最后一次原因：${r.error}\n` +
            '请停手，如实告诉用户「任务已提交但查询失败，请稍后在生成服务的后台或稍后再试」，不要继续轮询。'
        )
      return errResult(
        `查询失败（第 ${n}/3 次）：${r.error}。已按默认识别的两种形态依次问过（{origin}/agnesapi、{baseURL}/videos/{{video_id}}）；` +
          '若该提供商的查询端点不长这样，请在 设置 → 模型 的提供商表单里填「生视频任务查询地址」。' +
          '**不要连续重查**：先把这个情况告诉用户。'
      )
    }
    pollFails.delete(videoId)
    last = r.job
    const status = String(last.status ?? last.state ?? '').toLowerCase()
    if (status === 'failed' || status === 'error')
      return errResult(`视频生成失败：${last.error ?? last.message ?? last.detail ?? JSON.stringify(last).slice(0, 400)}\n\n请把原因如实转告用户，不要重新创建同一个任务。`)
    const file = findVideoUrl(last)
    if (status === 'completed' || (status !== 'queued' && status !== 'processing' && file)) {
      // 直链可能压根没有（各家约定不同），也可能已经过期；两种情况都退到 content 端点把成品拉回来
      const local = (file ? await saveRemote(file, 'mp4') : null) || (await saveVideoContent(t, videoId))
      const parts = [
        `视频已完成（生视频由 ${t.provider || t.id} 提供，模型 ${t.label || t.id}，video_id=${videoId}）：`,
        file ? `视频 URL：${file}` : '视频 URL：（响应里没有直链，成品已按任务查询端点下载）'
      ]
      if (local) parts.push(`本地文件：${local}`)
      else parts.push(`（没能拿到成品文件，原始返回：${JSON.stringify(last).slice(0, 400)}）`)
      if (local)
        parts.push(
          '（把它**发给别人**超出了本应用的能力范围：请把上面这条本地路径告诉用户，由用户自行发送。）'
        )
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
      send({ jsonrpc: '2.0', id, result: resOf(await fn(args)) })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: resOf(errResult('调用失败：' + (e?.message ?? e))) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
