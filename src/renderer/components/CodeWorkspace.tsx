import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { loadLanguage, type LanguageName } from '@uiw/codemirror-extensions-langs'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'
import { tags as tg } from '@lezer/highlight'
import { FileCode2, X } from 'lucide-react'
import { t } from '../i18n'
import type { Project } from './Sidebar'

export interface CodeControls {
  canSave: boolean
  saving: boolean
  save: () => void
  reload: () => void
}

interface Props {
  project: Project
  filePath: string
  onActiveFile?: (path: string) => void
  onStatusChange?: (info: { path: string; status: string } | null) => void
  onControlsChange?: (controls: CodeControls | null) => void
  openFiles: string[]
  onOpenFilesChange?: (paths: string[]) => void
}

interface OpenFile {
  path: string
  content: string
  savedContent: string
  mtimeMs: number
}

const editorHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tg.comment, tg.lineComment, tg.blockComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [tg.keyword, tg.moduleKeyword, tg.controlKeyword], color: 'var(--code-keyword)' },
  { tag: [tg.string, tg.special(tg.string)], color: 'var(--code-string)' },
  { tag: [tg.number, tg.bool, tg.null, tg.atom], color: 'var(--code-number)' },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName)], color: 'var(--code-function)' },
  { tag: [tg.typeName, tg.className, tg.namespace], color: 'var(--code-type)' },
  { tag: [tg.variableName, tg.propertyName], color: 'var(--code-variable)' },
  { tag: [tg.operator, tg.punctuation, tg.separator], color: 'var(--code-punctuation)' },
  { tag: [tg.tagName], color: 'var(--code-keyword)' },
  { tag: [tg.attributeName], color: 'var(--code-function)' },
  { tag: [tg.invalid], color: 'var(--code-deleted)' }
]))

