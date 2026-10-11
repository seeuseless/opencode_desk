import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronDown } from 'lucide-react'
import { t } from '../i18n'
import type { ThinkingKind } from '../oc'

/**
 * 思考档位（内核 model variant）。档位集合由用户在配置里为该模型选的 `思考形态`（ModelCfg.thinking）决定，
 * **没有「不传思考参数」这种状态**——支持思考的模型一律给出明确档位，默认就把思考打开：
 * - 配置选了「关/开」（默认）→ 选项就「关 / 开」，默认**开**；
 * - 配置选了固定档（低/中/高/超高/最大）→ 选项就是这几档，默认**该档**；
 * - 配置选了「不支持」→ 禁用，仅显示「不支持」。
 * 用户随时可自己切，切过的按模型记住（localStorage）。
 */
export function ThinkingPicker({ value, onChange, kind }: { value: string; onChange: (v: string) => void; kind: ThinkingKind }) {
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

  // 档位集合按模型在配置里选的思考形态定；「关/开」默认「开」，固定档默认「该档」（由 value 传入）——
  // 用户可随时自己切。存档值不属于当前集合（如老模型存过 low、现在成开关型）时，回落到默认档
  const defaultKey = kind === 'effort' ? 'high' : 'on'
  const options: { key: string; label: string }[] =
    kind === 'toggle'
      ? [
          { key: 'none', label: '关' },
          { key: 'on', label: '开' }
        ]
      : kind === 'off'
        ? [{ key: '', label: '不支持' }]
        : [
            { key: 'low', label: '低' },
            { key: 'medium', label: '中' },
            { key: 'high', label: '高' },
            { key: 'xhigh', label: '超高' },
            { key: 'max', label: '最大' }
          ]
  const valid = options.some((o) => o.key === value)
  // 存档值不属于当前档位集合（如模型从分档变开关、老存档是 low）时落到默认档；
  // off（不支持）只有空 key 一个选项，也要能取到才不出错
  const cur = options.find((o) => o.key === (valid ? value : kind === 'off' ? '' : defaultKey))!
  const disabled = kind === 'off'
  return (
    <div className="menu-wrap tp" ref={wrap}>
      <button
        type="button"
        className="menu-trigger"
        title={
          disabled
            ? t('该模型在配置里设为「不支持思考」，故思考档位不可用')
            : t('思考档位按你为这个模型在配置里选的思考形态给出。选「关/开」就给「关/开」（默认开）；选固定档就给 低/中/高/超高/最大（默认该档）')
        }
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Brain size={14} />
        <span className="menu-label">{t(cur.label)}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && !disabled && (
        <div className="menu-panel tp up">
          {options.map((op) => (
            <button
              key={op.key}
              type="button"
              className={'menu-item' + (op.key === cur.key ? ' on' : '')}
              onClick={() => {
                onChange(op.key)
                setOpen(false)
              }}
            >
              <span className="mi-check">{op.key === cur.key && <Check size={13} />}</span>
              <span>{t(op.label)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}