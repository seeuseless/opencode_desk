import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
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
 *  - 'top'：贴在窗口顶部，权限确认 / 模型授权用；
 *  - 'above'：贴在 anchorRef 指向的输入框上方，AI 等待用户选择回答时用。
 */
export function Modal({
  title,
  onClose,
  wide,
  narrow,
  anchor,
  anchorRef,
  children
}: {
  title: string
  onClose: () => void
  wide?: boolean
  narrow?: boolean
  anchor?: 'top' | 'above'
  anchorRef?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const [aboveGap, setAboveGap] = useState(0)

  useLayoutEffect(() => {
    if (anchor !== 'above' || !anchorRef?.current) return
    const target = anchorRef.current
    const update = () => {
      const top = target.getBoundingClientRect().top
      setAboveGap(Math.max(12, window.innerHeight - top + 8))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(target)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [anchor, anchorRef])

  const anchorClass = anchor === 'top' ? ' top' : anchor === 'above' ? ' above' : ''
  return (
    <div className={'mask' + anchorClass} style={anchor === 'above' ? { paddingBottom: aboveGap } : undefined}>
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
