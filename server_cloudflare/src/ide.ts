/**
 * /api/ide/* 桌面端与手机端接口（契约第 1/3/4/5 节）。
 * 与 Go 版 handler 逐字段对齐；协议以 docs/服务端API契约.md 为唯一事实来源。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env, UserRow } from './db.ts'
import {
  baseURL,
  body,
  clampPerPage,
  clientIP,
  fail,
  fmtISO,
  fmtMinute,
  pageEnvelope,
  paramInt,
  queryInt,
  randHex,
  rfc,
  sha256Hex,
  trimLen
} from './db.ts'
import { auth, isAdmin, tokenOf, userOf, userPayload, type AppEnv } from './auth.ts'
import {
  addEvents,
  createDevice,
  createRPC,
  deleteDevice,
  devicePayload,
  failTimedOutRPCs,
  findDeviceByID,
  findDeviceByName,
  findDeviceByToken,
  findRPC,
  finishRPC,
  isMobileOnline,
  isOnline,
  listDevicesByUser,
  listEventsAfter,
  PULL_LIMIT,
  pullRPCs,
  requeueStaleRPCs,
  saveDevice,
  touchDeviceMobile,
  touchDeviceSeen
} from './device.ts'
import { listPointLogs, listUsages, typeLabel, usageRange, usageSummaryOf } from './ai.ts'

export const ide = new Hono<AppEnv>()

// ---------- 1. 鉴权 ----------

const PAIR_TTL_MS = 10 * 60_000
const TOKEN_YEARS_MS = 10 * 365 * 86400_000

/** POST /api/ide/pair — 网页端已登录后生成一次性授权码（桌面端登录链路第 2 步）。 */
ide.post('/pair', auth, async (c) => {
  const u = userOf(c)
  if (u.status !== 'active') throw fail(403, '账号已被禁用')
  const req = await body<{ device?: string }>(c)
  const code = randHex(24)
  // 授权码落库（Go 版存内存；Workers 无常驻内存）。取出即删保证一次性。
  await c.env.DB.prepare(`INSERT INTO ide_pairs (code, user_id, device, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(code, u.id, trimLen(req.device, 100), rfc(new Date(Date.now() + PAIR_TTL_MS)))
    .run()
  return c.json({
    code,
    expires_in: PAIR_TTL_MS / 1000,
    app_url: `qingniao://auth?code=${code}`,
    user: userPayload(u)
  })
})

/** POST /api/ide/token — 授权码换长期 token（公开接口，靠一次性码鉴权）。 */
ide.post('/token', async (c) => {
  const req = await body<{ code?: string; device?: string }>(c)
  // DELETE ... RETURNING：取出即删，原子保证一次性、重放无效
  const entry = await c.env.DB.prepare(
    `DELETE FROM ide_pairs WHERE code = ? AND expires_at > ? RETURNING user_id, device`
  )
    .bind(req.code ?? '', rfc())
    .first<{ user_id: number; device: string | null }>()
  if (!entry) throw fail(422, '授权码无效或已过期，请重新登录')

  const u = await c.env.DB.prepare(
    `SELECT id, name, email, password, role, points, status, created_at, updated_at FROM users WHERE id = ?`
  )
    .bind(entry.user_id)
    .first<UserRow>()
  if (!u || u.status !== 'active') throw fail(403, '账号不存在或已被禁用')

  let device = (req.device ?? '').trim()
  if (!device) device = (entry.device ?? '').trim()
  if (!device) device = '青鸟'
  device = trimLen(device, 80)

  const plain = await createToken(c, u.id, `ide:${device}`, Date.now() + TOKEN_YEARS_MS)
  await addLoginLog(c, u.id, '青鸟 · ' + device)
  return c.json({
    token: plain,
    expires_at: fmtISO(rfc(new Date(Date.now() + TOKEN_YEARS_MS))),
    user: userPayload(u),
    gateway: baseURL(c, c.env) + '/api/ide/v1'
  })
})

/** GET /api/ide/me — 桌面端自检：token 还能用吗 + 是谁。 */
ide.get('/me', auth, (c) => {
  const t = tokenOf(c)
  return c.json({
    user: userPayload(userOf(c)),
    token: { id: t.id, name: t.name, expires_at: fmtISO(t.expires_at) },
    gateway: baseURL(c, c.env) + '/api/ide/v1'
  })
})

