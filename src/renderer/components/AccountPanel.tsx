import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, CircleUser, Coins, LoaderCircle, LogIn, LogOut, RefreshCw, Wallet } from 'lucide-react'
import { fmtNumber, fmtTokens } from '../format'
import { Modal } from './Modal'
import type { PlatformAccount, UsageLog, UsagePage, UsageRecord } from '../oc'

/** 一页多少条：与主进程默认一致（20），翻页条只关心「有没有上一页/下一页」 */
const EMPTY_PAGE = { items: [], total: 0, page: 1, per_page: 20, pages: 0 }

interface Props {
  loggedIn: boolean
  platformBusy: boolean
  /** 平台地址（展示用；未登录也显示，方便核对连的是哪台服务器） */
  baseUrl: string
  onLogin: () => void
  onLogout: () => void
  /** 改平台地址（上线换域名）；地址变了要重新登录 */
  onSetBaseUrl: (url: string) => void
  /** 浏览器唤不起青鸟时的兜底：手动粘贴授权码 */
  onSubmitCode: (code: string) => void
}

/**
 * 设置 → 账号：账号信息、积分、积分流水与每次消耗明细，以及退出登录。
 *
 * 流水与消耗明细是两份不同的账，所以分两个标签页：
 * 积分流水只关心余额怎么变的（发放/消耗/调整），消耗明细关心每次调用花了多少 token。
 *
 * 两份都是**分页**的：账本只会越来越长，一次全拉回来既慢又没法回看历史。
 * 两个标签页各自记住自己的页码，来回切换不会把对方顶回第一页。
 */
