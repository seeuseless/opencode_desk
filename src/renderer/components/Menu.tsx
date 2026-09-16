import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface MenuOption {
  /** 'pid/mid' 或特殊值 ''（内核默认） */
  key: string
  label: string
  group?: string
}

/** 自绘下拉菜单（替代原生 select，样式随主题） */
export function Menu({
  icon,
  placeholder,
  value,
  options,
  onChange,
  up
}: {
  icon?: ReactNode
  placeholder: string
  value: string
  options: MenuOption[]
  onChange: (key: string) => void
  /** 面板向上弹出（用于页面底部输入框内） */
  up?: boolean
}) {
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

  const current = options.find((o) => o.key === value)
  // 按首次出现顺序分组
  const groups: { name?: string; items: MenuOption[] }[] = []
  for (const o of options) {
    const g = groups.find((x) => x.name === o.group)
    if (g) g.items.push(o)
    else groups.push({ name: o.group, items: [o] })
  }

  return (
    <div className="menu-wrap" ref={wrap}>
      <button type="button" className="menu-trigger" onClick={() => setOpen((v) => !v)}>
        {icon}
        <span className="menu-label">{current?.label ?? placeholder}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && (
        <div className={'menu-panel' + (up ? ' up' : '')}>
          {groups.map((g) => (
            <div key={g.name ?? '_'}>
              {g.name && <div className="menu-group">{g.name}</div>}
              {g.items.map((o) => (
                <button
                  type="button"
                  key={o.key || '__default'}
                  className="menu-item"
                  onClick={() => {
                    onChange(o.key)
                    setOpen(false)
                  }}
                >
                  <span className="mi-check">{o.key === value && <Check size={14} />}</span>
                  {o.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
