import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ArrowUpCircle, Check, Download, ExternalLink, LoaderCircle, RefreshCw, Rocket, X } from 'lucide-react'
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
          <Rocket size={15} /> 关于
        </h3>
        <div className="plist-empty">
          <LoaderCircle size={14} className="spin" /> 正在读取版本信息…
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
        <Rocket size={15} /> 关于
      </h3>
      <p className="sec-tip">
        青鸟 QingNiao —— 开源工作助手（Electron 桌面壳 + OpenCode agent 内核）。 更新包直接从 GitHub
        仓库获取，不走第三方中转。
      </p>

      {/* 版本卡片：左边当前版本，右边目标版本/状态 */}
      <div className="ud-card">
        <div className="ud-ver">
          <span className="ud-lab">当前版本</span>
          <b className="ud-num">{st.current}</b>
        </div>
        <div className="ud-arrow">→</div>
        <div className="ud-ver">
          <span className="ud-lab">最新版本</span>
          <b className={'ud-num' + (latest ? ' new' : '')}>
            {latest ? latest.version : st.checkedAt ? '已是最新' : '—'}
          </b>
        </div>
        <span className="spacer" />
        {!st.dev && (
          <button
            className="primary"
            disabled={busy || st.checking || downloading}
            onClick={() => void run(() => window.qingniao.checkUpdate())}
          >
            {st.checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {st.checking ? '检查中…' : '检查更新'}
          </button>
        )}
      </div>

      {/* 开发模式：源码跑的时候版本号恒为 package.json，没有"升级"这回事 */}
      {st.dev && (
        <div className="ud-note">
          <AlertCircle size={14} /> 开发模式不检查更新（源码运行的版本号不会变）。发版后的安装版才有更新提示。
        </div>
      )}

      {/* 检查失败：如实说原因，并给一个"自己去发布页看"的出口，而不是编个假版本号 */}
      {st.error && (
        <div className="ud-note err">
          <AlertCircle size={14} />
          <span>{st.error}</span>
          <span className="spacer" />
          <button className="ghost sm" onClick={() => void window.qingniao.openRelease()}>
            <ExternalLink size={13} /> 打开发布页
          </button>
        </div>
      )}

      {/* 本组件里的即时提示（下载取消/失败、安装包丢失） */}
      {msg && (
        <div className={'ud-note' + (msg.kind === 'err' ? ' err' : ' ok')}>
          {msg.kind === 'err' ? <AlertCircle size={14} /> : <Check size={14} />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* 有新版本 */}
      {latest && (
        <div className="ud-upd">
          <div className="ud-upd-head">
            <ArrowUpCircle size={15} />
            <b>发现新版本 {latest.version}</b>
            {latest.publishedAt && <span className="ud-time">{new Date(latest.publishedAt).toLocaleString('zh-CN', { hour12: false })}</span>}
            <span className="spacer" />
            <button className="ghost sm" onClick={() => void window.qingniao.openRelease(latest.tag)}>
              <ExternalLink size={13} /> 查看发布页
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
                {pct === null ? `已下载 ${fmtSize(st.progress!.received)}` : `${pct}% · ${fmtSize(st.progress!.received)} / ${fmtSize(st.progress!.total)}`}
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
                        if (!r.ok) setMsg({ kind: 'err', text: r.error ?? '启动安装程序失败' })
                        else if (r.manual) setMsg({ kind: 'ok', text: '安装包已打开，请按提示把青鸟拖到「应用程序」完成替换。' })
                        // Windows 上安装器接管后本应用会退出，这里不用再提示什么
                      }
                    )
                  }
                >
                  <Rocket size={14} /> 立即安装并重启
                </button>
                <span className="ud-hint">
                  安装包已下好（{fmtSize(latest.size)}）。点「立即安装」会关闭青鸟并启动安装程序。
                </span>
              </>
            ) : downloading ? (
              <button className="ghost" onClick={() => void run(() => window.qingniao.cancelUpdate())}>
                <X size={14} /> 取消下载
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
                  <Download size={14} /> 下载更新
                </button>
                <span className="ud-hint">
                  {latest.downloadName || '安装包'}
                  {latest.size > 0 ? ` · ${fmtSize(latest.size)}` : ''}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      <div className="ud-meta">
        <span>
          仓库 <code>{st.repo}</code>
        </span>
        <span className="spacer" />
        <button className="ghost sm" onClick={() => void window.qingniao.openRelease()}>
          <ExternalLink size={13} /> github.com/{st.repo}
        </button>
      </div>
    </section>
  )
}

/** 字节数 → 人类可读（进度条与"安装包多大"都用它，避免两处各写一套换算） */
function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '未知大小'
  const mb = n / 1024 / 1024
  if (mb >= 1) return mb.toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}
