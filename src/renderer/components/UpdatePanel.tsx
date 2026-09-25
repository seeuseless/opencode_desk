import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowUpCircle, Check, Download, ExternalLink, FileText, LoaderCircle, RefreshCw, Rocket, X } from 'lucide-react'
import { Modal } from './Modal'
import { t } from '../i18n'
import { LICENSE_SECTIONS, LICENSE_TITLE } from '../lib/license'
import type { UpdateState } from '../../../electron/main/types'

/**
 * 设置 → 关于：版本信息与更新。
 *
 * 更新链路（详见 electron/main/updater.ts）：
 *   检查 → GitHub Releases 里最新版的 tag / 说明 / 安装包附件
 *   下载 → 存到 ~/.qingniaoai/updates/，进度靠主进程推送
 *   安装 → 拉起安装包（Windows 上安装器会自己关旧装新并重启应用）
 *
 * 状态**全部来自主进程**，本组件不自己算版本、不自己拼下载地址：
 * 同一个状态要同时服务「检查」「下载」「安装」三步，若在渲染层再存一份，
 * 下载完切走再回来就会对不上（比如显示"可以安装"但主进程那边其实已作废）。
 * 所以这里只有一份 state，初始 getUpdateState() 拉一次，之后由 onUpdateChanged 覆盖。
 */
