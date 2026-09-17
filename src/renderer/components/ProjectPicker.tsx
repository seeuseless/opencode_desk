import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, FolderPlus } from 'lucide-react'
import type { Project } from './Sidebar'

interface Props {
  projects: Project[]
  value?: string
  onChange: (id: string) => void
  onPickDir: () => void
}

/** 项目级联下拉：按钮显示当前项目，面板显示项目列表 + 底部「选择本地文件夹」（border 效果），风格对齐 ModelPicker */
export function ProjectPicker({ projects, value, onChange, onPickDir }: Props) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const cur = value ? projects.find((p) => p.id === value) : undefined
  const display = cur ? cur.name : '选择项目'

  return (
    <div className="menu-wrap pp" ref={wrap}>
      <button type="button" className="menu-trigger pp" onClick={() => setOpen((v) => !v)}>
        <Folder size={14} />
        <span className="menu-label">{display}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && (
        <div className="menu-panel pp up">
          <div className="pp-col">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'pp-item' + (p.id === value ? ' on' : '')}
                title={p.path}
                onClick={() => {
                  onChange(p.id)
                  setOpen(false)
                }}
              >
                <span className="pp-check">{p.id === value && <Check size={13} />}</span>
                <span className="pp-name">{p.name}</span>
              </button>
            ))}
            <button
              type="button"
              className="pp-item pp-pick"
              onClick={() => {
                setOpen(false)
                onPickDir()
              }}
            >
              <FolderPlus size={14} className="pp-ico" />
              <span className="pp-name">选择本地文件夹</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
