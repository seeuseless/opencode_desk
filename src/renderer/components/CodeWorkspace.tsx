import { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { loadLanguage, type LanguageName } from '@uiw/codemirror-extensions-langs'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { FileCode2, X } from 'lucide-react'
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
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--code-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--code-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--code-type)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--code-variable)' },
  { tag: [t.operator, t.punctuation, t.separator], color: 'var(--code-punctuation)' },
  { tag: [t.tagName], color: 'var(--code-keyword)' },
  { tag: [t.attributeName], color: 'var(--code-function)' },
  { tag: [t.invalid], color: 'var(--code-deleted)' }
]))

export function CodeWorkspace({ project, filePath, openFiles, onActiveFile, onStatusChange, onControlsChange, onOpenFilesChange }: Props) {
  const [files, setFiles] = useState<Record<string, OpenFile>>({})
  const [activePath, setActivePath] = useState(filePath)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const file = activePath ? files[activePath] ?? null : null
  const tabs = Object.values(files)
  const dirty = !!file && file.content !== file.savedContent

  useEffect(() => {
    onStatusChange?.(file ? { path: file.path, status: dirty ? '未保存' : '已保存' } : null)
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
    if (!file || !dirty || saving) return false
    setSaving(true)
    setError('')
    try {
      const result = await window.qingniao.workspaceWrite(
        project.path,
        file.path,
        file.content,
        file.mtimeMs
      )
      setFiles((current) => ({
        ...current,
        [file.path]: { ...file, savedContent: file.content, mtimeMs: result.mtimeMs }
      }))
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setSaving(false)
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
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      void save()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [file?.path, dirty, saving])

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
        <nav className="code-tabs" aria-label="已打开文件">
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
                title="关闭文件"
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
          <strong>展开项目后点一个代码文件</strong>
          <span>文件会在这里打开，可直接修改并保存</span>
        </div>
      ) : loading ? (
        <div className="code-empty">正在读取文件…</div>
      ) : file ? (
        <CodeMirror
          key={file.path}
          className="code-mirror"
          value={file.content}
          height="100%"
          theme="none"
          extensions={[language, editorHighlight]}
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
        <div className="code-empty code-error">{error || '文件读取失败'}</div>
      )}
      {error && file && <div className="code-status error">{error}</div>}
    </section>
  )
}
