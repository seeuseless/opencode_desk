import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/** AI 回复的 Markdown 渲染：GFM（表格/删除线/任务列表）+ 代码高亮（配色走主题变量） */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
