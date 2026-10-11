/**
 * 邮件业务编排：SMTP 配置的读写（settings 表 mail_* 键）、验证码的发送与校验。
 * 验证码三种用途：注册 / 验证码登录 / 超管换邮箱（purpose 区分，互不串用）。
 */
import type { Context } from 'hono'
import type { AppEnv } from '../auth.ts'
import { fail, rfc } from '../db.ts'
import { sendMail, type MailConfig } from './smtp.ts'

/** 验证码有效期（秒）与重发节流（毫秒）。 */
const CODE_TTL_S = 600
const SEND_INTERVAL_MS = 60_000

export type CodePurpose = 'register' | 'login' | 'email-change'

const PURPOSE_LABEL: Record<CodePurpose, string> = {
  register: '注册账号',
  login: '登录',
  'email-change': '更换邮箱'
}

async function setting(c: Context<AppEnv>, key: string): Promise<string> {
  const row = await c.env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>()
  return row?.value ?? ''
}

/** 读 SMTP 配置；host 为空视为未配置，返回 null。 */
export async function mailConfigOf(c: Context<AppEnv>): Promise<MailConfig | null> {
  const host = await setting(c, 'mail_host')
  if (!host) return null
  const secure = (await setting(c, 'mail_secure')) === 'starttls' ? 'starttls' : 'ssl'
  return {
    host,
    port: Number(await setting(c, 'mail_port')) || (secure === 'ssl' ? 465 : 587),
    user: await setting(c, 'mail_user'),
    pass: await setting(c, 'mail_pass'),
    from: await setting(c, 'mail_from') || (await setting(c, 'mail_user')),
    secure
  }
}

export async function isMailConfigured(c: Context<AppEnv>): Promise<boolean> {
  return (await mailConfigOf(c)) !== null
}

/** 保存一个配置键（UPSERT）。 */
export async function setSetting(c: Context<AppEnv>, key: string, value: string): Promise<void> {
  await c.env.DB
    .prepare(
      `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, rfc(), rfc())
    .run()
}

function code6(): string {
  const b = new Uint32Array(1)
  crypto.getRandomValues(b)
  return String(100000 + (b[0] % 900000))
}

function codeMailHtml(purpose: CodePurpose, code: string): string {
  return [
    '<div style="max-width:480px;margin:0 auto;padding:24px;font-family:-apple-system,\'Segoe UI\',\'PingFang SC\',sans-serif;color:#1f2937;">',
    '<h2 style="margin:0 0 12px;font-size:18px;">青鸟平台</h2>',
    `<p style="margin:0 0 16px;">你在进行 <b>${PURPOSE_LABEL[purpose]}</b> 操作，验证码为：</p>`,
    `<div style="font-size:30px;font-weight:700;letter-spacing:8px;padding:14px 20px;background:#f3f4f6;border-radius:10px;text-align:center;">${code}</div>`,
    '<p style="margin:16px 0 0;color:#6b7280;font-size:13px;">10 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>',
    '</div>'
  ].join('')
}

/**
 * 给邮箱发一个验证码。发码前检查：邮件已配置、同邮箱同用途 60 秒内没发过。
 * SMTP 发送失败按 502 透传原因（密码错 / 收件被拒等都得让管理员看见）。
 */
export async function sendCode(c: Context<AppEnv>, email: string, purpose: CodePurpose): Promise<void> {
  const cfg = await mailConfigOf(c)
  if (!cfg) throw fail(422, '邮件服务未配置，请先在后台「邮件设置」里配置 SMTP')

  const last = await c.env.DB
    .prepare(`SELECT created_at FROM mail_codes WHERE email = ? AND purpose = ?`)
    .bind(email, purpose)
    .first<{ created_at: string }>()
  if (last && Date.now() - new Date(last.created_at).getTime() < SEND_INTERVAL_MS) {
    throw fail(429, '验证码发送太频繁，请 1 分钟后再试')
  }

  const code = code6()
  await c.env.DB
    .prepare(
      `INSERT INTO mail_codes (email, purpose, code, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(email, purpose) DO UPDATE SET code = excluded.code, attempts = 0,
         expires_at = excluded.expires_at, created_at = excluded.created_at`
    )
    .bind(email, purpose, code, rfc(new Date(Date.now() + CODE_TTL_S * 1000)), rfc())
    .run()

  try {
    await sendMail(cfg, email, {
      subject: `青鸟验证码 ${code}`,
      html: codeMailHtml(purpose, code)
    })
  } catch (e) {
    throw fail(502, `验证码邮件发送失败：${(e as Error).message}`)
  }
}

/**
 * 校验验证码，通过即删除（一次性）。错 5 次作废；过期作废。
 * 失败与成功都以中文 message 抛 ApiError，调用方无需再包。
 */
export async function verifyCode(c: Context<AppEnv>, email: string, purpose: CodePurpose, code: string): Promise<void> {
  const row = await c.env.DB
    .prepare(`SELECT code, attempts, expires_at FROM mail_codes WHERE email = ? AND purpose = ?`)
    .bind(email, purpose)
    .first<{ code: string; attempts: number; expires_at: string }>()
  if (!row) throw fail(422, '请先获取验证码')
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await c.env.DB.prepare(`DELETE FROM mail_codes WHERE email = ? AND purpose = ?`).bind(email, purpose).run()
    throw fail(422, '验证码已过期，请重新获取')
  }
  if (row.attempts >= 5) {
    await c.env.DB.prepare(`DELETE FROM mail_codes WHERE email = ? AND purpose = ?`).bind(email, purpose).run()
    throw fail(422, '错误次数过多，请重新获取验证码')
  }
  if (row.code !== code.trim()) {
    await c.env.DB
      .prepare(`UPDATE mail_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?`)
      .bind(email, purpose)
      .run()
    throw fail(422, '验证码不正确')
  }
  await c.env.DB.prepare(`DELETE FROM mail_codes WHERE email = ? AND purpose = ?`).bind(email, purpose).run()
}

/** 邮箱形状校验（与服务端原有的注册校验同口径）。 */
export function validEmail(email: string): boolean {
  const at = email.indexOf('@')
  return (
    at > 0 &&
    at !== email.length - 1 &&
    email.slice(at).includes('.') &&
    !/\s/.test(email) &&
    email.length <= 120
  )
}
