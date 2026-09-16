import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'

export interface ModelGroup {
  id: string
  label: string
  models: { mid: string }[]
}

interface Props {
  groups: ModelGroup[]
  /** 'providerID/modelID' */
  value: string
  onChange: (v: string) => void
}

/** 二级级联模型菜单：默认只显示一级提供商，点击后展开二级模型列 */
export function ModelPicker({ groups, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState('')
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setExpanded('')
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const i = value.indexOf('/')
  const curGroup = i > 0 ? groups.find((g) => g.id === value.slice(0, i)) : undefined
  const curModel = curGroup && i > 0 ? curGroup.models.find((m) => m.mid === value.slice(i + 1)) : undefined
  // 列表尚未命中（如存档值待校正）时，直接按 'pid/mid' 原样显示，保证选中态始终是 模型/模型 格式
  const display =
    curGroup && curModel
      ? `${curGroup.label}/${curModel.mid}`
      : i > 0
        ? `${value.slice(0, i)}/${value.slice(i + 1)}`
        : '选择模型'
  const active = groups.find((g) => g.id === expanded)

  return (
    <div className="menu-wrap" ref={wrap}>
      <button type="button" className="menu-trigger" onClick={() => setOpen((v) => !v)}>
        <Sparkles size={14} />
        <span className="menu-label">{display}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && (
        <div className="menu-panel mp up">
          <div className="mp-col">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                className={'mp-item' + (g.id === active?.id ? ' on' : '')}
                onClick={() => setExpanded((v) => (v === g.id ? '' : g.id))}
              >
                <span className="mp-name">{g.label}</span>
                <ChevronRight size={13} className="mp-arrow" />
              </button>
            ))}
            {!groups.length && <div className="mp-empty">请先在设置添加提供商</div>}
          </div>
          {active && active.models.length > 0 && (
            <div className="mp-col2-float">
              {active.models.map((m) => (
                <button
                  key={m.mid}
                  type="button"
                  className="mp-item"
                  onClick={() => {
                    onChange(`${active.id}/${m.mid}`)
                    setOpen(false)
                  }}
                >
                  <span className="mi-check">{`${active.id}/${m.mid}` === value && <Check size={13} />}</span>
                  <span className="mp-name">{m.mid}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