/** POST /api/ide/logout — 吊销当前 token。 */
ide.post('/logout', auth, async (c) => {
  await c.env.DB.prepare(`DELETE FROM personal_access_tokens WHERE id = ?`).bind(tokenOf(c).id).run()
  return c.json({ message: '已退出登录' })
})

/** 生成并落库一个长期 token，返回明文（格式与 Go 版一致："{id}|{64hex}"）。 */
async function createToken(c: { env: Env; req: { header: (k: string) => string | undefined } }, userID: number, name: string, expiresAt: number): Promise<string> {
  const hex = randHex(32)
  const hash = await sha256Hex('pending')
  // 先插占位拿 id，再按 "{id}|{hex}" 生成明文并更新哈希（与 Go 版两步一致）
  const r = await c.env.DB.prepare(
    `INSERT INTO personal_access_tokens (user_id, name, token_hash, ip_address, user_agent, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(userID, name, hash, clientIP(c), trimLen(c.req.header('User-Agent'), 500), fmtISO(rfc(new Date(expiresAt))), rfc())
    .run()
  const id = r.meta.last_row_id ?? 0
  const plain = `${id}|${hex}`
  await c.env.DB.prepare(`UPDATE personal_access_tokens SET token_hash = ? WHERE id = ?`).bind(await sha256Hex(plain), id).run()
  return plain
}

async function addLoginLog(
  c: { env: Env; req: { header: (k: string) => string | undefined } },
  userID: number,
  device: string
): Promise<void> {
  await c.env.DB
    .prepare(`INSERT INTO login_logs (user_id, ip_address, device, user_agent, login_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(userID, clientIP(c), device, trimLen(c.req.header('User-Agent'), 500), rfc(), rfc())
    .run()
}

// ---------- 3. 中转通道 · 桌面端 ----------

interface Identity {
  device_id?: number
  secret?: string
}

/** Bearer 身份 + device_id/secret 双因子校验。 */
async function approved(c: Context<AppEnv>, req: Identity) {
  const u = userOf(c)
  const dev = req.device_id && req.secret ? await findDeviceByID(c.env.DB, req.device_id) : null
  if (!dev || dev.user_id !== u.id || !dev.enabled || dev.secret !== req.secret) {
    throw fail(403, '设备身份校验失败，请重新登录青鸟')
  }
  return dev
}

/** POST /api/ide/desk/register — 注册/复用本机设备（同名复用，rotate 换二维码 token）。 */
ide.post('/desk/register', auth, async (c) => {
  const req = await body<{ name?: string; platform?: string; rotate?: boolean }>(c)
  const name = (req.name ?? '').trim()
  if (!name || name.length > 100) throw fail(422, 'name 必填且不超过 100 字')
  const u = userOf(c)

  const exist = await findDeviceByName(c.env.DB, u.id, name)
  if (!exist) {
    const now = rfc()
    const row = {
      user_id: u.id,
      name,
      platform: trimLen(req.platform, 60),
      token: randHex(32),
      secret: randHex(32),
      lan_url: '',
      enabled: 1,
      last_seen_at: now,
      mobile_seen_at: null,
      created_at: now,
      updated_at: now
    }
    const id = await createDevice(c.env.DB, row)
    return c.json(devicePayload({ id, ...row }, true, baseURL(c, c.env)))
  }

  exist.platform = trimLen(req.platform, 60)
  if (req.rotate) exist.token = randHex(32)
  exist.enabled = 1
  exist.last_seen_at = rfc()
  await saveDevice(c.env.DB, exist)
  return c.json(devicePayload(exist, true, baseURL(c, c.env)))
})

/** GET /api/ide/desk/devices — 我账号下的所有桌面端（不含 secret）。 */
ide.get('/desk/devices', auth, async (c) => {
  const list = await listDevicesByUser(c.env.DB, userOf(c).id)
  return c.json(list.map((d) => devicePayload(d, false, baseURL(c, c.env))))
})

/** DELETE /api/ide/desk/devices/{device} — 吊销一台桌面端（二维码立即作废）。 */
ide.delete('/desk/devices/:device', auth, async (c) => {
  const id = paramInt(c, 'device')
  const dev = await findDeviceByID(c.env.DB, id)
  if (!dev || dev.user_id !== userOf(c).id) throw fail(404, '该客户端不存在')
  await deleteDevice(c.env.DB, id)
  return c.json({ message: '该客户端授权已吊销' })
})

/** POST /api/ide/desk/pull — 认领指令（桌面端每 1.2 秒一次）。 */
ide.post('/desk/pull', auth, async (c) => {
  const req = await body<Identity>(c)
  const dev = await approved(c, req)
  await touchDeviceSeen(c.env.DB, dev.id)
  await requeueStaleRPCs(c.env.DB, dev.id)
  const rpcs = await pullRPCs(c.env.DB, dev.id, PULL_LIMIT)
  return c.json({
    rpcs: rpcs.map((x) => ({ id: x.id, method: x.method, params: decodeParams(x.params) })),
    mobile: isMobileOnline(dev)
  })
})

/** POST /api/ide/desk/result — 回填指令结果。 */
ide.post('/desk/result', auth, async (c) => {
  const req = await body<Identity & { id?: number; ok?: boolean; result?: unknown; error?: string }>(c)
  const dev = await approved(c, req)
  if (!req.id || req.id <= 0) throw fail(422, 'id 必填')
  await findRPC(c.env.DB, dev.id, req.id)
  let resultJSON = ''
  if (req.ok && req.result != null) {
    try {
      resultJSON = JSON.stringify(req.result)
    } catch {
      resultJSON = ''
    }
  }
  let errMsg = ''
  if (!req.ok) {
    errMsg = trimLen(req.error, 2000) || '执行失败'
  }
  await finishRPC(c.env.DB, dev.id, req.id, !!req.ok, resultJSON, errMsg)
  return c.json({ message: 'ok' })
})

/** POST /api/ide/desk/events — 批量上报内核事件（最多 200 条）。 */
ide.post('/desk/events', auth, async (c) => {
  const req = await body<Identity & { events?: { type?: string; payload?: Record<string, unknown> }[] }>(c)
  const dev = await approved(c, req)
  const events = req.events ?? []
  if (events.length > 200) throw fail(422, 'events 一次最多 200 条')
  const items = events.map((e) => {
    const t = (e.type ?? '').trim()
    if (!t || t.length > 80) throw fail(422, 'events.*.type 必填且不超过 80 字')
    let payload = ''
    if (e.payload != null) {
      try {
        payload = JSON.stringify(e.payload)
      } catch {
        payload = ''
      }
    }
    return { type: t, payload }
  })
  await addEvents(c.env.DB, dev.id, items)
  return c.json({ message: 'ok' })
})

// ---------- 4. 中转通道 · 手机端（不需要登录，二维码 token 就是凭证） ----------

/** 手机可下发的指令白名单（与桌面端 relay.ts 的 run() 一一对应）。 */
const RPC_METHODS = new Set([
  'projects.list',
  'models.list',
  'sessions.list',
  'session.create',
  'session.messages',
  'session.send',
  'session.stop'
])

async function deviceByToken(c: { env: Env; req: { param: (k: string) => string | undefined } }) {
  const token = (c.req.param('token') ?? '').trim()
  if (token.length !== 64) throw fail(404, '链接无效')
  const dev = await findDeviceByToken(c.env.DB, token)
  if (!dev) throw fail(404, '链接已失效：请在电脑上换一张二维码')
  return dev
}

/** GET /api/ide/device/{token} — 落地信息。 */
ide.get('/device/:token', async (c) => {
  const dev = await deviceByToken(c)
  await touchDeviceMobile(c.env.DB, dev.id)
  const u = await c.env.DB.prepare(`SELECT name, email FROM users WHERE id = ?`).bind(dev.user_id).first<{ name: string; email: string }>()
  return c.json({
    device: {
      id: dev.id,
      name: dev.name,
      platform: dev.platform,
      online: isOnline(dev),
      last_seen_at: dev.last_seen_at ? dev.last_seen_at.replace('T', ' ').slice(0, 19) : null
    },
    user: { name: u?.name ?? '', email: u?.email ?? '' }
  })
})

/** POST /api/ide/device/{token}/rpc — 下发一条指令。 */
ide.post('/device/:token/rpc', async (c) => {
  const dev = await deviceByToken(c)
  await touchDeviceMobile(c.env.DB, dev.id)
  if (!isOnline(dev)) throw fail(409, '电脑不在线：请确认青鸟已打开、账号已登录、且「移动端连接」已开启')
  const req = await body<{ method?: string; params?: Record<string, unknown> }>(c)
  if (!RPC_METHODS.has(req.method ?? '')) throw fail(422, '不支持的指令：' + (req.method ?? ''))
  let params = ''
  if (req.params != null) {
    try {
      params = JSON.stringify(req.params)
    } catch {
      params = ''
    }
  }
  const id = await createRPC(c.env.DB, dev.id, req.method ?? '', params)
  return c.json({ id, status: 'pending' })
})

/** GET /api/ide/device/{token}/rpc/{rpc} — 取指令结果（超时就地对账成 failed）。 */
ide.get('/device/:token/rpc/:rpc', async (c) => {
  const dev = await deviceByToken(c)
  await touchDeviceMobile(c.env.DB, dev.id)
  const id = paramInt(c, 'rpc')
  let rpc = await findRPC(c.env.DB, dev.id, id)
  if (rpc.status === 'pending' || rpc.status === 'running') {
    await failTimedOutRPCs(c.env.DB, dev.id)
    rpc = await findRPC(c.env.DB, dev.id, id)
  }
  return c.json({
    id: rpc.id,
    status: rpc.status,
    result: decodeParams(rpc.result),
    error: rpc.error || null
  })
})

/** GET /api/ide/device/{token}/events — 增量拉事件（没事件时短长轮询，最多挂 25 秒）。 */
ide.get('/device/:token/events', async (c) => {
  const dev = await deviceByToken(c)
  await touchDeviceMobile(c.env.DB, dev.id)
  const cursor = queryInt(c, 'cursor', 0)
  const wait = queryInt(c, 'wait', 1) > 0

  const read = async (): Promise<{ newCursor: number; out: unknown[] }> => {
    const rows = await listEventsAfter(c.env.DB, dev.id, cursor, 300)
    let newCursor = cursor
    const out = rows.map((e) => {
      if (e.id > newCursor) newCursor = e.id
      return { id: e.id, type: e.type, payload: decodeParams(e.payload) }
    })
    return { newCursor, out }
  }

  let r = await read()
  // 手上没事件才等：Workers 上没有跨请求唤醒通道，退化为挂起轮询（1.2s 一查，最多 25s），
  // 与 Go 版无 notifier 时的兜底节奏一致；实时性已由「桌面端 1.2s 一推」保证。
  if (r.out.length === 0 && wait) {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      r = await read()
      if (r.out.length > 0) break
    }
  }
  return c.json({ cursor: r.newCursor, online: isOnline(dev), events: r.out })
})

// ---------- 5. 用量与积分 ----------

/** GET /api/ide/usage/summary — 一次请求喂满整个使用量页面。 */
ide.get('/usage/summary', auth, async (c) => {
  const u = userOf(c)
  const { from, to } = usageRange(c.req.query('from'), c.req.query('to'), Number(c.env.TZ_HOURS) || 8)
  const sum = await usageSummaryOf(c.env.DB, u.id, isAdmin(u), from, to, Number(c.env.TZ_HOURS) || 8)
  sum.points = u.points
  return c.json(sum)
})

/** GET /api/ide/usage/logs — 积分流水（分页）。 */
ide.get('/usage/logs', auth, async (c) => {
  const u = userOf(c)
  const typ = c.req.query('type') ?? ''
  if (typ && typ !== 'consume' && typ !== 'grant' && typ !== 'adjust') {
    throw fail(422, 'type 只能是 consume / grant / adjust')
  }
  const page = queryInt(c, 'page', 1)
  const per = clampPerPage(queryInt(c, 'per_page', 20))
  const p = await listPointLogs(c.env.DB, u.id, typ, page, per)
  return c.json(
    pageEnvelope(
      p.items.map((l) => ({
        id: l.id,
        change: l.change,
        after: l.after,
        type: l.type,
        type_label: typeLabel(l.type),
        remark: l.remark,
        created_at: fmtMinute(l.created_at)
      })),
      p.total,
      page,
      per
    )
  )
})

/** GET /api/ide/usage/records — 每次消耗明细（分页）。 */
ide.get('/usage/records', auth, async (c) => {
  const u = userOf(c)
  const page = queryInt(c, 'page', 1)
  const per = clampPerPage(queryInt(c, 'per_page', 20))
  const p = await listUsages(c.env.DB, u.id, page, per)
  return c.json(
    pageEnvelope(
      p.items.map((x) => ({
        id: x.id,
        model: x.model,
        ratio: x.ratio,
        prompt_tokens: x.prompt_tokens,
        completion_tokens: x.completion_tokens,
        total_tokens: x.total_tokens,
        points: x.points,
        created_at: fmtMinute(x.created_at)
      })),
      p.total,
      page,
      per
    )
  )
})

// ---------- 内部 ----------

/** JSON 字符串 → 对象（params/result 落库存的是 JSON 文本）。 */
function decodeParams(s: string | null): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
