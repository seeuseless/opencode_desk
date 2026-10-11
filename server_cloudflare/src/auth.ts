import type { Context, MiddlewareHandler } from 'hono'
import type { Env, TokenRow, UserRow } from './db.ts'
import { fail, sha256Hex } from './db.ts'

/** 全应用统一的 Hono 环境类型（auth 中间件会往 Variables 里放 user/token）。 */
export type AppEnv = { Bindings: Env; Variables: { user: UserRow; token: TokenRow } }

/**
 * Bearer 鉴权中间件（对应 Go 版 api/auth.go）。
 *
 * 401 一律回 JSON（桌面端与手机端都不是浏览器）：{"message": "未登录或授权已失效"}。
 * token 明文 = "{id}|{64hex}"，库里只存 SHA-256；expires_at 为空 = 永不过期。
 */
export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const plain = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
    if (!plain) return c.json({ message: '未登录或授权已失效' }, 401)

    const hash = await sha256Hex(plain)
    const tok = await c.env.DB.prepare(
      `SELECT id, user_id, name, token_hash, expires_at FROM personal_access_tokens WHERE token_hash = ?`
    )
      .bind(hash)
      .first<{ id: number; user_id: number; name: string; token_hash: string; expires_at: string | null }>()
    if (!tok) return c.json({ message: '未登录或授权已失效' }, 401)
    if (tok.expires_at && new Date(tok.expires_at).getTime() < Date.now()) {
      return c.json({ message: '未登录或授权已失效' }, 401)
    }

    const user = await c.env.DB.prepare(
      `SELECT id, name, email, password, role, points, status, created_at, updated_at FROM users WHERE id = ?`
    )
      .bind(tok.user_id)
      .first<UserRow>()
    if (!user || user.status !== 'active') return c.json({ message: '未登录或授权已失效' }, 401)

    c.set('user', user)
    c.set('token', { id: tok.id, user_id: tok.user_id, name: tok.name, expires_at: tok.expires_at })
    await next()
  }

/** 当前登录用户（auth 之后调用）。 */
export function userOf(c: Context<AppEnv>): UserRow {
  return c.get('user')
}

/** 当前令牌。 */
export function tokenOf(c: Context<AppEnv>): TokenRow {
  return c.get('token')
}

/** 管理员守卫（挂 auth 之后）：非 admin 403「需要管理员权限」。 */
export function requireAdmin(c: Context<AppEnv>): UserRow {
  const u = userOf(c)
  if (u.role !== 'admin') throw fail(403, '需要管理员权限')
  return u
}

export const isAdmin = (u: UserRow): boolean => u.role === 'admin'

/** 用户对外表示（契约 1.1 的 user 对象；role 是前端判断管理员要用的）。 */
export function userPayload(u: UserRow): Record<string, unknown> {
  return { id: u.id, name: u.name, email: u.email, role: u.role }
}
