import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy, Download, ImageOff } from 'lucide-react'

const VIDEO_RE = /\.(mp4|webm|mov|m4v|avi)(\?|#|$)/i

function isLocalPath(u: string): boolean {
  return /^file:\/\//i.test(u) || /^[a-zA-Z]:[\\/]/.test(u) || /^\\\\/.test(u)
}

/** 从 URL 或本地路径里取展示用文件名 */
function mediaName(u: string): string {
  const p = u.replace(/^file:\/\/\/?/i, '').split(/[?#]/)[0]
  const seg = p.split(/[\\/]/).pop() ?? ''
  try {
    return decodeURIComponent(seg) || u
  } catch {
    return seg || u
  }
}

/** 围栏代码块容器：右上角悬浮复制按钮，点击复制整块代码文本 */
function CodeBlockWrap(props: { children?: ReactNode; node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const text = ref.current?.innerText ?? ''
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="md-code">
      <pre ref={ref}>{props.children}</pre>
      <button type="button" className={copied ? 'md-copy copied' : 'md-copy'} onClick={copy} title={copied ? '已复制' : '复制代码'}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}

/** 「保存」小按钮：走主进程另存为对话框（远程下载/本地复制），状态在按钮文字上短暂反馈 */
function SaveButton({ source, label = '保存' }: { source: string; label?: string }) {
  const [msg, setMsg] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const save = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (msg) return
    setMsg('…')
    const run = async () => {
      try {
        const err = await window.qingniao.saveMedia(source)
        if (err) {
          setMsg(err)
          setTimeout(() => setMsg(null), 2500)
        } else {
          setDone(true)
          setMsg(null)
          setTimeout(() => setDone(false), 1500)
        }
      } catch (err) {
        setMsg(String((err as Error).message ?? err))
        setTimeout(() => setMsg(null), 2500)
      }
    }
    void run()
  }
  return (
    <span className="md-save-wrap">
      <button type="button" className="md-btn" onClick={save} title="另存为本地文件">
        {done ? <Check size={13} /> : <Download size={13} />}
        {done ? '已保存' : label}
      </button>
      {msg && msg !== '…' ? <span className="md-hint">{msg}</span> : null}
    </span>
  )
}

/** 本地路径的媒体不做大肆渲染：dev 页面加载不了 file://，按用户要求只留纯文本，不给打开/保存按钮 */
function PlainMediaText({ source, label }: { source: string; label?: string }) {
  return (
    <span className="md-file-name" title={source}>
      {label || mediaName(source)}
    </span>
  )
}

/** 远程视频 → 内嵌播放器 + 保存；本地路径视频 → 纯文本 */
function VideoEmbed({ source }: { source: string }) {
  if (!/^https?:\/\//i.test(source)) {
    return <PlainMediaText source={source} />
  }
  return (
    <span className="md-video">
      <video src={source} controls preload="metadata" />
      <span className="md-video-bar">
        <span className="md-file-name" title={source}>{mediaName(source)}</span>
        <SaveButton source={source} label="保存视频" />
      </span>
    </span>
  )
}

const BARE_NAME_RE = /^[^\s/\\]+\.(png|jpe?g|gif|webp|bmp|avif)$/i

// 本地图片 data URL 缓存：路径唯一（每次生成新文件名），命中即同步出图，
// 组件重挂载/跨消息引用同一文件时不再「空白→重读→闪现」
const localMediaCache = new Map<string, string>()

/**
 * react-markdown 会按 CommonMark 对 img 目的地做规范化：反斜杠当转义符被吃掉或百分号编码
 * （`C:\a.png` → `c:%5Ca.png` / `C:a.png`），先还原成真实路径再判本地。
 */
function fixupSrc(s: string): string {
  if (!s || /^https?:|^data:/i.test(s)) return s
  let u = s
  try {
    if (/%5c/i.test(u)) u = decodeURIComponent(u)
  } catch {
    /* 保留原样 */
  }
  // 单反斜杠被 CommonMark 当转义吞掉（C:a.png）：盘符后补回分隔符，主进程按媒体目录解析
  if (/^[a-zA-Z]:(?![\\/])/.test(u) && !/^https?:/i.test(u)) u = u.slice(0, 2) + '/' + u.slice(2)
  return u
}

function MdImage(props: {
  src?: string
  alt?: string
  node?: unknown
  onPreview: (src: string) => void
  [key: string]: unknown
}) {
  const { node, src, alt, onPreview, ...rest } = props
  const s = fixupSrc(typeof src === 'string' ? src : '')
  const [broken, setBroken] = useState(false)
  const [localUrl, setLocalUrl] = useState(() => localMediaCache.get(s) ?? '')
  // 本地文件读取状态：pending 未回 / missing 文件不在（显示占位，不退回远程）
  const [localMissing, setLocalMissing] = useState(false)
  // 裸文件名（无目录）也走主进程读取：由媒体目录兜底解析；读不到则退回纯文本，不显示「不存在」占位
  const bareName = !isLocalPath(s) && BARE_NAME_RE.test(s)
  const local = isLocalPath(s) || bareName
  useEffect(() => {
    setLocalMissing(false)
    if (!local || typeof window.qingniao.readMedia !== 'function') return
    if (localMediaCache.has(s)) {
      setLocalUrl(localMediaCache.get(s) ?? '')
      return
    }
    setLocalUrl('')
    let on = true
    void window.qingniao
      .readMedia(s)
      .then((d) => {
        if (!on) return
        if (d) {
          localMediaCache.set(s, d)
          setLocalUrl(d)
        } else setLocalMissing(true)
      })
      .catch(() => {
        if (on) setLocalMissing(true)
      })
    return () => {
      on = false
    }
  }, [s, local])
  if (VIDEO_RE.test(s)) return <VideoEmbed source={s} />
  if (local && localMissing) {
    if (bareName) return <PlainMediaText source={s} label={alt} />
    return (
      <span className="md-img-missing" title={s}>
        <ImageOff size={14} />
        图片不存在（本地文件已删除或移动）
      </span>
    )
  }
  const eff = local ? localUrl : s
  if (!eff || broken) {
    return <PlainMediaText source={s} label={alt} />
  }
  return (
    <span className="md-imgwrap">
      <img
        {...rest}
        src={eff}
        alt={alt ?? ''}
        className="md-img"
        title="点击放大"
        onClick={() => onPreview(eff)}
        onError={() => setBroken(true)}
      />
      <span className="md-img-tools">
        <SaveButton source={s} />
      </span>
    </span>
  )
}

function MdLink(props: {
  href?: string
  children?: ReactNode
  node?: unknown
  [key: string]: unknown
}) {
  const { node, href, children, ...rest } = props
  const h = typeof href === 'string' ? href : ''
  return (
    <a
      {...rest}
      href={h || undefined}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault()
        if (!h || /^javascript:/i.test(h)) return
        if (/^https?:\/\//i.test(h)) void window.qingniao.openExternal(h)
        else void window.qingniao.openFolder(h)
      }}
    >
      {children}
    </a>
  )
}

/**
 * 媒体展示归一化（按文档顺序，围栏代码块不动）：
 * 1) 同一媒体只内嵌一次：首次出现归一化成内嵌图，重复出现降级成文字链接（AI 常「![图](url)+再给一遍 url」）；
 * 2) 远程图片与回复里的本地图路径按序配对，内嵌位改用本地文件——远程地址可能过期，图一律显示本地；
 * 3) 正文/行内代码里的裸本地图路径也直接转成内嵌图；已展示过的前面那份则补回反斜杠转义（防 Markdown 吃掉 "\."）。
 */
const CODE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/
const MEDIA_TOKEN =
  /!\[([^\]]*)\]\(<([^>]+)>\)|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]*)\]\(<([^>]+)>\)|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"'）\]】，。；：！？]+)/g
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|m4v|avi)(\?|#|$)/i
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i
// 本地图路径：只认盘符/UNC/file:// 三种开头；前面不能紧跟字母数字，避免把 https 里的 "s:/" 当盘符
const BARE_LOCAL_IMG =
  '(?<![a-zA-Z0-9])(?:file:\\/\\/\\/|[a-zA-Z]:[\\\\/]|\\\\\\\\)[^\\s`\'"<>|，。；：！？（）「」“”《》*?]*\\.(?:png|jpe?g|gif|webp|bmp|avif)(?![a-zA-Z0-9])'
// 裸图片文件名（无目录）：模型转述「本地文件：xxx.png」常剥掉目录，主进程按媒体目录兜底解析
const BARE_IMG_NAME =
  '(?<![a-zA-Z0-9_./\\\\-])[^\\s`\'"<>|，。；：！？（）「」“”《》*?:/\\\\]+\\.(?:png|jpe?g|gif|webp|bmp|avif)(?![a-zA-Z0-9])'
const LOCAL_IMG_RE = new RegExp(`${BARE_LOCAL_IMG}|${BARE_IMG_NAME}`, 'gi')
const LOCAL_IMG_ONE = new RegExp('^(?:' + BARE_LOCAL_IMG + '|' + BARE_IMG_NAME + ')$', 'i')
// 媒体 token 优先整体消费，剩下的才按裸本地路径/裸文件名处理
const COMBINED = new RegExp(`(?:${MEDIA_TOKEN.source})|(${BARE_LOCAL_IMG})|(${BARE_IMG_NAME})`, 'gi')

function isImgPath(u: string): boolean {
  return IMG_EXT_RE.test(u.split(/[?#]/)[0])
}
// 路径写进 ![](...) 目的地前先百分号编码反斜杠：CommonMark 会把 `\.` 的反斜杠当转义吞掉、
// 又把裸 `\` 重编码成 %5C，两头都不可控——预编码后原样进原样出，MdImage 端 decode 还原真实路径
function encodeLocalSrc(p: string): string {
  return p.replace(/\\/g, '%5C')
}
// 路径留在正文时把 \ 翻倍：Markdown 解析会把 "\." 当转义序列吞掉反斜杠
function escapeBs(p: string): string {
  return p.replace(/\\/g, '\\\\')
}

function normalizeMedia(text: string): string {
  const seen = new Set<string>()
  const taken = new Set<string>()
  const localImgs: string[] = text.match(LOCAL_IMG_RE) ?? []
  const baseOf = (p: string): string => p.split(/[\\/]/).pop() ?? p
  // 裸本地路径/文件名/行内代码路径的统一出口：没展示过就转内嵌图，展示过就还原文字（带转义）
  // 按文件名去重：同一张图可能先给全路径又给裸文件名，只显示一次
  const emitLocal = (p: string): string => {
    const b = baseOf(p)
    if (seen.has(p) || seen.has(b) || taken.has(p) || taken.has(b)) {
      seen.add(p)
      return escapeBs(p)
    }
    seen.add(p)
    seen.add(b)
    taken.add(p)
    return `![${mediaName(p)}](<${encodeLocalSrc(p)}>)`
  }
  return text
    .split(CODE_SPLIT)
    .map((seg, i) => {
      if (i % 2 === 1) {
        // 行内代码整体就是一个本地图路径：还没展示过就换成内嵌图；已展示就保持代码原样（代码内显示不会被转义吞）
        if (seg[0] === '`' && !seg.startsWith('```')) {
          const inner = seg.slice(1, -1)
          if (LOCAL_IMG_ONE.test(inner) && !seen.has(inner) && !taken.has(inner)) return emitLocal(inner)
        }
        return seg
      }
      return seg.replace(COMBINED, (m, ...rest) => {
        const args = rest as (string | undefined)[]
        const bare = args[9] ?? args[10]
        if (bare) return emitLocal(bare)
        const [a1, b1, a2, b2, a3, b3, a4, b4] = args
        let url = ''
        let label: string | undefined
        let kind = 0 // 0 内嵌图 1 链接 2 裸 URL
        if (a1 !== undefined) [url, label] = [b1 ?? '', a1]
        else if (a2 !== undefined) [url, label, kind] = [b2 ?? '', a2, 0]
        else if (a3 !== undefined) [url, label, kind] = [b3 ?? '', a3, 1]
        else if (a4 !== undefined) [url, label, kind] = [b4 ?? '', a4, 1]
        else [url, kind] = [args[8] ?? '', 2]
        let tail = ''
        if (kind === 2) {
          // 裸 URL 吃掉句尾标点（如 "...png."），剥掉后再比对，否则与内嵌 URL 对不上
          const t = /[.,;:!?)\]]+$/.exec(url)
          if (t) {
            tail = t[0]
            url = url.slice(0, url.length - tail.length)
          }
        }
        if (!MEDIA_EXT_RE.test(url)) return m
        const name = label?.trim() || mediaName(url)
        if (seen.has(url)) return kind === 0 ? `[${name}](<${url}>)` : m
        seen.add(url)
        if (isLocalPath(url)) {
          if (isImgPath(url)) {
            taken.add(url)
            seen.add(baseOf(url))
          }
          return `![${name}](<${encodeLocalSrc(url)}>)${tail}`
        }
        // 远程图 → 与回复中的本地图按顺序配对，只显示本地图
        if (isImgPath(url)) {
          const lp = localImgs.find((p) => !taken.has(p) && !seen.has(baseOf(p)))
          if (lp) {
            taken.add(lp)
            seen.add(lp)
            seen.add(baseOf(lp))
            return `![${name}](<${encodeLocalSrc(lp)}>)${tail}`
          }
          // 本地图已在别处展示过（如行内代码被转成图）→ 远程降级为链接，不再出第二张图
          if (localImgs.some((p) => taken.has(p))) {
            return `[${name}](<${url}>)${tail}`
          }
        }
        return `![${name}](<${url}>)${tail}`
      })
    })
    .join('')
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS: NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
  [rehypeHighlight, { detect: true, ignoreMissing: true }]
]
const IDENTITY_URL = (u: string) => u

/** AI 回复的 Markdown 渲染：GFM + 代码高亮 + 代码块复制 + 图片点击预览/保存 + 视频内嵌播放/保存 */
export function Markdown({ text }: { text: string }) {
  const [preview, setPreview] = useState<string | null>(null)
  const onPreview = useCallback((src: string) => setPreview(src), [])
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  // components 必须引用稳定：流式期间 24ms 一帧重渲染，若 img/a 是每次新建的内联函数，
  // React 会视为不同组件类型而整棵子树卸载重挂——图片每帧清空重载，界面持续闪烁
  const components: Components = useMemo(
    () => ({
      pre: CodeBlockWrap,
      img: (p) => <MdImage {...(p as Record<string, unknown>)} onPreview={onPreview} />,
      a: (p) => <MdLink {...(p as Record<string, unknown>)} onPreview={onPreview} />
    }),
    [onPreview]
  )

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={IDENTITY_URL}
        components={components}
      >
        {normalizeMedia(text)}
      </ReactMarkdown>
      {preview ? (
        <div className="md-lightbox" onClick={() => setPreview(null)} title="点击任意处或按 Esc 关闭">
          <img src={preview} alt="" />
        </div>
      ) : null}
    </div>
  )
}
