import { useEffect, useState, type ReactNode } from 'react'
import { Maximize2, Minimize2, Minus, PanelRight, RefreshCw, Save, X } from 'lucide-react'
import type { CodeControls } from './CodeWorkspace'

/** 会话标题（对话区首条用户信息；计划会话另带标记与执行日期） */
export interface TitleInfo {
  text: string
  sched?: boolean
  date?: string
}

export interface CodeTitleInfo {
  path: string
  status: string
}

/** 自绘标题栏：替代原生 header，颜色跟随主题；整条可拖拽（中间槽位给浏览器工具栏，留白处仍可拖） */
export function Titlebar({
  title,
  onToggleBrowser,
  onBrowserMax,
  browserOpen,
  browserMax,
  showBrowser,
  codeInfo,
  codeControls
}: {
  title?: TitleInfo | null
  onToggleBrowser: () => void
  onBrowserMax: () => void
  browserOpen: boolean
  browserMax: boolean
  showBrowser: boolean
  codeInfo?: CodeTitleInfo | null
  codeControls?: CodeControls | null
}) {
  const [maxed, setMaxed] = useState(false)

  useEffect(() => {
    window.qingniao.winIsMax().then(setMaxed)
    return window.qingniao.onWinMax(setMaxed)
  }, [])

  return (
    <header className="titlebar">
      {/* 会话标题：左端与下方消息区同左边距，短标题过长自动省略；不占中间槽（留给浏览器工具栏） */}
      {title && (
        <div className="tb-title" title={title.text}>
          {title.sched && <span className="ch-tag">计划</span>}
          <span className="tb-title-text">{title.text.length > 80 ? title.text.slice(0, 80) + '…' : title.text}</span>
          {title.date && <span className="ch-date">{title.date}</span>}
        </div>
      )}
      {codeInfo && (
        <div className="tb-code-tools" title={codeInfo.path}>
          <span className="tb-code-path">{codeInfo.path}</span>
          <em>{codeInfo.status}</em>
          <button
            className="icon-btn tb-code-btn"
            title="放弃修改并重新读取"
            onClick={() => codeControls?.reload()}
            disabled={!codeControls || codeControls.saving}
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="primary code-save tb-code-save"
            onClick={() => codeControls?.save()}
            disabled={!codeControls || !codeControls.canSave || codeControls.saving}
          >
            <Save size={13} />
            {codeControls?.saving ? '保存中' : '保存'}
          </button>
        </div>
      )}
      <span className="tb-browser-slot" />
      {/* 右段窗口按钮 */}
      <div className="tb-acts">
        {/*
          全屏浏览时这一颗藏起来：面板已占满，关它等于退出全屏，交给右边那颗最大化/还原按钮。
          「AI 对话」开关也一并挪走了——它在地址栏右侧（那颗电源图标），
          与开关对象（对话卡/气泡）同处一条视觉线上，比挤在标题栏左端好找得多。
        */}
        {showBrowser && !browserMax && (
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
        {/* mac 驻留在 Dock（点 Dock 图标唤回），没有「托盘」概念，文案按平台区分 */}
        <button
          className="icon-btn tb-btn"
          title={navigator.userAgent.includes('Mac') ? '隐藏窗口（点 Dock 图标恢复）' : '隐藏到托盘'}
          onClick={() => window.qingniao.winClose()}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  )
}
