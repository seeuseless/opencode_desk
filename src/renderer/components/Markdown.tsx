import { useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'

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

/** AI 回复的 Markdown 渲染：GFM（表格/删除线/任务列表）+ 代码高亮（配色走主题变量）+ 代码块复制 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ pre: CodeBlockWrap }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