export function CodeWorkspace({ project, filePath, openFiles, onActiveFile, onStatusChange, onControlsChange, onOpenFilesChange }: Props) {
  const [files, setFiles] = useState<Record<string, OpenFile>>({})
  const [activePath, setActivePath] = useState(filePath)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  /** CodeMirror 实例：保存时直接取实时 doc——keydown 那一刻 React state 可能落后一帧 */
  const viewRef = useRef<EditorView | null>(null)
  const file = activePath ? files[activePath] ?? null : null
  const tabs = Object.values(files)
  const dirty = !!file && file.content !== file.savedContent

  useEffect(() => {
    onStatusChange?.(file ? { path: file.path, status: dirty ? t('未保存') : t('已保存') } : null)
    return () => onStatusChange?.(null)
  }, [file?.path, dirty, onStatusChange])

  useEffect(() => {
    setActivePath(filePath)
    const paths = openFiles.length > 0 ? openFiles : filePath ? [filePath] : []
    const missing = paths.filter((path) => !files[path])
    if (missing.length === 0) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setError('')
    void Promise.all(missing.map(async (path) => {
      try {
        const result = await window.qingniao.workspaceRead(project.path, path)
        return { path, result }
      } catch (e) {
        return { path, error: e instanceof Error ? e.message : String(e) }
      }
    })).then((results) => {
      if (!alive) return
      let firstError = ''
      setFiles((current) => {
        const next = { ...current }
        for (const item of results) {
          if ('error' in item) {
            if (item.error) firstError ||= item.error
            continue
          }
          next[item.path] = {
            path: item.path,
            content: item.result.content,
            savedContent: item.result.content,
            mtimeMs: item.result.mtimeMs
          }
        }
        return next
      })
      setError(firstError)
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [filePath, openFiles, project.path])

  const language = useMemo(() => {
    if (!file) return []
    const ext = file.path.includes('.') ? file.path.split('.').pop()!.toLowerCase() : 'text'
    return loadLanguage(ext as LanguageName) ?? []
  }, [file?.path])

  async function save(): Promise<boolean> {
    if (!activePath || saving) return false
    const savingPath = activePath
    const saved = files[savingPath]
    if (!saved) return false
    // 关键：Ctrl+S 那一刻 React state 的 content 可能落后编辑器一帧——最后一个字符的
    // onChange 还没 flush，按旧内容保存后 dirty 圆点仍在，用户得再按一次（实测）。
    // 所以保存前先从 CodeMirror 实例取实时 doc，同步回 state，再用它落盘。
    let content = saved.content
    const view = viewRef.current
    if (view) {
      const live = view.state.doc.toString()
      if (live !== content) {
        content = live
        setFiles((current) => {
          const cur = current[savingPath]
          if (!cur) return current
          return { ...current, [savingPath]: { ...cur, content: live } }
        })
      }
    }
    if (content === saved.savedContent) return false // 无改动
    const diskContent = content
    setError('')
    setSaving(true)
    try {
      const result = await window.qingniao.workspaceWrite(
        project.path,
        savingPath,
        diskContent,
        saved.mtimeMs
      )
      // 函数式更新且**绝不覆盖 content**：await IPC 往返期间用户还在继续输入，
      // 旧闭包快照直接展开会把期间的新输入整个回滚（实测：新建文件粘贴/快打后 Ctrl+S 内容截断）。
      // 只更新 savedContent 与 mtimeMs——保存期间新输入的部分仍正确地保持「未保存」状态
      setFiles((current) => {
        const cur = current[savingPath]
        if (!cur) return current
        return { ...current, [savingPath]: { ...cur, savedContent: diskContent, mtimeMs: result.mtimeMs } }
      })
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  /** Ctrl+N 新建文件：弹系统「另存为」对话框选路径（默认当前活动文件所在目录），创建后打开新 tab */
  async function newFile(): Promise<void> {
    if (saving) return
    const dir = file && file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
    try {
      const r = await window.qingniao.workspaceNewFile(project.path, dir)
      if (!r) return // 用户取消
      // 回读一次拿真实 mtimeMs：新建时空文件已在磁盘上，直接用 0 会导致保存时「文件已被修改」误判
      const result = await window.qingniao.workspaceRead(project.path, r.path)
      setFiles((current) => {
        if (current[r.path]) return current // 已在打开列表（重复新建同名）不覆盖内容
        return {
          ...current,
          [r.path]: {
            path: r.path,
            content: result.content,
            savedContent: result.content,
            mtimeMs: result.mtimeMs
          }
        }
      })
      setActivePath(r.path)
      onActiveFile?.(r.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!file) {
      onControlsChange?.(null)
      return
    }
    onControlsChange?.({
      canSave: dirty,
      saving,
      save: () => void save(),
      reload
    })
    return () => onControlsChange?.(null)
  }, [file?.path, dirty, saving, onControlsChange])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      // Ctrl+S 保存
      if (k === 's') {
        e.preventDefault()
        void save()
        return
      }
      // Ctrl+N 新建文件（弹保存路径对话框）
      if (k === 'n') {
        e.preventDefault()
        void newFile()
        return
      }
      // Ctrl+W 关闭当前 tab
      if (k === 'w') {
        e.preventDefault()
        if (activePath) closeTab(activePath)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [file?.path, dirty, saving, activePath])

  function openTab(path: string): void {
    setActivePath(path)
    onActiveFile?.(path)
  }

  function closeTab(path: string): void {
    const nextTabs = tabs.filter((item) => item.path !== path)
    onOpenFilesChange?.(openFiles.filter((item) => item !== path))
    setFiles((current) => {
      const next = { ...current }
      delete next[path]
      return next
    })
    if (path === activePath) {
      const next = nextTabs[nextTabs.length - 1]?.path ?? ''
      setActivePath(next)
      onActiveFile?.(next)
    }
  }

  function reload(): void {
    if (!file || saving) return
    const path = file.path
    setFiles((current) => {
      const next = { ...current }
      delete next[path]
      return next
    })
    setError('')
    setLoading(true)
    window.qingniao.workspaceRead(project.path, path)
      .then((result) => {
        setFiles((current) => ({
          ...current,
          [path]: {
            path,
            content: result.content,
            savedContent: result.content,
            mtimeMs: result.mtimeMs
          }
        }))
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  return (
    <section className="code-pane">
      {tabs.length > 0 && (
        <nav className="code-tabs" aria-label={t('已打开文件')}>
          {tabs.map((item) => (
            <button
              key={item.path}
              className={'code-tab' + (item.path === activePath ? ' on' : '')}
              title={item.path}
              onClick={() => openTab(item.path)}
            >
              <FileCode2 size={13} />
              <span>{item.path.split('/').pop()}</span>
              {item.content !== item.savedContent && <i className="code-tab-dirty" />}
              <span
                className="code-tab-close"
                role="button"
                tabIndex={0}
                title={t('关闭文件')}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(item.path)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    closeTab(item.path)
                  }
                }}
              >
                <X size={13} />
              </span>
            </button>
          ))}
        </nav>
      )}

      {!filePath ? (
        <div className="code-empty">
          <FileCode2 size={28} />
          <strong>{t('展开项目后点一个代码文件')}</strong>
          <span>{t('文件会在这里打开，可直接修改并保存')}</span>
        </div>
      ) : loading ? (
        <div className="code-empty">{t('正在读取文件…')}</div>
      ) : file ? (
        <CodeMirror
          key={file.path}
          className="code-mirror"
          value={file.content}
          height="100%"
          theme="none"
          extensions={[language, editorHighlight]}
          onCreateEditor={(view) => { viewRef.current = view }}
          onChange={(content) => {
            setFiles((current) => ({
              ...current,
              [file.path]: { ...file, content }
            }))
          }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            autocompletion: true,
            bracketMatching: true,
            closeBrackets: true
          }}
        />
      ) : (
        <div className="code-empty code-error">{error || t('文件读取失败')}</div>
      )}
      {error && file && <div className="code-status error">{error}</div>}
    </section>
  )
}
