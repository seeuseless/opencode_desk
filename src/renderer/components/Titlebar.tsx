import { useEffect, useState } from 'react'
import { Bird, FolderPlus, Maximize2, Minimize2, Minus, X } from 'lucide-react'

/** 自绘标题栏：替代原生 header，颜色跟随主题；整条可拖拽 */
export function Titlebar({ onAddProject }: { onAddProject: () => void }) {
  const [maxed, setMaxed] = useState(false)

  useEffect(() => {
    window.qingniao.winIsMax().then(setMaxed)
    return window.qingniao.onWinMax(setMaxed)
  }, [])

  return (
    <header className="titlebar">
      <span className="tb-brand">
        <Bird size={15} className="tb-logo" /> 青鸟 <span className="tb-en">QingNiao</span>
      </span>
      <button className="icon-btn tb-btn" title="添加项目（选择本地文件夹）" onClick={onAddProject}>
        <FolderPlus size={16} />
      </button>
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
