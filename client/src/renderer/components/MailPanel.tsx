// 设置 → 邮箱：Agent Mail 授权状态与设备授权入口。
// 邮件能力本体在 mail-mcp.mjs（AI 在对话里收发查），这里只管「授权」这一件事：
// 已授权显示邮箱地址 + 退出登录；未授权给「去授权」按钮（设备授权流程，进度走事件）。
import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, LogOut, Mail, ShieldCheck } from 'lucide-react'
import { t } from '../i18n'

type MailStatus = { authorized: boolean; email?: string; error?: string }
type MailEvent = {
  type: 'login_started' | 'login_url' | 'login_done' | 'login_failed'
  url?: string
  status?: MailStatus
  message?: string
}

export default function MailPanel() {
  const [status, setStatus] = useState<MailStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [loginUrl, setLoginUrl] = useState('')
  const [loginMsg, setLoginMsg] = useState('')

  async function refresh() {
    try {
      setStatus(await window.qingniao.mailStatus())
    } catch (e) {
      setStatus({ authorized: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  useEffect(() => {
    void refresh()
    const off = window.qingniao.onMailEvent((e: MailEvent) => {
      if (e.type === 'login_started') {
        setBusy(true)
        setLoginMsg('')
      } else if (e.type === 'login_url' && e.url) {
        setLoginUrl(e.url)
      } else if (e.type === 'login_done') {
        setBusy(false)
        setLoginUrl('')
        setLoginMsg('')
        if (e.status) setStatus(e.status)
      } else if (e.type === 'login_failed') {
        setBusy(false)
        setLoginMsg(e.message ?? '')
      }
    })
    return off
  }, [])

  async function startLogin() {
    setLoginMsg('')
    const r = await window.qingniao.mailLogin()
    if (r?.error) {
      setBusy(false)
      setLoginMsg(r.error)
    } else {
      setBusy(true)
    }
  }

  async function doLogout() {
    setBusy(true)
    try {
      setStatus(await window.qingniao.mailLogout())
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h3>
        <Mail size={15} /> {t('邮箱（Agent Mail）')}
      </h3>
      <p className="sec-tip">
        {t('授权后 AI 就能在对话里帮你收邮件、搜邮件、写邮件和发附件。')}
        {t('每次发信前 AI 都会先向你复述内容、经你确认才会真正发出。')}
      </p>

      {status === null && (
        <div className="plist-empty">{t('正在查询授权状态…')}</div>
      )}

      {status !== null && status.authorized && (
        <>
          <div className="mem-state" style={{ marginBottom: 10 }}>
            <ShieldCheck size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {t('已授权：{email}', { email: status.email ?? '' })}
          </div>
          <div className="mem-actions">
            <button className="ghost" disabled={busy} onClick={() => void doLogout()}>
              <LogOut size={13} /> {busy ? t('处理中…') : t('退出登录')}
            </button>
            <button className="ghost" disabled={busy} onClick={() => void refresh()}>
              {t('刷新状态')}
            </button>
          </div>
        </>
      )}

      {status !== null && !status.authorized && (
        <>
          <div className="plist-empty hint" style={{ marginBottom: 10 }}>
            {t('还没有授权 Agent Mail 邮箱。')}
            {status.error ? String(status.error) : ''}
          </div>
          <div className="mem-actions">
            <button className="primary" disabled={busy} onClick={() => void startLogin()}>
              {busy ? <LoaderCircle size={13} className="spin" /> : <Mail size={13} />}
              {busy ? t('等待浏览器授权…') : t('去授权')}
            </button>
          </div>
        </>
      )}

      {loginUrl && (
        <div className="plist-empty hint" style={{ marginTop: 8 }}>
          {t('若浏览器没有自动打开，点击这个链接完成授权：')}
          <br />
          <a
            href={loginUrl}
            onClick={(e) => {
              e.preventDefault()
              void window.qingniao.openExternal(loginUrl)
            }}
          >
            <ExternalLink size={12} style={{ verticalAlign: '-2px' }} /> {t('打开授权页')}
          </a>
        </div>
      )}

      {loginMsg && (
        <div className="plist-empty hint" style={{ marginTop: 8 }}>
          {loginMsg}
        </div>
      )}
    </section>
  )
}
