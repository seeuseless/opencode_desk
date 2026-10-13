import { useEffect, useRef } from 'react'
import { AlertCircle, Check, Info, X } from 'lucide-react'
import { t } from '../i18n'

export type ToastKind = 'error' | 'info' | 'ok'

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  /** 可选的补充说明（如「已改用 X 模型重试」） */
  detail?: string
}

interface Props {
  items: ToastItem[]
  onClose: (id: number) => void
}

/** 错误类停留更久：要读完 + 找到那个关闭按钮；info/ok 一晃而过就行 */
const LIFE: Record<ToastKind, number> = { error: 9000, info: 4000, ok: 3000 }
const MAX_VISIBLE = 3

/**
 * 右上角浮层提示。
 *
 * 为什么对话流里的错误条不够用（2026-10-13 实测）：内核把上游失败只写进自己的日志，
 * 不推 `session.error`、也不立刻写进助手消息，而是**自动重试 6 次、间隔递增、累计 1 分 39 秒**。
 * 那段时间界面只有一个转圈的「处理中」，用户在**消息列表里根本看不到任何东西**——
 * 错误条是回合收尾（session.idle / 轮询兜底）之后才落进对话流的，那时候用户早就放弃等了。
 *
 * 所以这里给的是「立刻、明确、挡不住」的提示：失败当下的第一手信息，
 * 不依赖回合收尾，也不依赖用户正在看消息列表的哪个位置。
 */
export function Toasts({ items, onClose }: Props) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {items.slice(-MAX_VISIBLE).map((x) => (
        <ToastRow key={x.id} item={x} onClose={onClose} />
      ))}
    </div>
  )
}

function ToastRow({ item, onClose }: { item: ToastItem; onClose: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // mouseenter 暂停倒计时：用户正在读/正在点关闭时不该被收走
    let left = LIFE[item.kind]
    let timer = window.setTimeout(() => onClose(item.id), left)
    const pause = () => {
      window.clearTimeout(timer)
    }
    const resume = () => {
      timer = window.setTimeout(() => onClose(item.id), Math.max(1200, left))
    }
    const el = ref.current
    el?.addEventListener('mouseenter', pause)
    el?.addEventListener('mouseleave', resume)
    return () => {
      window.clearTimeout(timer)
      el?.removeEventListener('mouseenter', pause)
      el?.removeEventListener('mouseleave', resume)
    }
    // life 定版不随渲染变：只在挂载时起一次倒计时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  const Ico = item.kind === 'error' ? AlertCircle : item.kind === 'ok' ? Check : Info
  return (
    <div ref={ref} className={'toast toast-' + item.kind}>
      <Ico size={14} className="toast-ico" />
      <div className="toast-body">
        <span className="toast-text">{item.text}</span>
        {item.detail && <span className="toast-detail">{item.detail}</span>}
      </div>
      <button type="button" className="toast-x" title={t('关闭')} onClick={() => onClose(item.id)}>
        <X size={13} />
      </button>
    </div>
  )
}