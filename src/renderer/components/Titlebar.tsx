import { useEffect, useState } from 'react'
import { Maximize2, MessageCircle, Minimize2, Minus, PanelRight, X } from 'lucide-react'
import logo from '../assets/logo.png'

/** 自绘标题栏：替代原生 header，颜色跟随主题；整条可拖拽（中间槽位给浏览器工具栏，留白处仍可拖） */
export function Titlebar({
  onToggleBrowser,
  onBrowserMax,
  onToggleFloat,
  browserOpen,
  browserMax,
  chatHidden
}: {
  onToggleBrowser: () => void
  onBrowserMax: () => void
  /** 全屏浏览时唤回 AI 对话：收起态点一下重新展开浮动卡，彻底隐藏态点一下连气泡一起找回 */
  onToggleFloat: () => void
  browserOpen: boolean
  browserMax: boolean
  /** AI 对话已彻底隐藏（连右下角气泡都不显示）：这时才出现唤回按钮 */
  chatHidden: boolean
}) {
  const [maxed, setMaxed] = useState(false)

  useEffect(() => {
    window.qingniao.winIsMax().then(setMaxed)
    return window.qingniao.onWinMax(setMaxed)
  }, [])

  return (
    <header className="titlebar">
      <img className="tb-logo" src={logo} alt="" draggable={false} />
      <span className="tb-browser-slot" />
      {/* 全屏浏览时藏起来：这一颗在浏览器全屏态下没有意义（面板已占满，关它等于退出全屏），
          交给右边那颗最大化/还原按钮，标题栏干净些 */}
      {!browserMax && (
        <button className="icon-btn tb-btn" title="内置浏览器" onClick={onToggleBrowser}>
          <PanelRight size={15} />
        </button>
      )}
      {/* 对话被彻底藏掉（连右下角气泡都没了）时的唯一唤回入口：隐藏按钮本身也跟着消失，
          所以这里必须留一颗，否则用户只能走收藏条之类的地方才能把对话找回来 */}
      {browserMax && chatHidden && (
        <button className="icon-btn tb-btn tb-on" title="显示 AI 对话" onClick={onToggleFloat}>
          <MessageCircle size={15} />
        </button>
      )}
      <button className="icon-btn tb-btn" title="最小化" onClick={() => window.qingniao.winMin()}>
        <Minus size={15} />
      </button>
      {/* 浏览器打开时这颗按钮接管面板放大/还原，关闭时回到窗口最大化 */}
      <button
        className="icon-btn tb-btn"
        title={browserOpen ? (browserMax ? '还原对话布局' : '浏览器放大占满') : maxed ? '还原' : '最大化'}
        onClick={() => (browserOpen ? onBrowserMax() : window.qingniao.winMax())}
      >
        {browserOpen ? (
          browserMax ? <Minimize2 size={14} /> : <Maximize2 size={14} />
        ) : maxed ? (
          <Minimize2 size={14} />
        ) : (
          <Maximize2 size={14} />
        )}
      </button>
      <button className="icon-btn tb-btn" title="隐藏到托盘" onClick={() => window.qingniao.winClose()}>
        <X size={15} />
      </button>
    </header>
  )
}
