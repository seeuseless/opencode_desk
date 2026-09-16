import type { ReactNode } from 'react'
import { X } from 'lucide-react'

/** 应用内模态层（不用原生 alert/confirm） */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="mask">
      <div className="modal">
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
