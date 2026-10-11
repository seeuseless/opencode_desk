/**
 * 设备 / 指令 / 事件 数据访问（对应 Go 版 internal/store/device.go）。
 * 常量与 Go 版一致：在线窗口 90s、手机窗口 20s、指令超时 120s、重派 90s、事件 TTL 5 分钟。
 */
import { fail, fmtTime, rfc } from './db.ts'

export const PULL_LIMIT = 5
export const EVENT_TTL_MS = 5 * 60_000
export const RPC_TIMEOUT_MS = 120_000
export const RPC_REQUEUE_MS = 90_000
export const DEVICE_ONLINE_MS = 90_000
export const MOBILE_ONLINE_MS = 20_000

export interface DeviceRow {
  id: number
  user_id: number
  name: string
  platform: string
  token: string
  secret: string
  lan_url: string
  enabled: number
  last_seen_at: string | null
  mobile_seen_at: string | null
  created_at: string
  updated_at: string
}

export interface RPCRow {
  id: number
  device_id: number
  method: string
  params: string | null
  status: string
  result: string | null
  error: string | null
  created_at: string
}

const deviceCols = `id, user_id, name, platform, token, secret, lan_url, enabled, last_seen_at, mobile_seen_at, created_at, updated_at`

export async function findDeviceByID(db: D1Database, id: number): Promise<DeviceRow | null> {
  return db.prepare(`SELECT ${deviceCols} FROM ide_devices WHERE id = ?`).bind(id).first<DeviceRow>()
}

export async function findDeviceByToken(db: D1Database, token: string): Promise<DeviceRow | null> {
  return db.prepare(`SELECT ${deviceCols} FROM ide_devices WHERE token = ?`).bind(token).first<DeviceRow>()
}

export async function findDeviceByName(db: D1Database, userID: number, name: string): Promise<DeviceRow | null> {
  return db
    .prepare(`SELECT ${deviceCols} FROM ide_devices WHERE user_id = ? AND name = ?`)
    .bind(userID, name)
    .first<DeviceRow>()
}

export async function listDevicesByUser(db: D1Database, userID: number): Promise<DeviceRow[]> {
  const r = await db
    .prepare(`SELECT ${deviceCols} FROM ide_devices WHERE user_id = ? ORDER BY id DESC`)
    .bind(userID)
    .all<DeviceRow>()
  return r.results ?? []
}

export async function createDevice(db: D1Database, d: Omit<DeviceRow, 'id'>): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO ide_devices (user_id, name, platform, token, secret, lan_url, enabled, last_seen_at, mobile_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      d.user_id,
      d.name,
      d.platform,
      d.token,
      d.secret,
      d.lan_url,
      d.enabled,
      d.last_seen_at,
      d.mobile_seen_at,
      d.created_at,
      d.updated_at
    )
    .run()
  return r.meta.last_row_id ?? 0
}

export async function saveDevice(db: D1Database, d: DeviceRow): Promise<void> {
  await db
    .prepare(
      `UPDATE ide_devices SET name = ?, platform = ?, token = ?, enabled = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(d.name, d.platform, d.token, d.enabled, d.last_seen_at, rfc(), d.id)
    .run()
}

export async function deleteDevice(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM ide_devices WHERE id = ?`).bind(id).run()
}

export async function touchDeviceSeen(db: D1Database, id: number): Promise<void> {
  await db.prepare(`UPDATE ide_devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`).bind(rfc(), rfc(), id).run()
}

/** 记「有手机在看」。5 秒内记过就跳过（判定窗口 20 秒，跳过也一直落在窗口内）。 */
export async function touchDeviceMobile(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(
      `UPDATE ide_devices SET mobile_seen_at = ?, updated_at = ?
       WHERE id = ? AND (mobile_seen_at IS NULL OR mobile_seen_at < ?)`
    )
    .bind(rfc(), rfc(), id, rfc(new Date(Date.now() - 5000)))
    .run()
}

export const isOnline = (d: DeviceRow): boolean =>
  !!d.enabled && !!d.last_seen_at && Date.parse(d.last_seen_at) > Date.now() - DEVICE_ONLINE_MS

export const isMobileOnline = (d: DeviceRow): boolean =>
  !!d.mobile_seen_at && Date.parse(d.mobile_seen_at) > Date.now() - MOBILE_ONLINE_MS

/** 设备对外表示。secret 只在注册时下发一次。 */
export function devicePayload(d: DeviceRow, withSecret: boolean, base: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: d.id,
    name: d.name,
    platform: d.platform,
    token: d.token,
    path: `/ide/device/${d.token}`,
    url: base + `/ide/device/${d.token}`,
    enabled: !!d.enabled,
    online: isOnline(d),
    mobile_online: isMobileOnline(d),
    last_seen_at: fmtTime(d.last_seen_at),
    mobile_seen_at: fmtTime(d.mobile_seen_at),
    created_at: fmtTime(d.created_at)
  }
  if (withSecret) out.secret = d.secret
  return out
}

