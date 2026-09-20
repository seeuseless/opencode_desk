import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronDown } from 'lucide-react'
import type { ThinkingKind } from '../oc'

/**
 * 思考档位（内核 model variant）。档位集合按模型能力自动判定，**没有「不传思考参数」这种状态**——
 * 支持思考的模型一律给出明确档位，默认就把思考打开：
 * - `toggle`（只有开关）：选项就「关 / 开」，默认**开**；
 * - `effort`（真有分档）：选项就「低 / 中 / 高」，默认**高**；
 * - `off`：不支持，不可用。
 * 用户随时可自己切，切过的按模型记住（localStorage）。
 *
 * 集合怎么定（kind）：
 * 1. **优先实测**（`probed`）：同一模型各档发一次极小请求比对思考量得出的结论，最准。很多模型
 *    （如 agnes-3.0-flash）名义上有低中高，实测各档思考量完全相同，其实是开关型，只该给「关/开」；
 * 2. 实测拿不到时用内核能力表 + 模型名推断。
 */
export function ThinkingPicker({
  value,
  onChange,
  kind,
  probed = false
}: {
  value: string
  onChange: (v: string) => void
  kind: ThinkingKind
  /** kind 是否来自实测（而非按模型名/能力表推断），用于给用户一个「凭什么这么显示」的说法 */
  probed?: boolean
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

  // 档位集合按模型能力定；**只有开关的模型默认「开」，真有分档的默认「高」**——
  // 用户可随时自己切「关」或切别的档。存档值是别的能力下的档位名（如老模型存过 low）时，回落到默认档
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
            { key: 'high', label: '高' }
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
            ? '该模型判定为不支持思考，故思考档位不可用'
            : `思考档位：${probed ? '档位已按实测结果给出——同一模型分别以关/低/高发过极小请求，比对过思考量' : '档位按模型能力与模型名推断（尚未实测）'}。该模型只有开关时给「关/开」（默认开）；真有分档时给「低/中/高」（默认高）`
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