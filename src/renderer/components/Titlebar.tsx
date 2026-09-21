import { useEffect, useState } from 'react'
import { Maximize2, Minimize2, Minus, PanelRight, X } from 'lucide-react'
import logo from '../assets/logo.png'

/** 自绘标题栏：替代原生 header，颜色跟随主题；整条可拖拽（中间槽位给浏览器工具栏，留白处仍可拖） */
export function Titlebar({
  onToggleBrowser,
  onBrowserMax,
  browserOpen,
  browserMax
}: {
  onToggleBrowser: () => void
  onBrowserMax: () => void
  browserOpen: boolean
  browserMax: boolean
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
      {/*
        全屏浏览时这一颗藏起来：面板已占满，关它等于退出全屏，交给右边那颗最大化/还原按钮。
        「AI 对话」开关也一并挪走了——它在地址栏右侧（那颗电源图标），
        与开关对象（对话卡/气泡）同处一条视觉线上，比挤在标题栏左端好找得多。
      */}
      {!browserMax && (
        <button className="icon-btn tb-btn" title="内置浏览器" onClick={onToggleBrowser}>
          <PanelRight size={15} />
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
