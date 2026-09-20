import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronDown } from 'lucide-react'
import type { ThinkingKind } from '../oc'

/**
 * 思考档位（内核 model variant）：默认 = 不传 variant，由内核/服务端决定；
 * 其余按选中的档位在发消息时带 `variant`，内核对应用户配置的 reasoningEffort。
 * 档位集合（kind）一律由模型自身能力自动判定（内核模型能力表，查不到按模型名猜），无需用户配置：
 * effort = 低/中/高；toggle = 开（怎么选都是"开思考"）；off = 不支持（选择器不可用）。
 */
export function ThinkingPicker({
  value,
  onChange,
  kind
}: {
  value: string
  onChange: (v: string) => void
  kind: ThinkingKind
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

  // 档位集合按模型能力定；存档值是别的能力下的档位名（如老模型存过 low）时，回落到默认
  const options: { key: string; label: string }[] =
    kind === 'toggle'
      ? [
          { key: '', label: '默认' },
          { key: 'on', label: '开' }
        ]
      : kind === 'off'
        ? [{ key: '', label: '不支持' }]
        : [
            { key: '', label: '默认' },
            { key: 'low', label: '低' },
            { key: 'medium', label: '中' },
            { key: 'high', label: '高' }
          ]
  const valid = options.some((o) => o.key === value)
  const cur = options.find((o) => o.key === (valid ? value : ''))!
  const disabled = kind === 'off'

  return (
    <div className="menu-wrap tp" ref={wrap}>
      <button
        type="button"
        className="menu-trigger"
        title={
          disabled
            ? '该模型按模型能力表（models.dev）判定为不支持思考，故思考档位不可用'
            : '思考档位：可选档位按模型自身能力自动判定（内核模型能力表 models.dev，查不到时按模型名推断）。「默认」= 不传思考参数，交由模型服务端决定'
        }
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Brain size={14} />
        <span className="menu-label">{cur.label}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && !disabled && (
        <div className="menu-panel tp up">
          {options.map((t) => (
            <button
              key={t.key}
              type="button"
              className={'menu-item' + (t.key === cur.key ? ' on' : '')}
              onClick={() => {
                onChange(t.key)
                setOpen(false)
              }}
            >
              <span className="mi-check">{t.key === cur.key && <Check size={13} />}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}