export function AccountPanel(p: Props) {
  const [acct, setAcct] = useState<PlatformAccount | null>(null)
  const [logs, setLogs] = useState<UsagePage<UsageLog>>(EMPTY_PAGE)
  const [records, setRecords] = useState<UsagePage<UsageRecord>>(EMPTY_PAGE)
  const [tab, setTab] = useState<'logs' | 'records'>('logs')
  /** 当前标签页的页码（切标签时回到第 1 页） */
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [confirmOut, setConfirmOut] = useState(false)
  /** 未登录时的兜底区：改平台地址 / 手动粘贴授权码 */
  const [url, setUrl] = useState(p.baseUrl)
  const [code, setCode] = useState('')
  const [manual, setManual] = useState(false)

  useEffect(() => setUrl(p.baseUrl), [p.baseUrl])

  /** 只拉「当前标签页那一页 + 账号信息」：另一个标签页的数据等切过去再取 */
  const load = useCallback(async () => {
    if (!p.loggedIn) {
      setAcct(null)
      setLogs(EMPTY_PAGE)
      setRecords(EMPTY_PAGE)
      return
    }
    setBusy(true)
    try {
      setAcct(await window.qingniao.platformAccount())
      if (tab === 'logs') setLogs(await window.qingniao.platformUsageLogs(undefined, page))
      else setRecords(await window.qingniao.platformUsageRecords(page))
    } finally {
      setBusy(false)
    }
  }, [p.loggedIn, tab, page])

  useEffect(() => {
    void load()
  }, [load])

  /** 切标签：页码一并归零，免得从第 5 页的流水跳到只有 1 页的消耗明细时是空的 */
  function switchTab(next: 'logs' | 'records'): void {
    if (next === tab) return
    setTab(next)
    setPage(1)
  }

  if (!p.loggedIn) {
    return (
      <section>
        <h3>
          <CircleUser size={15} /> 账号
        </h3>
        <p className="sec-tip">
          登录平台账号后即可使用内置模型（无需自备 API Key），用量与积分都记在这个账号下。
          登录在系统浏览器里完成，青鸟只会拿到一份可随时吊销的授权，不会保存密码。
        </p>
        <div className="acct-login">
          <button className="primary" disabled={p.platformBusy} onClick={p.onLogin}>
            {p.platformBusy ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />} 登录平台账号
          </button>
        </div>

        {!manual ? (
          <button className="ghost acct-more" onClick={() => setManual(true)}>
            登录没反应？换平台地址或粘贴授权码
          </button>
        ) : (
          <div className="acct-manual">
            <label>
              平台地址
              <span className="lab-tip">填平台部署的根地址，如 http://192.168.0.78:9000</span>
              <input value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <button className="ghost" disabled={p.platformBusy || !url.trim()} onClick={() => p.onSetBaseUrl(url.trim())}>
              保存地址
            </button>
            <label>
              授权码
              <span className="lab-tip">浏览器打开登录页后会显示一串授权码，10 分钟内有效、用一次作废</span>
              <input className="mono" value={code} spellCheck={false} onChange={(e) => setCode(e.target.value)} />
            </label>
            <button className="primary" disabled={p.platformBusy || !code.trim()} onClick={() => p.onSubmitCode(code.trim())}>
              用授权码登录
            </button>
          </div>
        )}
      </section>
    )
  }

  return (
    <section>
      <h3>
        <CircleUser size={15} /> 账号
        <span className="spacer" />
        <button className="ghost" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={13} className={busy ? 'spin' : undefined} /> 刷新
        </button>
      </h3>

      <div className="acct-card">
        <div className="acct-lead">
          <span className="acct-avatar">{(acct?.user.name || p.baseUrl).slice(0, 1).toUpperCase()}</span>
          <div className="acct-id">
            <div className="acct-name">{acct?.user.name ?? '已登录'}</div>
            <div className="acct-mail">{acct?.user.email ?? ''}</div>
          </div>
          <div className="acct-points">
            <div className="acct-points-k">
              <Coins size={13} /> 积分
            </div>
            {/* 管理员不参与积分计费：显示「不限」而不是一个会让人以为余额不足的 0 */}
            <div className="acct-points-v">{acct?.exempt ? '不限' : fmtNumber(acct?.points)}</div>
          </div>
        </div>
        <div className="acct-meta">
          {/* 只显示「这台机器叫什么」：平台地址与授权到期属于运维细节，
              授权本身是长期有效的，摆在用户面前只会让人以为要过期续费 */}
          {acct?.device && <span>本机设备 {acct.device}</span>}
          <span className="spacer" />
          <button className="ghost danger" onClick={() => setConfirmOut(true)}>
            <LogOut size={13} /> 退出登录
          </button>
        </div>
      </div>

      <div className="acct-tabs">
        <button className={'seg-btn' + (tab === 'logs' ? ' on' : '')} onClick={() => switchTab('logs')}>
          <Wallet size={13} /> 积分记录
        </button>
        <button className={'seg-btn' + (tab === 'records' ? ' on' : '')} onClick={() => switchTab('records')}>
          每次消耗
        </button>
      </div>

      {tab === 'logs' ? (
        <table className="utable">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th className="num">变动</th>
              <th className="num">余额</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {logs.items.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">还没有积分变动</td>
              </tr>
            )}
            {logs.items.map((l) => (
              <tr key={l.id}>
                <td className="dim">{l.created_at}</td>
                <td>
                  <span className={'chip t-' + l.type}>{l.type_label}</span>
                </td>
                <td className={'num ' + (l.change > 0 ? 'up' : 'down')}>
                  {l.change > 0 ? '+' : ''}
                  {fmtNumber(l.change)}
                </td>
                <td className="num dim">{fmtNumber(l.after)}</td>
                <td className="dim">{l.remark}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="utable">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th className="num">输入 / 输出</th>
              <th className="num">合计</th>
              <th className="num">扣积分</th>
            </tr>
          </thead>
          <tbody>
            {records.items.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">还没有消耗记录</td>
              </tr>
            )}
            {records.items.map((r) => (
              <tr key={r.id}>
                <td className="dim">{r.created_at}</td>
                <td>
                  <div className="mono-cell">{r.model}</div>
                  <div className="dim">{r.ratio} 倍</div>
                </td>
                <td className="num dim">
                  {fmtTokens(r.prompt_tokens)} / {fmtTokens(r.completion_tokens)}
                </td>
                <td className="num">{fmtTokens(r.total_tokens)}</td>
                <td className="num">{fmtNumber(r.points)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Pager
        page={tab === 'logs' ? logs.page : records.page}
        pages={tab === 'logs' ? logs.pages : records.pages}
        total={tab === 'logs' ? logs.total : records.total}
        busy={busy}
        onGo={(n) => setPage(n)}
      />

      {confirmOut && (
        <Modal title="退出登录" onClose={() => setConfirmOut(false)}>
          <p className="confirm-text">
            退出后会清掉本机的授权与设备身份，内置模型随之不可用（右栏手机端连接也会断开）。
            下次登录需要重新授权。
          </p>
          <div className="actions">
            <button className="ghost" onClick={() => setConfirmOut(false)}>
              取消
            </button>
            <button
              className="primary danger-btn"
              disabled={p.platformBusy}
              onClick={() => {
                setConfirmOut(false)
                p.onLogout()
              }}
            >
              {p.platformBusy ? '退出中…' : '退出登录'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}

/**
 * 翻页条：左边一句「共 N 条 · 第 x/y 页」，右边两个按钮。
 *
 * 不做页码数字列表——账本翻页绝大多数是「往前翻一页看看」，
 * 一排数字既占地方又让人纠结该点哪个。
 */
function Pager(p: { page: number; pages: number; total: number; busy: boolean; onGo: (n: number) => void }) {
  // 一条记录都没有时不给翻页条：那是噪音，不是信息
  if (p.total === 0) return null

  return (
    <div className="upager">
      <span className="upager-info">
        共 {p.total} 条 · 第 {p.page} / {Math.max(1, p.pages)} 页
      </span>
      <span className="spacer" />
      <button className="ghost" disabled={p.busy || p.page <= 1} onClick={() => p.onGo(p.page - 1)}>
        <ChevronLeft size={13} /> 上一页
      </button>
      <button className="ghost" disabled={p.busy || p.page >= p.pages} onClick={() => p.onGo(p.page + 1)}>
        下一页 <ChevronRight size={13} />
      </button>
    </div>
  )
}