// ---------- 指令（RPC） ----------

/** 把「取走但 90 秒没回结果」的指令放回 pending（进程被杀/内核重启时手机会一直转圈）。 */
export async function requeueStaleRPCs(db: D1Database, deviceID: number): Promise<void> {
  await db
    .prepare(
      `UPDATE ide_rpcs SET status = 'pending', picked_at = NULL, updated_at = ?
       WHERE device_id = ? AND status = 'running' AND picked_at < ?`
    )
    .bind(rfc(), deviceID, rfc(new Date(Date.now() - RPC_REQUEUE_MS)))
    .run()
}

/**
 * 取待执行指令（按 id 升序，最多 limit 条）并置为 running。
 * 先用一条原子 UPDATE 圈定本次认领（打上 picked_at 时间戳），再按时间戳取回——
 * 两个并发 pull 不会拿到同一批（第二个的子查询里 pending 已被第一个拿走）。
 */
export async function pullRPCs(db: D1Database, deviceID: number, limit: number): Promise<RPCRow[]> {
  const stamp = rfc()
  await db
    .prepare(
      `UPDATE ide_rpcs SET status = 'running', picked_at = ?, updated_at = ?
       WHERE status = 'pending' AND id IN (
         SELECT id FROM ide_rpcs WHERE device_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?
       )`
    )
    .bind(stamp, stamp, deviceID, limit)
    .run()
  const r = await db
    .prepare(
      `SELECT id, device_id, method, params, status, result, error, picked_at, finished_at, created_at, updated_at
       FROM ide_rpcs WHERE device_id = ? AND picked_at = ? AND status = 'running' ORDER BY id ASC`
    )
    .bind(deviceID, stamp)
    .all<RPCRow>()
  return r.results ?? []
}

export async function finishRPC(
  db: D1Database,
  deviceID: number,
  rpcID: number,
  ok: boolean,
  result: string,
  errMsg: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE ide_rpcs SET status = ?, result = ?, error = ?, finished_at = ?, updated_at = ? WHERE device_id = ? AND id = ?`
    )
    .bind(ok ? 'done' : 'failed', result || null, errMsg || null, rfc(), rfc(), deviceID, rpcID)
    .run()
}

export async function findRPC(db: D1Database, deviceID: number, rpcID: number): Promise<RPCRow> {
  const r = await db
    .prepare(
      `SELECT id, device_id, method, params, status, result, error, picked_at, finished_at, created_at, updated_at
       FROM ide_rpcs WHERE device_id = ? AND id = ?`
    )
    .bind(deviceID, rpcID)
    .first<RPCRow>()
  if (!r) throw fail(404, '指令不存在')
  return r
}

/** 把超时的 pending/running 指令就地对账成 failed。 */
export async function failTimedOutRPCs(db: D1Database, deviceID: number): Promise<void> {
  await db
    .prepare(
      `UPDATE ide_rpcs SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
       WHERE device_id = ? AND status IN ('pending', 'running') AND created_at < ?`
    )
    .bind('电脑长时间没有响应', rfc(), rfc(), deviceID, rfc(new Date(Date.now() - RPC_TIMEOUT_MS)))
    .run()
}

export async function createRPC(db: D1Database, deviceID: number, method: string, params: string): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO ide_rpcs (device_id, method, params, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    )
    .bind(deviceID, method, params || null, rfc(), rfc())
    .run()
  return r.meta.last_row_id ?? 0
}

// ---------- 事件 ----------

export interface EventInput {
  type: string
  payload: string
}

/** 批量写入事件；顺手清理 5 分钟前的旧事件（TTL 与 Go 版一致）。 */
export async function addEvents(db: D1Database, deviceID: number, items: EventInput[]): Promise<void> {
  const now = rfc()
  const stmts = items.map((e) =>
    db.prepare(`INSERT INTO ide_events (device_id, type, payload, created_at) VALUES (?, ?, ?, ?)`).bind(deviceID, e.type, e.payload || null, now)
  )
  stmts.push(
    db.prepare(`DELETE FROM ide_events WHERE created_at < ?`).bind(rfc(new Date(Date.now() - EVENT_TTL_MS)))
  )
  await db.batch(stmts)
}

export async function listEventsAfter(
  db: D1Database,
  deviceID: number,
  cursor: number,
  limit: number
): Promise<{ id: number; type: string; payload: string | null }[]> {
  const r = await db
    .prepare(`SELECT id, type, payload FROM ide_events WHERE device_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .bind(deviceID, cursor, limit)
    .all<{ id: number; type: string; payload: string | null }>()
  return r.results ?? []
}
