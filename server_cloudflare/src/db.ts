/**
 * 基础设施：D1 助手、时间格式、随机串、哈希、错误与分页。
 *
 * 时间存储口径（与 Go 版对齐）：全部存 RFC3339 UTC（固定毫秒 3 位，保证字符串比较/排序正确）；
 * 展示格式（Y-m-d H:i:s 等）按 UTC 格式化——Go 版跑在用户本机是本地时区，云版统一 UTC。
 * 统计口径的「日界」用 TZ_HOURS 环境变量（默认 +8，贴合 Go 版在北京的本机体验）。
 */

export interface Env {
  DB: D1Database
  PUBLIC_URL: string
  TZ_HOURS: string
  PBKDF2_ITERS: string
}

/** 带 auth 中间件注入的上下文值 */
export interface AuthCtx {
  user: UserRow
  token: TokenRow
}

export interface UserRow {
  id: number
  name: string
  email: string
  password: string
  role: string
  points: number
  status: string
  created_at: string
  updated_at: string
}

export interface TokenRow {
  id: number
  user_id: number
  name: string
  expires_at: string | null
}

// ---------- 错误 ----------

/** 带状态码的业务错误，message 是给用户看的中文可读原因。 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const fail = (status: number, message: string): ApiError => new ApiError(status, message)

/**
 * 把后台任务挂到运行时的后台：Workers 用 waitUntil（响应返回后继续跑完），
 * 本地长驻进程没有 executionCtx，直接丢着跑即可。计费、登录日志这类不阻塞响应的活都走它。
 */
export function runBg(c: { executionCtx: { waitUntil: (p: Promise<unknown>) => void } }, p: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(p)
  } catch {
    p.catch(() => {})
  }
}

// ---------- 时间 ----------

/** 当前时刻的 RFC3339 UTC（固定毫秒 3 位），全库统一用它做时间戳。 */
export function rfc(d = new Date()): string {
  return d.toISOString() // toISOString 固定输出 YYYY-MM-DDTHH:mm:ss.sssZ
}

/** RFC3339 字符串 → Date；空/非法返回 null。 */
export function parseTime(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/** 'YYYY-MM-DD HH:mm:ss'（UTC）；空返回 null（对应 Go fmtTime 的零值 → null）。 */
export function fmtTime(s: string | null | undefined): string | null {
  const d = parseTime(s)
  if (!d) return null
  return fmtOf(d, ':')
}

/** 'YYYY-MM-DD HH:mm'（UTC），积分流水用。 */
export function fmtMinute(s: string | null | undefined): string | null {
  const d = parseTime(s)
  if (!d) return null
  return fmtOf(d, ':').slice(0, 16)
}

function fmtOf(d: Date, _sep: string): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  )
}

/** token 过期时间的 ISO 格式（契约：ISO8601）。 */
export function fmtISO(s: string | null | undefined): string | null {
  const d = parseTime(s)
  return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : null
}

/** 'YYYY-MM-DD'（UTC 日期）。 */
export function fmtDate(s: string | number | Date): string {
  return new Date(s).toISOString().slice(0, 10)
}

/** 统计口径的时区偏移（小时，默认 +8）。 */
export function tzHours(env: Env): number {
  const n = Number(env.TZ_HOURS)
  return Number.isFinite(n) ? n : 8
}

/** 时区感知的「当天起点」→ UTC 时间戳字符串。 */
export function dayStartUTC(d: Date, tz: number): Date {
  const shifted = new Date(d.getTime() + tz * 3600_000)
  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return new Date(base - tz * 3600_000)
}

// ---------- 随机与哈希 ----------

export function randHex(bytes: number): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * 密码哈希：PBKDF2-SHA256（Web Crypto 原生；Go 版的 scrypt 在 Workers 上不可用，
 * 云库是全新建的不需要互认）。格式 `pbkdf2$iters$salt$hash`。
 */
export async function hashPassword(pw: string, iters: number): Promise<string> {
  const salt = randHex(16)
  const hash = await pbkdf2(pw, salt, iters)
  return `pbkdf2$${iters}$${salt}$${hash}`
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const hash = await pbkdf2(pw, parts[2], Number(parts[1]))
  return hash === parts[3]
}

async function pbkdf2(pw: string, salt: string, iters: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: iters },
    key,
    256
  )
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// ---------- 请求工具 ----------

/** 解析 JSON 请求体；空体/坏 JSON 一律 422「请求体不是合法 JSON」（与 Go decodeJSON 一致）。 */
export async function body<T = Record<string, unknown>>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    throw fail(422, '请求体不是合法 JSON')
  }
}

export function queryInt(c: { req: { query: (k: string) => string | undefined } }, key: string, def: number): number {
  const raw = c.req.query(key)
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? Math.trunc(n) : def
}

/** 每页条数：默认 20，最大 100。 */
export function clampPerPage(n: number): number {
  if (n <= 0) return 20
  return n > 100 ? 100 : n
}

/** 分页信封：客户端要页码、总数、总页数三样才能画翻页条。 */
export function pageEnvelope(items: unknown[], total: number, page: number, per: number): Record<string, unknown> {
  return { items, total, page, per_page: per, pages: per > 0 ? Math.ceil(total / per) : 0 }
}

/** 按字符截断（Go 版按字节，这里等价用于设备名/UA 这类短字段的限长）。 */
export function trimLen(s: string | undefined | null, n: number): string {
  const v = (s ?? '').trim()
  return v.length <= n ? v : v.slice(0, n)
}

/** null → null，空串 → null（响应里的可选文本字段）。 */
export function nullIfEmpty(s: string | null | undefined): string | null {
  return s ? s : null
}

export function intOrNull(v: number): number | null {
  return v > 0 ? v : null
}

/** 解析路径参数里的整数；不合法 404「参数 {name} 不是数字」。 */
export function paramInt(c: { req: { param: (k: string) => string | undefined } }, name: string): number {
  const raw = c.req.param(name)
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw fail(404, `参数 ${name} 不是数字`)
  return n
}

/** 请求客户端 IP（CF 会给真实 IP 头）。 */
export function clientIP(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || ''
}

/** 对外基地址：显式 PUBLIC_URL 优先，否则按请求 origin。 */
export function baseURL(c: { req: { url: string } }, env: Env): string {
  const explicit = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '')
  if (explicit) return explicit
  return new URL(c.req.url).origin
}
