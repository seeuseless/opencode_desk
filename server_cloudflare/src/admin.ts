/**
 * 后台管理与网页登录：/api/settings、/api/auth/*、/api/admin/*（契约第 6 节 + 登录页链路）。
 * 与 Go 版 admin_handler.go / auth_handler.go 逐字段对齐。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env, UserRow } from './db.ts'
import {
  body,
  checkPassword,
  clampPerPage,
  clientIP,
  fail,
  fmtDate,
  fmtMinute,
  fmtTime,
  hashPassword,
  pageEnvelope,
  paramInt,
  queryInt,
  randHex,
  rfc,
  sha256Hex,
  trimLen
} from './db.ts'
import { auth, userOf, userPayload, type AppEnv } from './auth.ts'
import { isMailConfigured, mailConfigOf, sendCode, setSetting, validEmail, verifyCode } from './mail/index.ts'
import { sendMail } from './mail/smtp.ts'
import {
  adjustPoints,
  availableUpstreamModels,
  effectiveRatio,
  findUser,
  matchAllUpstreamModels,
  matchUpstreamModels,
  typeLabel,
  usageRange,
  type Model
} from './ai.ts'
import { importModels, probeKey, syncModels, testKey, testModel, testUpstream } from './upstream.ts'
import { DEVICE_ONLINE_MS } from './device.ts'

export const admin = new Hono<AppEnv>()

// ---------- 公开：设置 / 登录 / 注册 ----------

/** GET /api/settings — 后台界面要用的公开设置（站点名 + 邮件是否已配置，登录页据此选默认登录方式）。 */
admin.get('/settings', async (c) => {
  return c.json({
    mall_name: await settingOf(c, 'mall_name', '青鸟平台'),
    logo_url: await settingOf(c, 'logo_url', ''),
    mail_configured: await isMailConfigured(c)
  })
})

async function settingOf(c: Context<AppEnv>, key: string, def: string): Promise<string> {
  const row = await c.env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>()
  return row?.value || def
}

/** POST /api/auth/login — 登录（后台前端与桌面端登录页用），发 1 年 token。
 *  两种方式：password = 账号密码（管理员兜底）；code = 邮箱验证码（邮件配置后的主方式）。 */
admin.post('/auth/login', async (c) => {
  const req = await body<{ email?: string; password?: string; code?: string }>(c)
  const email = (req.email ?? '').trim().toLowerCase()
  if (!email) throw fail(422, '请输入邮箱')
  let u: UserRow | null
  if ((req.code ?? '').trim()) {
    await verifyCode(c, email, 'login', req.code!.trim())
    u = await findUserByEmail(c.env.DB, email)
    if (!u) throw fail(404, '该邮箱尚未注册')
  } else {
    if (!req.password) throw fail(422, '请输入密码或邮箱验证码')
    u = await findUserByEmail(c.env.DB, email)
    if (!u) throw fail(422, '邮箱或密码不正确')
    if (!u.password) throw fail(422, '该账号未设置密码，请使用邮箱验证码登录')
    if (!(await checkPassword(req.password, u.password))) throw fail(422, '邮箱或密码不正确')
  }
  if (u.status !== 'active') throw fail(403, '账号已被禁用')
  const plain = await issueToken(c, u.id, 'web', Date.now() + 365 * 86400_000)
  await addLoginLog(c, u.id, '后台')
  return c.json({ token: plain, user: userPayload(u) })
})

/** 安装包附件命名（与 electron-builder artifactName + release.yml 完全一致）：按 tag 拼出下载直链，枚举全部架构。 */
const UPGRADE_ASSET_NAMES = [
  'QingNiao-Setup.exe',
  'QingNiao-Setup-arm64.exe',
  'QingNiao-Setup-x64.dmg',
  'QingNiao-Setup-arm64.dmg',
  'QingNiao-Setup-x86_64.AppImage',
  'QingNiao-Setup-arm64.AppImage',
  'QingNiao-Setup-amd64.deb',
  'QingNiao-Setup-arm64.deb'
]
const UPGRADE_REPO = 'seeuseless/opencode_desk'

/**
 * GET /api/upgrade — 桌面端检查新版本时优先走这里：国内 api.github.com 常被墙，服务端在 CF 出口可达 GitHub，
 *  代拉最新正式发布的概要（结构与 GitHub release 对齐，客户端复用版本比较与附件挑选）。
 *  数据源用 **releases.atom（RSS 发布源）**而不是 GitHub REST API：RSS 走静态托管、不受 API 限流配额
 *  （未认证 API 按共享出口 IP 60 次/时，多客户端一起查极易 403——用户看到的「GitHub 接口限流」正是这个）。
 *  附件直链按既定命名规则由 tag 拼出，不再逐次拉 assets。Cache API 缓存 10 分钟进一步摊薄。 */
