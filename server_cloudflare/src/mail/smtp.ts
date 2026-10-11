/**
 * 最小 SMTP 客户端（node:net + node:tls，Workers 的 nodejs_compat 与本地 Node 两端通用）。
 * 只做发信需要的那一小段会话：EHLO →(STARTTLS)→ AUTH LOGIN → MAIL/RCPT/DATA → QUIT。
 * 全程命令级 30 秒超时，失败即断连；正文走 base64 避免编码与 dot-stuffing 的坑。
 */
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { Buffer } from 'node:buffer'

/** SMTP 发信配置（来自 settings 表的 mail_* 键）。 */
export interface MailConfig {
  host: string
  port: number
  user: string
  pass: string
  /** 发件人邮箱（也是 EHLO 的域名来源） */
  from: string
  /** 'ssl' = 465 直连 TLS；'starttls' = 587 明文连再升级 */
  secure: 'ssl' | 'starttls'
}

type Conn = Socket | TLSSocket

/** 一条 SMTP 响应（多行合并；code 取最后一行的状态码）。 */
interface Reply {
  code: number
  text: string
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

/** 等一条完整响应：最后一行形如 "XXX "（空格）才算结束，"XXX-" 是多行续行。 */
function readReply(conn: Conn): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const cleanup = () => {
      clearTimeout(timer)
      conn.off('data', onData)
      conn.off('error', onErr)
      conn.off('close', onErr)
    }
    const onErr = (e?: Error) => {
      cleanup()
      reject(e ?? new Error('SMTP 连接中断'))
    }
    const onData = (d: Buffer) => {
      buf += d.toString('utf8')
      const lines = buf.split('\r\n')
      if (lines.length >= 2 && /^\d{3} /.test(lines[lines.length - 2])) {
        const body = lines.slice(0, -1)
        cleanup()
        resolve({
          code: parseInt(body[body.length - 1].slice(0, 3), 10),
          text: body.join(' ')
        })
      }
    }
    const timer = setTimeout(() => onErr(new Error('SMTP 响应超时（30 秒）')), 30_000)
    conn.on('data', onData)
    conn.on('error', onErr)
    conn.on('close', () => onErr())
  })
}

async function cmd(conn: Conn, line: string, ...expect: number[]): Promise<Reply> {
  const writeOk = conn.write(line + '\r\n')
  if (!writeOk) await new Promise<void>((r) => conn.once('drain', r))
  const reply = await readReply(conn)
  if (!expect.includes(reply.code)) {
    throw new Error(`SMTP ${reply.code}: ${reply.text.slice(0, 200)}`)
  }
  return reply
}

/** 等连接/握手就绪。 */
function ready(conn: Conn, event: 'connect' | 'secureConnect'): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      conn.off(event, onOk)
      conn.off('error', onErr)
    }
    const onOk = () => {
      cleanup()
      resolve(conn)
    }
    const onErr = (e?: Error) => {
      cleanup()
      reject(e ?? new Error('SMTP 连接失败'))
    }
    const timer = setTimeout(() => onErr(new Error('SMTP 连接超时（30 秒）')), 30_000)
    conn.on(event, onOk)
    conn.on('error', onErr)
  })
}

/** 邮件正文（HTML）。 */
export interface MailBody {
  subject: string
  html: string
}

/** 组 MIME 报文：头里 Subject 用 UTF-8 base64 词编码，正文整段 base64。 */
function buildMime(from: string, to: string, mail: MailBody): string {
  const head = [
    `From: =?UTF-8?B?${b64('青鸟平台')}?= <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(mail.subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    // base64 字符集不含 '.'，天然免疫 DATA 结束符；仍按 76 列折行
    (b64(mail.html).match(/.{1,76}/g) ?? []).join('\r\n')
  ]
  return head.join('\r\n')
}

/** 发一封邮件。任何一步不合预期都抛中文可读错误，由调用方转成 502。 */
export async function sendMail(cfg: MailConfig, to: string, mail: MailBody): Promise<void> {
  const ehloName = cfg.from.includes('@') ? cfg.from.split('@')[1] : 'localhost'
  let conn: Conn =
    cfg.secure === 'ssl'
      ? await ready(tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }), 'secureConnect')
      : await ready(netConnect({ host: cfg.host, port: cfg.port }), 'connect')
  try {
    const greet = await readReply(conn) // 服务器先打招呼
    if (greet.code !== 220) throw new Error(`SMTP ${greet.code}: ${greet.text.slice(0, 200)}`)
    if (cfg.secure === 'starttls') {
      await cmd(conn, `EHLO ${ehloName}`, 250)
      await cmd(conn, 'STARTTLS', 220)
      conn = await ready(tlsConnect({ socket: conn as Socket, servername: cfg.host }), 'secureConnect')
    }
    await cmd(conn, `EHLO ${ehloName}`, 250)
    if (cfg.user) {
      await cmd(conn, 'AUTH LOGIN', 334)
      await cmd(conn, b64(cfg.user), 334)
      await cmd(conn, b64(cfg.pass), 235)
    }
    await cmd(conn, `MAIL FROM:<${cfg.from}>`, 250)
    await cmd(conn, `RCPT TO:<${to}>`, 250, 251)
    await cmd(conn, 'DATA', 354)
    await cmd(conn, buildMime(cfg.from, to, mail) + '\r\n.', 250)
    await cmd(conn, 'QUIT', 221).catch(() => {}) // 对端可能先关连接，QUIT 失败不影响结果
  } finally {
    conn.destroy()
  }
}
