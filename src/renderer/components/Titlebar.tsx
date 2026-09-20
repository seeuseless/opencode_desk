import { useEffect, useState } from 'react'
import { Maximize2, MessageCircle, MessageCircleOff, Minimize2, Minus, PanelRight, X } from 'lucide-react'
import logo from '../assets/logo.png'

/** 自绘标题栏：替代原生 header，颜色跟随主题；整条可拖拽（中间槽位给浏览器工具栏，留白处仍可拖） */
export function Titlebar({
  onToggleBrowser,
  onBrowserMax,
  onToggleFloat,
  browserOpen,
  browserMax,
  floatOpen
}: {
  onToggleBrowser: () => void
  onBrowserMax: () => void
  /** 全屏浏览时收起/展开右下角浮动对话卡（打游戏等不需要对话的场景） */
  onToggleFloat: () => void
  browserOpen: boolean
  browserMax: boolean
  /** 浮动对话卡是否展开：决定这颗按钮的图标（对话开 / 对话关） */
  floatOpen: boolean
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
      <button className="icon-btn tb-btn" title="内置浏览器" onClick={onToggleBrowser}>
        <PanelRight size={15} />
      </button>
      {/* 全屏浏览时才有：收起/展开右下角对话卡（打游戏等不想看到对话时收起，气泡仍在右下角） */}
      {browserMax && (
        <button
          className={'icon-btn tb-btn' + (floatOpen ? ' tb-on' : '')}
          title={floatOpen ? '隐藏 AI 对话（气泡留在右下角）' : '显示 AI 对话'}
          onClick={onToggleFloat}
        >
          {floatOpen ? <MessageCircle size={15} /> : <MessageCircleOff size={15} />}
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
