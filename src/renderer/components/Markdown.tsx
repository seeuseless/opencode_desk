import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy, Download } from 'lucide-react'

const VIDEO_RE = /\.(mp4|webm|mov|m4v|avi)(\?|#|$)/i
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i

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

/** 远程视频链接 → 内嵌播放器 + 保存；本地视频路径 → 纯文本 */
function VideoCard({ source, alt }: { source: string; alt?: ReactNode }) {
  if (!/^https?:\/\//i.test(source)) {
    return <PlainMediaText source={source} label={typeof alt === 'string' ? alt : undefined} />
  }
  return (
    <span className="md-video">
      <video src={source} controls preload="metadata" />
      <span className="md-video-bar">
        <span className="md-file-name" title={source}>{typeof alt === 'string' && alt ? alt : mediaName(source)}</span>
        <SaveButton source={source} label="保存视频" />
      </span>
    </span>
  )
}

function MdImage(props: {
  src?: string
  alt?: string
  node?: unknown
  onPreview: (src: string) => void
  [key: string]: unknown
}) {
  const { node, src, alt, onPreview, ...rest } = props
  const s = typeof src === 'string' ? src : ''
  const [broken, setBroken] = useState(false)
  if (!s || broken || isLocalPath(s)) {
    return <PlainMediaText source={s} label={alt} />
  }
  return (
    <span className="md-imgwrap">
      <img
        {...rest}
        src={s}
        alt={alt ?? ''}
        className="md-img"
        title="点击放大"
        onClick={() => onPreview(s)}
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
  onPreview: (src: string) => void
  [key: string]: unknown
}) {
  const { node, href, children, onPreview, ...rest } = props
  const h = typeof href === 'string' ? href : ''
  if (VIDEO_RE.test(h)) return <VideoCard source={h} />
  if (IMG_RE.test(h)) {
    return (
      <MdImage
        src={h}
        alt={typeof children === 'string' ? children : undefined}
        onPreview={onPreview}
      />
    )
  }
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

  const components: Components = {
    pre: CodeBlockWrap,
    img: (p) => <MdImage {...(p as Record<string, unknown>)} onPreview={onPreview} />,
    a: (p) => <MdLink {...(p as Record<string, unknown>)} onPreview={onPreview} />
  }

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={(u) => u}
        components={components}
      >
        {text}
      </ReactMarkdown>
      {preview ? (
        <div className="md-lightbox" onClick={() => setPreview(null)} title="点击任意处或按 Esc 关闭">
          <img src={preview} alt="" />
        </div>
      ) : null}
    </div>
  )
}