export function UpdatePanel() {
  const [st, setSt] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  /** 本地提示（下载失败、取消、安装包已被删这类一次性结果），成功/失败都在这条显示 */
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 条款弹窗开着没（条款正文不常看，占位在页面上会挤走真正要操作的更新按钮） */
  const [showLicense, setShowLicense] = useState(false)

  const apply = useCallback((s: UpdateState) => {
    setSt(s)
  }, [])

  // 初始拉一次 + 订阅变化。主进程推送里带的是完整快照（不是增量），
  // 所以直接覆盖即可，不用在渲染层做合并——增量合并是版本号对不上的主要来源。
  useEffect(() => {
    let alive = true
    void window.qingniao.getUpdateState().then((s) => {
      if (alive) apply(s)
    })
    const off = window.qingniao.onUpdateChanged((s) => apply(s))
    return () => {
      alive = false
      off()
    }
  }, [apply])

  async function run<T>(fn: () => Promise<T>, onOk?: (r: T) => void): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      onOk?.(r)
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (!st) {
    return (
      <section>
        <h3>
          <Rocket size={15} /> {t('关于')}
        </h3>
        <div className="plist-empty">
          <LoaderCircle size={14} className="spin" /> {t('正在读取版本信息…')}
        </div>
      </section>
    )
  }

  const latest = st.latest
  const pct = st.progress && st.progress.total > 0 ? Math.min(100, Math.round((st.progress.received / st.progress.total) * 100)) : null
  const downloading = !!st.progress
  const ready = st.canInstall

  return (
    <section>
      <h3>
        <Rocket size={15} /> {t('关于')}
      </h3>
      <p className="sec-tip">
        {t('青鸟 QingNiao —— 开源工作助手（Electron 桌面壳 + OpenCode agent 内核）。')}
      </p>

      {/* 版本卡片：常态只有"当前版本 + 检查更新"。
          没有新版本时不摆"最新版本：已是最新"这类空栏——用户点检查更新本来就是为了有新版可用，
          摆一排"已是最新"只是占位置；真有新版才在下面单独开一块（见下方 ud-upd）。 */}
      <div className="ud-card">
        <div className="ud-ver">
          <span className="ud-lab">{t('当前版本')}</span>
          <b className="ud-num">{st.current}</b>
        </div>
        {st.checkedAt > 0 && !latest && !st.checking && (
          <span className="ud-state">
            <Check size={13} /> {t('已是最新')}
          </span>
        )}
        <span className="spacer" />
        {!st.dev && (
          <button
            className="primary"
            disabled={busy || st.checking || downloading}
            onClick={() => void run(() => window.qingniao.checkUpdate())}
          >
            {st.checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {st.checking ? t('检查中…') : t('检查更新')}
          </button>
        )}
      </div>

      {/* 检查失败：只如实说原因（如 GitHub 接口限流），**不给"打开发布页"的出口**——
          那是把排查责任推给用户：他知道有新版、却打不开、还得自己去翻仓库，
          不如直接告诉他"稍后再试"，重试的成本比他手动去发布页低得多。
          真要发布页，应用内本就有正式入口（「查看发布页」只在新版本区块里出现） */}
      {st.error && (
        <div className="ud-note err">
          <AlertCircle size={14} />
          <span>{st.error}</span>
        </div>
      )}

      {/* 本组件里的即时提示（下载取消/失败、安装包丢失） */}
      {msg && (
        <div className={'ud-note' + (msg.kind === 'err' ? ' err' : ' ok')}>
          {msg.kind === 'err' ? <AlertCircle size={14} /> : <Check size={14} />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* 有新版本：只在这一块里给「查看发布页」——其他时候不暴露仓库地址，
          用户不需要知道包从哪来，知道"能升级"就够了 */}
      {latest && (
        <div className="ud-upd">
          <div className="ud-upd-head">
            <ArrowUpCircle size={15} />
            <b>{t('发现新版本 {v}', { v: latest.version })}</b>
            {latest.publishedAt && <span className="ud-time">{new Date(latest.publishedAt).toLocaleString('zh-CN', { hour12: false })}</span>}
            <span className="spacer" />
            <button className="ghost sm" onClick={() => void window.qingniao.openRelease(latest.tag)}>
              <ExternalLink size={13} /> {t('查看发布页')}
            </button>
          </div>

          {latest.notes.trim() && <pre className="ud-notes">{latest.notes.trim().slice(0, 4000)}</pre>}

          {/* 下载进度条：只有拿到总长度才算百分比，否则退化成"已下载 xx MB" */}
          {downloading && (
            <div className="ud-prog">
              <div className="ud-prog-bar">
                <i style={{ width: pct === null ? '30%' : pct + '%' }} className={pct === null ? 'indet' : ''} />
              </div>
              <span className="ud-prog-txt">
                {pct === null ? t('已下载 {v}', { v: fmtSize(st.progress!.received) }) : `${pct}% · ${fmtSize(st.progress!.received)} / ${fmtSize(st.progress!.total)}`}
              </span>
            </div>
          )}

          <div className="ud-acts">
            {ready ? (
              <>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => window.qingniao.installUpdate(),
                      (r) => {
                        if (!r.ok) setMsg({ kind: 'err', text: r.error ?? t('启动安装程序失败') })
                        else if (r.manual) setMsg({ kind: 'ok', text: t('安装包已打开，请按提示把青鸟拖到「应用程序」完成替换。') })
                        // Windows 上安装器接管后本应用会退出，这里不用再提示什么
                      }
                    )
                  }
                >
                  <Rocket size={14} /> {t('立即安装并重启')}
                </button>
                <span className="ud-hint">
                  {t('安装包已下好（{v}）。点「立即安装」会关闭青鸟并启动安装程序。', { v: fmtSize(latest.size) })}
                </span>
              </>
            ) : downloading ? (
              <button className="ghost" onClick={() => void run(() => window.qingniao.cancelUpdate())}>
                <X size={14} /> {t('取消下载')}
              </button>
            ) : (
              <>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => window.qingniao.downloadUpdate(),
                      (s) => {
                        if (s.error) setMsg({ kind: 'err', text: s.error })
                      }
                    )
                  }
                >
                  <Download size={14} /> {t('下载更新')}
                </button>
                <span className="ud-hint">
                  {latest.downloadName || t('安装包')}
                  {latest.size > 0 ? ` · ${fmtSize(latest.size)}` : ''}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 服务条款入口：只放一行"入口"，正文在弹窗里——条款很长，摊在页面上会挤掉
          真正要操作的更新按钮；但入口必须显眼可点，不能藏成脚注 */}
      <div className="ud-terms">
        <FileText size={14} />
        <span>{t('使用本软件即表示你已阅读并同意')}</span>
        <button type="button" className="ud-term-link" onClick={() => setShowLicense(true)}>
          《{t(LICENSE_TITLE)}》
        </button>
      </div>

      {showLicense && <LicenseModal onClose={() => setShowLicense(false)} />}
    </section>
  )
}

/**
 * 条款弹窗。
 *
 * 用 Modal 的 wide 档（720px）：条款条目多、每条又带缩进列表，540px 会频繁换行，
 * 读起来很碎。**不给"同意"按钮**——同意在使用软件那一刻就已构成，弹窗只是让用户能看，
 * 逼着点一次"我同意"既无法律增益也烦人；给「知道了」关掉即可。
 *
 * **不显示版本号与日期**：用户看条款是为了知道"我承担什么"，不是来核对版本对齐的；
 * 摆一行「v1.0 · 2026-09-22」只会让人以为"这是不是过期了"。版本信息留在
 * lib/license.ts 里给维护者用即可。
 */
function LicenseModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t(LICENSE_TITLE)} wide onClose={onClose}>
      <div className="lic-body">
        {LICENSE_SECTIONS.map((sec) => (
          <div className="lic-sec" key={sec.heading}>
            <h4>{t(sec.heading)}</h4>
            {sec.paras.map((p) => (
              // 正文里的 **加粗** 是给"风险自担""不承担任何责任"这类关键词加强调的，
              // 用极简标记而不是 dangerouslySetInnerHTML：条款文本将来可能来自外部，
              // 走 HTML 注入等于给未来埋一个 XSS 面（这里只需要粗体一种样式）
              <p key={p}>{renderBold(t(p))}</p>
            ))}
            {sec.items && (
              <ul>
                {sec.items.map((it) => (
                  <li key={it}>{renderBold(t(it))}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="primary" onClick={onClose}>
          {t('知道了')}
        </button>
      </div>
    </Modal>
  )
}

/** 把 `**粗体**` 渲染成 <b>（只支持这一种标记，够用且不引入 HTML 注入面） */
function renderBold(text: string): ReactNode {
  // 按 ** 切分：奇数段是加粗内容（"a**b**c" → ['a','b','c']，下标 1 为粗体）
  const parts = text.split('**')
  if (parts.length === 1) return text
  return parts.map((seg, i) => (i % 2 === 1 ? <b key={i}>{seg}</b> : <span key={i}>{seg}</span>))
}

/** 字节数 → 人类可读（进度条与"安装包多大"都用它，避免两处各写一套换算） */
function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return t('未知大小')
  const mb = n / 1024 / 1024
  if (mb >= 1) return mb.toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}
