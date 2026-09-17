import { useEffect, useState } from 'react'
import { Maximize2, Minimize2, Minus, X } from 'lucide-react'

/** 自绘标题栏：替代原生 header，颜色跟随主题；整条可拖拽 */
export function Titlebar() {
  const [maxed, setMaxed] = useState(false)

  useEffect(() => {
    window.qingniao.winIsMax().then(setMaxed)
    return window.qingniao.onWinMax(setMaxed)
  }, [])

  return (
    <header className="titlebar">
      <span className="tb-brand">
        <span className="tb-en">QingNiao</span>
      </span>
      <span className="tb-drag" />
      <button className="icon-btn tb-btn" title="最小化" onClick={() => window.qingniao.winMin()}>
        <Minus size={15} />
      </button>
      <button className="icon-btn tb-btn" title={maxed ? '还原' : '最大化'} onClick={() => window.qingniao.winMax()}>
        {maxed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
      <button className="icon-btn tb-btn tb-close" title="关闭" onClick={() => window.qingniao.winClose()}>
        <X size={15} />
      </button>
    </header>
  )
}
