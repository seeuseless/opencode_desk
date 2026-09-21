import type { ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * 应用内模态层（不用原生 alert/confirm）。
 *
 * size 是宽度档位（三档，够用就不再加）：
 *  - 不传：540px，通用表单（MCP、技能、删除确认）；
 *  - 'wide'：720px，字段多的表单（提供商：名称/ID/BaseURL/Key/模型列表）；
 *  - 'narrow'：460px，字段少的补充表单（模型编辑：6 个短字段，宽了反而空）。
 *
 * anchor 是垂直落点：
 *  - 不传：屏幕正中，设置类弹窗用（跟背后的整页表单配平，居中最稳）；
 *  - 'top'：贴在对话窗口上方，AI 主动发起的询问（提问 / 权限）用。
 *    这类弹窗是任务中途的卡点，用户视线本来就在对话流上，贴着对话窗口出现才不打断；
 *    居中会飘到屏幕正中、离对话流很远，还得回头找。
 *    加 72px 上边距给标题栏让位，避免压住窗口拖拽区。
 */
export function Modal({
  title,
  onClose,
  wide,
  narrow,
  anchor,
  children
}: {
  title: string
  onClose: () => void
  wide?: boolean
  narrow?: boolean
  anchor?: 'top'
  children: ReactNode
}) {
  return (
    <div className={'mask' + (anchor === 'top' ? ' top' : '')}>
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