admin.get('/upgrade', async (c) => {
  const id = `upgrade:${new Date(Math.floor(Date.now() / 600_000) * 600_000).toISOString()}`
  const hit = await caches.default?.match(new Request(`https://api.github.com/__qn_upgrade_cache__/${id}`))
  if (hit) return new Response(await hit.text(), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
  try {
    const atom = await (await fetch(`https://github.com/${UPGRADE_REPO}/releases.atom`, {
      headers: { 'User-Agent': 'qingniao-server' },
      signal: AbortSignal.timeout(8000)
    })).text()
    // 首个「形如 vX.Y.Z」的 entry 标题即最新正式版本（跳过 feed 主标题与可能的预发布后缀）
    const tag = [...atom.matchAll(/<title>([^<]+)<\/title>/g)]
      .map((m) => m[1].trim())
      .find((t) => /^v\d+\.\d+\.\d+$/.test(t))
    if (!tag) throw new Error('发布源里没读到版本')
    const content = (atom.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || ''
    const body = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
    const assets = UPGRADE_ASSET_NAMES.map((name) => ({
      name,
      browser_download_url: `https://github.com/${UPGRADE_REPO}/releases/download/${tag}/${name}`,
      size: 0
    }))
    const payload = JSON.stringify({
      ok: true,
      tag_name: tag,
      body,
      html_url: `https://github.com/${UPGRADE_REPO}/releases/tag/${tag}`,
      published_at: '',
      assets
    })
    const req = new Request(`https://api.github.com/__qn_upgrade_cache__/${id}`)
    const resp = new Response(payload, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=600' } })
    await caches.default?.put(req, resp.clone())
    return resp
  } catch (e) {
    return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 502)
  }
})

/** POST /api/auth/send-code — 发邮箱验证码（公开接口）。purpose：register=注册 / login=验证码登录。 */
admin.post('/auth/send-code', async (c) => {
  const req = await body<{ email?: string; purpose?: string }>(c)
  const email = (req.email ?? '').trim().toLowerCase()
  if (!validEmail(email)) throw fail(422, '邮箱格式不正确')
  const purpose = req.purpose === 'login' ? 'login' : 'register'
  if (purpose === 'register') {
    if (await findUserByEmail(c.env.DB, email)) throw fail(409, '该邮箱已注册，请直接登录')
  } else if (!(await findUserByEmail(c.env.DB, email))) {
    throw fail(404, '该邮箱尚未注册')
  }
  await sendCode(c, email, purpose)
  return c.json({ message: '验证码已发送，请查收邮箱' })
})

/** POST /api/auth/register — 注册新账号（公开接口；建出来的都是 member，第一个账号自动 admin）。
 *  注册 = 邮箱 + 邮件验证码，不设密码（之后登录走验证码）；注册成功直接发 token（自动登录）。
 *  例外：users 空表 = 初始化窗口——免验证码、允许顺带设置管理员兜底密码
 *  （全新部署时邮件必然还没配，窗口不放开就没人能成为第一个管理员）。 */
admin.post('/auth/register', async (c) => {
  const req = await body<{ email?: string; name?: string; code?: string; password?: string }>(c)
  const email = (req.email ?? '').trim().toLowerCase()
  const name = (req.name ?? '').trim()
  if (!validEmail(email)) throw fail(422, '邮箱格式不正确')

  const count = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>())?.n ?? 0
  if (count > 0) await verifyCode(c, email, 'register', (req.code ?? '').trim())

  let hash = ''
  if (count === 0 && (req.password ?? '').trim()) {
    const pass = req.password!.trim()
    if (pass.length < 6 || pass.length > 72) throw fail(422, '密码长度需在 6~72 位之间')
    hash = await hashPassword(pass, pbkdf2Iters(c.env))
  }

  let finalName = name || email.slice(0, email.indexOf('@'))
  finalName = trimLen(finalName, 60)
  if (!finalName) throw fail(422, '请填写账号名')

  if (await findUserByEmail(c.env.DB, email)) throw fail(409, '该邮箱已注册，请直接登录')

  const now = rfc()
  const r = await c.env.DB
    .prepare(
      `INSERT INTO users (name, email, password, role, points, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`
    )
    .bind(finalName, email, hash, count === 0 ? 'admin' : 'member', now, now)
    .run()
  const u = (await findUser(c.env.DB, r.meta.last_row_id ?? 0))!
  const plain = await issueToken(c, u.id, 'web', Date.now() + 365 * 86400_000)
  await addLoginLog(c, u.id, '注册')
  return c.json({ token: plain, user: userPayload(u) })
})

/** GET /api/auth/me — 当前登录者。 */
admin.get('/auth/me', auth, (c) => c.json({ user: userPayload(userOf(c)) }))

// ---------- 内部（鉴权部分共用） ----------

export function pbkdf2Iters(env: Env): number {
  const n = Number(env.PBKDF2_ITERS)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 100_000
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT id, name, email, password, role, points, status, created_at, updated_at FROM users WHERE email = ?`)
    .bind(email)
    .first<UserRow>()
}

async function issueToken(
  c: Context<AppEnv>,
  userID: number,
  name: string,
  expiresAt: number
): Promise<string> {
  const hex = randHex(32)
  const r = await c.env.DB
    .prepare(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, ip_address, user_agent, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userID,
      name,
      await sha256Hex('pending'),
      clientIP(c),
      trimLen(c.req.header('User-Agent'), 500),
      new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      rfc()
    )
    .run()
  const id = r.meta.last_row_id ?? 0
  const plain = `${id}|${hex}`
  await c.env.DB.prepare(`UPDATE personal_access_tokens SET token_hash = ? WHERE id = ?`).bind(await sha256Hex(plain), id).run()
  return plain
}

async function addLoginLog(c: Context<AppEnv>, userID: number, device: string): Promise<void> {
  await c.env.DB
    .prepare(`INSERT INTO login_logs (user_id, ip_address, device, user_agent, login_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(userID, clientIP(c), device, trimLen(c.req.header('User-Agent'), 500), rfc(), rfc())
    .run()
}

// ---------- 管理接口（auth + admin 双守卫） ----------

/** 管理接口统一挂在 mgmt 子路由：auth + admin 双守卫。 */
const mgmt = new Hono<AppEnv>()
mgmt.use('*', auth, async (c, next) => {
  if (userOf(c).role !== 'admin') throw fail(403, '需要管理员权限')
  await next()
})

interface UpstreamRow {
  id: number
  name: string
  driver: string
  base_url: string
  enabled: number
  sort: number
  remark: string
  models_synced_at: string | null
}

function maskKey(k: string): string {
  if (k.length <= 10) return '*'.repeat(k.length)
  return k.slice(0, 4) + '*'.repeat(k.length - 8) + k.slice(-4)
}

async function upstreamPayload(c: Context<AppEnv>, u: UpstreamRow): Promise<Record<string, unknown>> {
  const keys = await c.env.DB
    .prepare(
      `SELECT id, name, api_key, enabled, status, latency_ms, last_error, last_checked_at, last_used_at
       FROM ai_upstream_keys WHERE upstream_id = ? ORDER BY id ASC`
    )
    .bind(u.id)
    .all<{
      id: number
      name: string
      api_key: string
      enabled: number
      status: string
      latency_ms: number | null
      last_error: string | null
      last_checked_at: string | null
      last_used_at: string | null
    }>()
  const models = await c.env.DB
    .prepare(
      `SELECT id, model_id, model, enabled, status, latency_ms, last_error, last_checked_at
       FROM ai_upstream_models WHERE upstream_id = ? ORDER BY id ASC`
    )
    .bind(u.id)
    .all<{
      id: number
      model_id: number | null
      model: string
      enabled: number
      status: string
      latency_ms: number | null
      last_error: string | null
      last_checked_at: string | null
    }>()
  return {
    id: u.id,
    name: u.name,
    driver: u.driver,
    base_url: u.base_url,
    enabled: !!u.enabled,
    sort: u.sort,
    remark: u.remark,
    models_synced_at: fmtTime(u.models_synced_at),
    keys: (keys.results ?? []).map((k) => ({
      id: k.id,
      name: k.name,
      masked: maskKey(k.api_key),
      enabled: !!k.enabled,
      status: k.status,
      latency_ms: k.latency_ms,
      last_error: k.last_error,
      last_checked_at: fmtTime(k.last_checked_at),
      last_used_at: fmtTime(k.last_used_at)
    })),
    models: (models.results ?? []).map((m) => ({
      id: m.id,
      model_id: m.model_id,
      model: m.model,
      enabled: !!m.enabled,
      status: m.status,
      latency_ms: m.latency_ms,
      last_error: m.last_error,
      last_checked_at: fmtTime(m.last_checked_at)
    }))
  }
}

async function findUpstreamRow(c: Context<AppEnv>, id: number): Promise<UpstreamRow> {
  const u = await c.env.DB
    .prepare(`SELECT id, name, driver, base_url, enabled, sort, remark, models_synced_at FROM ai_upstreams WHERE id = ?`)
    .bind(id)
    .first<UpstreamRow>()
  if (!u) throw fail(404, '上游不存在')
  return u
}

mgmt.get('/ai-upstreams', async (c) => {
  const r = await c.env.DB
    .prepare(`SELECT id, name, driver, base_url, enabled, sort, remark, models_synced_at FROM ai_upstreams ORDER BY sort ASC, id ASC`)
    .all<UpstreamRow>()
  const out: Record<string, unknown>[] = []
  for (const u of r.results ?? []) out.push(await upstreamPayload(c, u))
  return c.json(out)
})

mgmt.post('/ai-upstreams', async (c) => {
  const req = await body<{ name?: string; driver?: string; base_url?: string; enabled?: boolean; sort?: number; remark?: string }>(c)
  const name = (req.name ?? '').trim()
  if (!name) throw fail(422, '请填写上游名称')
  const baseUrl = (req.base_url ?? '').trim()
  if (!baseUrl) throw fail(422, '请填写 Base URL')
  const driver = (req.driver ?? '').trim() || 'openai'
  const now = rfc()
  const r = await c.env.DB
    .prepare(
      `INSERT INTO ai_upstreams (name, driver, base_url, enabled, sort, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(name, driver, baseUrl, req.enabled === false ? 0 : 1, Math.trunc(req.sort ?? 0) || 0, req.remark ?? '', now, now)
    .run()
  return c.json(await upstreamPayload(c, await findUpstreamRow(c, r.meta.last_row_id ?? 0)))
})

mgmt.get('/ai-upstreams/:id', async (c) => {
  return c.json(await upstreamPayload(c, await findUpstreamRow(c, paramInt(c, 'id'))))
})

mgmt.put('/ai-upstreams/:id', async (c) => {
  const id = paramInt(c, 'id')
  const u = await findUpstreamRow(c, id)
  const req = await body<{ name?: string; driver?: string; base_url?: string; enabled?: boolean; sort?: number; remark?: string }>(c)
  const name = (req.name ?? '').trim()
  if (!name) throw fail(422, '请填写上游名称')
  const baseUrl = (req.base_url ?? '').trim()
  if (!baseUrl) throw fail(422, '请填写 Base URL')
  const driver = (req.driver ?? '').trim() || u.driver
  await c.env.DB
    .prepare(`UPDATE ai_upstreams SET name = ?, driver = ?, base_url = ?, enabled = ?, sort = ?, remark = ?, updated_at = ? WHERE id = ?`)
    .bind(name, driver, baseUrl, req.enabled === false ? 0 : 1, Math.trunc(req.sort ?? 0) || 0, req.remark ?? '', rfc(), id)
    .run()
  return c.json(await upstreamPayload(c, await findUpstreamRow(c, id)))
})

mgmt.delete('/ai-upstreams/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM ai_upstreams WHERE id = ?`).bind(paramInt(c, 'id')).run()
  return c.json({ message: '已删除' })
})

mgmt.post('/ai-upstreams/:id/keys', async (c) => {
  const id = paramInt(c, 'id')
  await findUpstreamRow(c, id)
  const req = await body<{ name?: string; api_key?: string; enabled?: boolean }>(c)
  const apiKey = (req.api_key ?? '').trim()
  if (!apiKey) throw fail(422, '请填写 API Key')
  const now = rfc()
  const r = await c.env.DB
    .prepare(
      `INSERT INTO ai_upstream_keys (upstream_id, name, api_key, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'unknown', ?, ?)`
    )
    .bind(id, req.name ?? '', apiKey, req.enabled === false ? 0 : 1, now, now)
    .run()
  return c.json({ id: r.meta.last_row_id ?? 0, message: '已添加' })
})

async function findKeyRow(c: Context<AppEnv>, keyID: number): Promise<{ id: number; upstream_id: number; name: string; api_key: string; enabled: number }> {
  const k = await c.env.DB
    .prepare(`SELECT id, upstream_id, name, api_key, enabled FROM ai_upstream_keys WHERE id = ?`)
    .bind(keyID)
    .first<{ id: number; upstream_id: number; name: string; api_key: string; enabled: number }>()
  if (!k) throw fail(404, 'Key 不存在')
  return k
}

mgmt.put('/ai-upstreams/keys/:key', async (c) => {
  const k = await findKeyRow(c, paramInt(c, 'key'))
  const req = await body<{ name?: string; api_key?: string; enabled?: boolean }>(c)
  const apiKey = (req.api_key ?? '').trim()
  await c.env.DB
    .prepare(`UPDATE ai_upstream_keys SET name = ?, api_key = ?, enabled = ?, updated_at = ? WHERE id = ?`)
    .bind(req.name ?? k.name, apiKey || k.api_key, req.enabled === false ? 0 : req.enabled === true ? 1 : k.enabled, rfc(), k.id)
    .run()
  return c.json({ message: '已保存' })
})

mgmt.delete('/ai-upstreams/keys/:key', async (c) => {
  await findKeyRow(c, paramInt(c, 'key'))
  await c.env.DB.prepare(`DELETE FROM ai_upstream_keys WHERE id = ?`).bind(paramInt(c, 'key')).run()
  return c.json({ message: '已删除' })
})

mgmt.post('/ai-upstreams/keys/:key/test', async (c) => {
  const k = await findKeyRow(c, paramInt(c, 'key'))
  const up = await findUpstreamRow(c, k.upstream_id)
  return c.json(await testKey(c.env.DB, { ...k, status: 'unknown', latency_ms: null, last_error: null, last_checked_at: null, last_used_at: null }, up.base_url))
})

mgmt.post('/ai-upstreams/keys/:key/probe', async (c) => {
  const k = await findKeyRow(c, paramInt(c, 'key'))
  const up = await findUpstreamRow(c, k.upstream_id)
  return c.json(
    await probeKey(
      c.env.DB,
      { ...k, status: 'unknown', latency_ms: null, last_error: null, last_checked_at: null, last_used_at: null },
      k.upstream_id,
      up.base_url
    )
  )
})

mgmt.post('/ai-upstreams/:id/sync', async (c) => {
  const id = paramInt(c, 'id')
  const up = await findUpstreamRow(c, id)
  return c.json(await syncModels(c.env.DB, id, up.base_url))
})

mgmt.post('/ai-upstreams/:id/import-models', async (c) => {
  const req = await body<{ models?: string[]; builtin?: boolean; ratio?: number }>(c)
  return c.json(await importModels(c.env.DB, paramInt(c, 'id'), req.models, !!req.builtin, Number(req.ratio) || 0))
})

mgmt.post('/ai-upstreams/:id/models', async (c) => {
  const id = paramInt(c, 'id')
  await findUpstreamRow(c, id)
  const req = await body<{ model?: string }>(c)
  const model = (req.model ?? '').trim()
  if (!model) throw fail(422, '请填写模型名')
  await c.env.DB
    .prepare(
      `INSERT INTO ai_upstream_models (upstream_id, model_id, model, enabled, status, created_at, updated_at)
       SELECT ?, NULL, ?, 1, 'unknown', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM ai_upstream_models WHERE upstream_id = ? AND model = ?)`
    )
    .bind(id, model, rfc(), rfc(), id, model)
    .run()
  return c.json({ message: '已保存' })
})

mgmt.post('/ai-upstreams/:id/test', async (c) => {
  const up = await findUpstreamRow(c, paramInt(c, 'id'))
  return c.json(await testUpstream(c.env.DB, up.id, up.base_url))
})

async function findUpstreamModelRow(c: Context<AppEnv>, id: number) {
  const m = await c.env.DB
    .prepare(`SELECT id, upstream_id, model_id, model, enabled, status, latency_ms, last_error, last_checked_at FROM ai_upstream_models WHERE id = ?`)
    .bind(id)
    .first<{ id: number; upstream_id: number; model_id: number | null; model: string; enabled: number; status: string; latency_ms: number | null; last_error: string | null; last_checked_at: string | null }>()
  if (!m) throw fail(404, '上游模型不存在')
  return m
}

mgmt.put('/ai-upstreams/models/:model', async (c) => {
  const m = await findUpstreamModelRow(c, paramInt(c, 'model'))
  const req = await body<{ enabled?: boolean; model?: string }>(c)
  const model = (req.model ?? '').trim() || m.model
  const enabled = req.enabled === true ? 1 : req.enabled === false ? 0 : m.enabled
  await c.env.DB
    .prepare(`UPDATE ai_upstream_models SET model = ?, enabled = ?, updated_at = ? WHERE id = ?`)
    .bind(model, enabled, rfc(), m.id)
    .run()
  return c.json({ message: '已保存' })
})

mgmt.delete('/ai-upstreams/models/:model', async (c) => {
  await findUpstreamModelRow(c, paramInt(c, 'model'))
  await c.env.DB.prepare(`DELETE FROM ai_upstream_models WHERE id = ?`).bind(paramInt(c, 'model')).run()
  return c.json({ message: '已删除' })
})

// ---------- 模型库 ----------

async function modelAdminPayload(c: Context<AppEnv>, m: Model): Promise<Record<string, unknown>> {
  const avail = await availableUpstreamModels(c.env.DB, m.id)
  const upstreams: { name: string; model: string; status: string }[] = []
  for (const sm of avail) {
    const up = await c.env.DB.prepare(`SELECT name FROM ai_upstreams WHERE id = ?`).bind(sm.upstream_id).first<{ name: string }>()
    if (up) upstreams.push({ name: up.name, model: sm.model, status: sm.status })
  }
  let health: string
  if (avail.length === 0) health = 'unmatched'
  else if (avail.some((x) => x.status === 'ok')) health = 'ok'
  else if (avail.some((x) => x.status === 'unknown')) health = 'unknown'
  else health = 'error'
  return {
    id: m.id,
    name: m.name,
    builtin: !!m.builtin,
    ratio: m.ratio,
    enabled: !!m.enabled,
    remark: m.remark,
    sort: m.sort,
    free: !!m.free,
    discount: m.discount,
    discount_label: m.discount == null ? '' : String(Number(m.discount.toFixed(6))) + 'x',
    effective_ratio: effectiveRatio(m),
    health,
    upstreams
  }
}

mgmt.get('/ai-models/models', async (c) => {
  const r = await c.env.DB
    .prepare(`SELECT id, name, builtin, ratio, enabled, remark, sort, free, discount, created_at, updated_at FROM ai_models ORDER BY sort DESC, id DESC`)
    .all<Model>()
  const out: Record<string, unknown>[] = []
  for (const m of r.results ?? []) out.push(await modelAdminPayload(c, m))
  return c.json(out)
})

mgmt.post('/ai-models/models', async (c) => {
  const req = await body<{ name?: string; builtin?: boolean; ratio?: number; enabled?: boolean; remark?: string; sort?: number; free?: boolean; discount?: number | null }>(c)
  const name = (req.name ?? '').trim()
  if (!name || name.length > 150) throw fail(422, '请填写模型名（不超过 150 字）')
  const ratio = Number(req.ratio) > 0 ? Number(req.ratio) : 1
  const now = rfc()
  const r = await c.env.DB
    .prepare(
      `INSERT INTO ai_models (name, builtin, ratio, enabled, remark, sort, free, discount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(name, req.builtin ? 1 : 0, ratio, req.enabled === false ? 0 : 1, req.remark ?? '', Math.trunc(req.sort ?? 0) || 0, req.free ? 1 : 0, req.discount ?? null, now, now)
    .run()
  const id = r.meta.last_row_id ?? 0
  await matchUpstreamModels(c.env.DB, id, name)
  return c.json(await modelAdminPayload(c, (await findModelRow(c, id))!))
})

async function findModelRow(c: Context<AppEnv>, id: number): Promise<Model | null> {
  return c.env.DB
    .prepare(`SELECT id, name, builtin, ratio, enabled, remark, sort, free, discount, created_at, updated_at FROM ai_models WHERE id = ?`)
    .bind(id)
    .first<Model>()
}

mgmt.put('/ai-models/models/:m', async (c) => {
  const id = paramInt(c, 'm')
  const m = await findModelRow(c, id)
  if (!m) throw fail(404, '模型不存在')
  const req = await body<{ name?: string; builtin?: boolean; ratio?: number; enabled?: boolean; remark?: string; sort?: number; free?: boolean; discount?: number | null }>(c)
  const name = (req.name ?? '').trim() || m.name
  const ratio = Number(req.ratio) > 0 ? Number(req.ratio) : m.ratio
  // builtin/free/remark/sort 无条件覆盖（传 false/""/0 会清掉）；discount null/缺省 → 置 NULL
  await c.env.DB
    .prepare(`UPDATE ai_models SET name = ?, builtin = ?, ratio = ?, enabled = ?, remark = ?, sort = ?, free = ?, discount = ?, updated_at = ? WHERE id = ?`)
    .bind(
      name,
      req.builtin ? 1 : 0,
      ratio,
      req.enabled === false ? 0 : req.enabled === true ? 1 : m.enabled,
      req.remark ?? '',
      Math.trunc(req.sort ?? 0) || 0,
      req.free ? 1 : 0,
      req.discount ?? null,
      rfc(),
      id
    )
    .run()
  await matchUpstreamModels(c.env.DB, id, name)
  return c.json(await modelAdminPayload(c, (await findModelRow(c, id))!))
})

mgmt.delete('/ai-models/models/:m', async (c) => {
  await c.env.DB.prepare(`DELETE FROM ai_models WHERE id = ?`).bind(paramInt(c, 'm')).run()
  return c.json({ message: '已删除' })
})

mgmt.post('/ai-models/models/:m/test', async (c) => {
  const m = await findModelRow(c, paramInt(c, 'm'))
  if (!m) throw fail(404, '模型不存在')
  return c.json(await testModel(c.env.DB, { id: m.id, name: m.name }))
})

mgmt.post('/ai-models/re-match', async (c) => {
  const count = await matchAllUpstreamModels(c.env.DB)
  return c.json({ message: '已重新匹配', count })
})

// ---------- 模型概况 / 用量统计 / 会员 ----------

function rangeOf(c: Context<AppEnv>): { from: Date; to: Date; tz: number } {
  const tz = Number(c.env.TZ_HOURS) || 8
  return { ...usageRange(c.req.query('from'), c.req.query('to'), tz), tz }
}

mgmt.get('/ai-models/health', async (c) => {
  const { from, to, tz } = rangeOf(c)
  const fromDate = fmtDate(from.getTime() + tz * 3600_000)
  const toDate = fmtDate(to.getTime() + tz * 3600_000)
  const r = await c.env.DB
    .prepare(
      `SELECT m.id AS model_id, m.name AS model, COALESCE(SUM(c.total),0) AS total, COALESCE(SUM(c.ok),0) AS ok
       FROM ai_models m
       LEFT JOIN ai_model_health_days c ON c.model_id = m.id AND c.day >= ? AND c.day <= ?
       GROUP BY m.id, m.name
       HAVING total > 0
       ORDER BY ok * 1.0 / total ASC, m.name ASC`
    )
    .bind(fromDate, toDate)
    .all<{ model_id: number; model: string; total: number; ok: number }>()
  const rows: Record<string, unknown>[] = []
  for (const x of r.results ?? []) {
    rows.push({
      model_id: x.model_id,
      model: x.model,
      total: x.total,
      ok: x.ok,
      rate: x.total > 0 ? x.ok / x.total : 0,
      upstreams: await upstreamNames(c, x.model_id)
    })
  }
  return c.json({ from: fromDate, to: toDate, rows })
})

mgmt.get('/ai-models/health/series', async (c) => {
  const { from, to, tz } = rangeOf(c)
  const fromDate = fmtDate(from.getTime() + tz * 3600_000)
  const toDate = fmtDate(to.getTime() + tz * 3600_000)
  const dates: string[] = []
  for (let d = from.getTime(); d <= to.getTime() && dates.length < 400; d += 86400_000) {
    dates.push(fmtDate(d + tz * 3600_000))
  }
  const r = await c.env.DB
    .prepare(
      `SELECT m.id AS model_id, m.name AS model, c.day, c.total, c.ok
       FROM ai_models m JOIN ai_model_health_days c ON c.model_id = m.id AND c.day >= ? AND c.day <= ?
       ORDER BY m.name ASC, c.day ASC`
    )
    .bind(fromDate, toDate)
    .all<{ model_id: number; model: string; day: string; total: number; ok: number }>()
  const byModel = new Map<number, { model: string; total: number; ok: number; days: { day: string; total: number; ok: number; rate: number }[] }>()
  for (const x of r.results ?? []) {
    if (!byModel.has(x.model_id)) byModel.set(x.model_id, { model: x.model, total: 0, ok: 0, days: [] })
    const g = byModel.get(x.model_id)!
    g.total += x.total
    g.ok += x.ok
    g.days.push({ day: x.day, total: x.total, ok: x.ok, rate: x.total > 0 ? x.ok / x.total : 0 })
  }
  const rows: Record<string, unknown>[] = []
  for (const [model_id, g] of byModel) {
    rows.push({
      model_id,
      model: g.model,
      total: g.total,
      ok: g.ok,
      rate: g.total > 0 ? g.ok / g.total : 0,
      upstreams: await upstreamNames(c, model_id),
      days: g.days
    })
  }
  return c.json({ from: fromDate, to: toDate, dates, rows })
})

async function upstreamNames(c: Context<AppEnv>, modelID: number): Promise<string[]> {
  const avail = await availableUpstreamModels(c.env.DB, modelID)
  const names: string[] = []
  for (const sm of avail) {
    const up = await c.env.DB.prepare(`SELECT name FROM ai_upstreams WHERE id = ?`).bind(sm.upstream_id).first<{ name: string }>()
    if (up?.name && !names.includes(up.name)) names.push(up.name)
  }
  return names
}

mgmt.get('/usage/overview', async (c) => {
  const { from, to, tz } = rangeOf(c)
  const fromS = rfc(from)
  const toS = rfc(to)
  const head = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(points),0) AS points,
              COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT device_id) AS devices
       FROM ai_usages WHERE created_at >= ? AND created_at <= ?`
    )
    .bind(fromS, toS)
    .first<{ calls: number; tokens: number; points: number; users: number; devices: number }>()
  const models = await c.env.DB
    .prepare(
      `SELECT model AS label, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(points),0) AS points
       FROM ai_usages WHERE created_at >= ? AND created_at <= ? GROUP BY model ORDER BY tokens DESC LIMIT 100`
    )
    .bind(fromS, toS)
    .all<{ label: string; calls: number; tokens: number; points: number }>()
  const days = await c.env.DB
    .prepare(
      `SELECT DATE(created_at) AS label, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(points),0) AS points
       FROM ai_usages WHERE created_at >= ? AND created_at <= ? GROUP BY DATE(created_at) ORDER BY DATE(created_at) ASC`
    )
    .bind(fromS, toS)
    .all<{ label: string; calls: number; tokens: number; points: number }>()
  return c.json({
    calls: head?.calls ?? 0,
    tokens: head?.tokens ?? 0,
    points: head?.points ?? 0,
    users: head?.users ?? 0,
    devices: head?.devices ?? 0,
    models: models.results ?? [],
    days: days.results ?? []
  })
})

mgmt.get('/usage/stats', async (c) => {
  const { from, to } = rangeOf(c)
  const group = c.req.query('group') === 'day' ? 'DATE(created_at)' : 'model'
  const r = await c.env.DB
    .prepare(
      `SELECT ${group} AS label, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(points),0) AS points
       FROM ai_usages WHERE created_at >= ? AND created_at <= ? GROUP BY ${group} ORDER BY tokens DESC`
    )
    .bind(rfc(from), rfc(to))
    .all<{ label: string; calls: number; tokens: number; points: number }>()
  return c.json({ from: fmtDate(from.getTime() + (Number(c.env.TZ_HOURS) || 8) * 3600_000), to: fmtDate(to.getTime() + (Number(c.env.TZ_HOURS) || 8) * 3600_000), rows: r.results ?? [] })
})

interface MemberRow {
  id: number
  name: string
  email: string
  role: string
  points: number
  status: string
  created_at: string
}

const memberCols = `id, name, email, role, points, status, created_at`

mgmt.get('/members', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const page = queryInt(c, 'page', 1)
  const per = clampPerPage(queryInt(c, 'per_page', 20))
  const where = q ? `WHERE name LIKE ? OR email LIKE ?` : ''
  const args: unknown[] = q ? [`%${q}%`, `%${q}%`] : []
  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0
  const r = await c.env.DB
    .prepare(`SELECT ${memberCols} FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...args, per, (page - 1) * per)
    .all<MemberRow>()
  return c.json(pageEnvelope(r.results ?? [], total, page, per))
})

mgmt.get('/members/:id', async (c) => {
  const m = await c.env.DB.prepare(`SELECT ${memberCols} FROM users WHERE id = ?`).bind(paramInt(c, 'id')).first<MemberRow>()
  if (!m) throw fail(404, '会员不存在')
  return c.json(m)
})

mgmt.put('/members/:id', async (c) => {
  const id = paramInt(c, 'id')
  const u = await findUser(c.env.DB, id)
  if (!u) throw fail(404, '会员不存在')
  const req = await body<{ name?: string; status?: string; points?: number; remark?: string }>(c)
  const name = (req.name ?? '').trim()
  if (name) await c.env.DB.prepare(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`).bind(name, rfc(), id).run()
  if (req.status === 'active' || req.status === 'disabled') {
    await c.env.DB.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`).bind(req.status, rfc(), id).run()
  }
  const points = Math.trunc(Number(req.points ?? 0))
  if (points !== 0) {
    const fresh = (await findUser(c.env.DB, id))!
    const remark = (req.remark ?? '').trim() || '后台调整'
    await adjustPoints(c.env.DB, fresh, points, remark, userOf(c).id)
  }
  return c.json({ message: '已保存' })
})

mgmt.get('/members/:id/logs', async (c) => {
  const id = paramInt(c, 'id')
  const typ = c.req.query('type') ?? ''
  const page = queryInt(c, 'page', 1)
  const per = clampPerPage(queryInt(c, 'per_page', 20))
  const where = typ ? `WHERE user_id = ? AND type = ?` : `WHERE user_id = ?`
  const args: unknown[] = typ ? [id, typ] : [id]
  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM point_logs ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0
  const r = await c.env.DB
    .prepare(`SELECT id, change, after, type, remark, created_at FROM point_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...args, per, (page - 1) * per)
    .all<{ id: number; change: number; after: number; type: string; remark: string; created_at: string }>()
  return c.json(
    pageEnvelope(
      (r.results ?? []).map((l) => ({
        id: l.id,
        change: l.change,
        after: l.after,
        type: l.type,
        type_label: typeLabel(l.type),
        remark: l.remark,
        created_at: fmtMinute(l.created_at)
      })),
      total,
      page,
      per
    )
  )
})

mgmt.get('/members/:id/usages', async (c) => {
  const id = paramInt(c, 'id')
  const page = queryInt(c, 'page', 1)
  const per = clampPerPage(queryInt(c, 'per_page', 20))
  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_usages WHERE user_id = ?`).bind(id).first<{ n: number }>())?.n ?? 0
  const r = await c.env.DB
    .prepare(
      `SELECT id, model, total_tokens, points, created_at FROM ai_usages WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .bind(id, per, (page - 1) * per)
    .all<{ id: number; model: string; total_tokens: number; points: number; created_at: string }>()
  return c.json(
    pageEnvelope(
      (r.results ?? []).map((x) => ({
        id: x.id,
        model: x.model,
        total_tokens: x.total_tokens,
        points: x.points,
        created_at: fmtMinute(x.created_at)
      })),
      total,
      page,
      per
    )
  )
})

// ---------- 邮件配置（管理员） ----------

/** GET /admin/mail-config — SMTP 配置。密码从不回显，只给 has_pass。 */
mgmt.get('/mail-config', async (c) => {
  const cfg = await mailConfigOf(c)
  return c.json({
    host: cfg?.host ?? '',
    port: cfg?.port ?? 465,
    user: cfg?.user ?? '',
    from: cfg?.from ?? '',
    secure: cfg?.secure ?? 'ssl',
    has_pass: !!cfg?.pass
  })
})

/** PUT /admin/mail-config — 保存 SMTP 配置。pass 留空 = 保持原密码（前端拿不到旧密码，只能留空不改）。 */
mgmt.put('/mail-config', async (c) => {
  const req = await body<{ host?: string; port?: number; user?: string; pass?: string; from?: string; secure?: string }>(c)
  const host = (req.host ?? '').trim()
  if (!host) throw fail(422, '请填写 SMTP 服务器地址')
  const from = (req.from ?? '').trim()
  if (!validEmail(from)) throw fail(422, '请填写正确的发件人邮箱')
  const secure = req.secure === 'starttls' ? 'starttls' : 'ssl'
  const port = Math.trunc(Number(req.port)) || (secure === 'ssl' ? 465 : 587)
  await setSetting(c, 'mail_host', host)
  await setSetting(c, 'mail_port', String(port))
  await setSetting(c, 'mail_user', (req.user ?? '').trim())
  await setSetting(c, 'mail_from', from)
  await setSetting(c, 'mail_secure', secure)
  const pass = (req.pass ?? '').trim()
  if (pass) await setSetting(c, 'mail_pass', pass)
  return c.json({ message: '已保存' })
})

/** POST /admin/mail-config/test — 用当前配置发一封测试邮件，SMTP 报错原样透传给管理员。 */
mgmt.post('/mail-config/test', async (c) => {
  const req = await body<{ to?: string }>(c)
  const to = (req.to ?? '').trim().toLowerCase()
  if (!validEmail(to)) throw fail(422, '请填写正确的收件邮箱')
  const cfg = await mailConfigOf(c)
  if (!cfg) throw fail(422, '请先保存 SMTP 配置')
  try {
    await sendMail(cfg, to, {
      subject: '青鸟邮件配置测试',
      html: '<p style="font-family:sans-serif;">这是一封测试邮件。收到它说明 SMTP 配置正确，验证码邮件可以正常发出了。</p>'
    })
  } catch (e) {
    throw fail(502, `发送失败：${(e as Error).message}`)
  }
  return c.json({ message: '测试邮件已发送，请查收' })
})

// ---------- 超管改邮箱（右上角） ----------
// 初始化的管理员邮箱可能是假的（收不到验证码），换邮箱本身要走「新邮箱收码」验证。

mgmt.post('/profile/email/code', async (c) => {
  const req = await body<{ email?: string }>(c)
  const email = (req.email ?? '').trim().toLowerCase()
  if (!validEmail(email)) throw fail(422, '邮箱格式不正确')
  if (await findUserByEmail(c.env.DB, email)) throw fail(409, '该邮箱已被占用')
  await sendCode(c, email, 'email-change')
  return c.json({ message: '验证码已发送，请查收新邮箱' })
})

mgmt.put('/profile/email', async (c) => {
  const req = await body<{ email?: string; code?: string }>(c)
  const email = (req.email ?? '').trim().toLowerCase()
  if (!validEmail(email)) throw fail(422, '邮箱格式不正确')
  await verifyCode(c, email, 'email-change', (req.code ?? '').trim())
  if (await findUserByEmail(c.env.DB, email)) throw fail(409, '该邮箱已被占用')
  const me = userOf(c)
  await c.env.DB.prepare(`UPDATE users SET email = ?, updated_at = ? WHERE id = ?`).bind(email, rfc(), me.id).run()
  return c.json({ message: '邮箱已更新', user: { ...userPayload(me), email } })
})

mgmt.get('/dashboard', async (c) => {
  const tz = Number(c.env.TZ_HOURS) || 8
  const localMidnight = Date.UTC(
    new Date(Date.now() + tz * 3600_000).getUTCFullYear(),
    new Date(Date.now() + tz * 3600_000).getUTCMonth(),
    new Date(Date.now() + tz * 3600_000).getUTCDate()
  )
  const dayStart = rfc(new Date(localMidnight - tz * 3600_000))
  const onlineSince = rfc(new Date(Date.now() - DEVICE_ONLINE_MS))
  const users =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'member'`).first<{ n: number }>())?.n ?? 0
  const devices =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ide_devices WHERE enabled = 1`).first<{ n: number }>())?.n ?? 0
  const online =
    (
      await c.env.DB
        .prepare(`SELECT COUNT(*) AS n FROM ide_devices WHERE enabled = 1 AND last_seen_at > ?`)
        .bind(onlineSince)
        .first<{ n: number }>()
    )?.n ?? 0
  const upstreams = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_upstreams`).first<{ n: number }>())?.n ?? 0
  const models = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_models`).first<{ n: number }>())?.n ?? 0
  const today = await c.env.DB
    .prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens FROM ai_usages WHERE created_at >= ?`)
    .bind(dayStart)
    .first<{ calls: number; tokens: number }>()
  return c.json({
    users,
    devices,
    online,
    upstreams,
    models,
    mail_configured: await isMailConfigured(c),
    calls_today: today?.calls ?? 0,
    tokens_today: today?.tokens ?? 0
  })
})

admin.route('/admin', mgmt)
