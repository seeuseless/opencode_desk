import { useCallback, useEffect, useState } from 'react'
import { ArrowUpCircle, Download, LoaderCircle, Rocket, X } from 'lucide-react'
import { Modal } from './Modal'
import { t } from '../i18n'
import type { UpdateState } from '../../../electron/main/types'

/**
 * 升级确认弹窗（由「工作区」旁的「更新」入口打开）：确认后直接下载 + 安装，不再跳设置-关于页。
 *
 * 状态全部取自主进程 UpdateState 快照（父级实时下传）：
 *   - 发现新版（latest）→ 点「立即升级」→ downloadUpdate，下载完成后自动 installUpdate；
 *   - 下载中（progress）→ 显示进度、可取消；
 *   - 已就绪（canInstall）→ 点「立即安装并重启」→ installUpdate（Windows 上安装器接管并重启）。
 * 「立即升级」路径是「确认后直接做升级」：confirmed 置位后，下载一完成就自动安装；
 * 直接以「已就绪」状态打开弹窗则不自动安装，由用户点安装按钮。
 */
export function UpgradeDialog({ updateSt, onClose }: { updateSt: UpdateState | null; onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false)
  const [installing, setInstalling] = useState(false)

  const latest = updateSt?.latest ?? null
  const downloading = !!updateSt?.progress
  const ready = !!updateSt?.canInstall
  const pct =
    updateSt?.progress && updateSt.progress.total > 0
      ? Math.min(100, Math.round((updateSt.progress.received / updateSt.progress.total) * 100))
      : null

  const doInstall = useCallback(() => {
    setInstalling(true)
    void window.qingniao.installUpdate()
  }, [])

  // 下载完成后自动安装（用户点过「立即升级」）：confirmed 且已就绪即触发一次
  useEffect(() => {
    if (confirmed && ready && !installing) doInstall()
  }, [confirmed, ready, installing, doInstall])

  const startUpgrade = () => {
    if (ready) {
      doInstall()
      return
    }
    setConfirmed(true)
    void window.qingniao.downloadUpdate()
  }

  return (
    <Modal title={t('升级')} narrow onClose={onClose}>
      {latest && (
        <div className="ud-upd-head">
          <ArrowUpCircle size={16} />
          <b>{t('发现新版本 {v}', { v: latest.version })}</b>
        </div>
      )}
      {downloading && (
        <div className="ud-prog">
          <div className="ud-prog-bar">
            <i style={{ width: pct === null ? '30%' : pct + '%' }} className={pct === null ? 'indet' : ''} />
          </div>
          <span className="ud-prog-txt">
            {pct === null ? t('正在下载更新…') : `${t('正在下载更新…')} ${pct}%`}
          </span>
        </div>
      )}
      <div className="actions">
        {installing ? (
          <button className="primary" disabled>
            <LoaderCircle size={14} className="spin" /> {t('正在安装…')}
          </button>
        ) : ready ? (
          <button className="primary" onClick={doInstall}>
            <Rocket size={14} /> {t('立即安装并重启')}
          </button>
        ) : downloading ? (
          <button className="ghost" onClick={() => void window.qingniao.cancelUpdate()}>
            <X size={14} /> {t('取消下载')}
          </button>
        ) : (
          <button className="primary" onClick={startUpgrade}>
            <Download size={14} /> {t('立即升级')}
          </button>
        )}
      </div>
    </Modal>
  )
}
