import type { ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * 应用内模态层（不用原生 alert/confirm）。
 *
 * size 是宽度档位（三档，够用就不再加）：
 *  - 不传：540px，通用表单（MCP、技能、删除确认）；
 *  - 'wide'：720px，字段多的表单（提供商：名称/ID/BaseURL/Key/模型列表）；
 *  - 'narrow'：460px，字段少的补充表单（模型编辑：6 个短字段，宽了反而空）。
 */
export function Modal({
  title,
  onClose,
  wide,
  narrow,
  children
}: {
  title: string
  onClose: () => void
  wide?: boolean
  narrow?: boolean
  children: ReactNode
}) {
  return (
    <div className="mask">
      <div className={'modal' + (wide ? ' wide' : narrow ? ' narrow' : '')}>
        <header className="mhead">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="mbody">{children}</div>
      </div>
    </div>
  )
}
