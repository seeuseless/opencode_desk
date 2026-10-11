/**
 * 模型/上游/用量 数据访问与计费口径（对应 Go 版 internal/store 的 ai.go + usage.go）。
 * SQL 与 Go 版逐条对齐；时间戳统一 rfc()（UTC 毫秒）。
 */
import type { Env, UserRow } from './db.ts'
import { dayStartUTC, fail, fmtDate, rfc } from './db.ts'

// ---------- 行类型 ----------

export interface Model {
  id: number
  name: string
  builtin: number
  ratio: number
  enabled: number
  remark: string
  sort: number
  free: number
  discount: number | null
  created_at: string
  updated_at: string
}

export interface Upstream {
  id: number
  name: string
  driver: string
  base_url: string
  enabled: number
  sort: number
  remark: string
  models_synced_at: string | null
}

export interface UpstreamKey {
  id: number
  upstream_id: number
  name: string
  api_key: string
  enabled: number
  status: string
  latency_ms: number | null
  last_error: string | null
  last_checked_at: string | null
  last_used_at: string | null
}

export interface UpstreamModel {
  id: number
  upstream_id: number
  model_id: number | null
  model: string
  enabled: number
  status: string
  latency_ms: number | null
  last_error: string | null
  last_checked_at: string | null
}

export const KeyStatus = { OK: 'ok', UNKNOWN: 'unknown', ERROR: 'error' } as const

const modelCols = `id, name, builtin, ratio, enabled, remark, sort, free, discount, created_at, updated_at`

// ---------- 模型库 ----------

export async function listModels(db: D1Database): Promise<Model[]> {
  const r = await db.prepare(`SELECT ${modelCols} FROM ai_models ORDER BY sort DESC, id DESC`).all<Model>()
  return r.results ?? []
}

export async function findModelByName(db: D1Database, name: string): Promise<Model | null> {
  return db
    .prepare(`SELECT ${modelCols} FROM ai_models WHERE name = ? AND enabled = 1`)
    .bind(name)
    .first<Model>()
}

export async function findModel(db: D1Database, id: number): Promise<Model | null> {
  return db.prepare(`SELECT ${modelCols} FROM ai_models WHERE id = ?`).bind(id).first<Model>()
}

/** 真正能提供某模型的上游模型（自身启用 + 上游启用），按上游 sort、id 升序。 */
export async function availableUpstreamModels(db: D1Database, modelID: number): Promise<UpstreamModel[]> {
  const r = await db
    .prepare(
      `SELECT m.id, m.upstream_id, m.model_id, m.model, m.enabled, m.status, m.latency_ms, m.last_error, m.last_checked_at
       FROM ai_upstream_models m
       JOIN ai_upstreams u ON u.id = m.upstream_id
       WHERE m.model_id = ? AND m.enabled = 1 AND u.enabled = 1
       ORDER BY u.sort ASC, u.id ASC`
    )
    .bind(modelID)
    .all<UpstreamModel>()
  return r.results ?? []
}

/** 按模型名自动认领上游模型（同名的把 model_id 回填）；返回认领条数。 */
export async function matchUpstreamModels(db: D1Database, modelID: number, name: string): Promise<number> {
  const r = await db
    .prepare(`UPDATE ai_upstream_models SET model_id = ?, updated_at = ? WHERE model = ? AND model_id IS NULL`)
    .bind(modelID, rfc(), name)
    .run()
  return r.meta.changes ?? 0
}

/** 全部模型按名重新匹配。 */
export async function matchAllUpstreamModels(db: D1Database): Promise<number> {
  const models = await listModels(db)
  let n = 0
  for (const m of models) n += await matchUpstreamModels(db, m.id, m.name)
  return n
}

// ---------- 倍率口径（Go 版 EffectiveRatio / DiscountLabel） ----------

/** 限免为 0；否则 ratio × discount（NULL 按 1），四舍五入 4 位小数。 */
export function effectiveRatio(m: Model): number {
  if (m.free) return 0
  const d = m.discount ?? 1
  return round4(m.ratio * d)
}

export function discountLabel(m: Model): string {
  if (m.discount == null) return ''
  return trimZero(m.discount) + 'x'
}

function round4(v: number): number {
  return Math.floor(v * 10000 + 0.5) / 10000
}

/** Go %g 风格去尾零：0.2 → "0.2"、1 → "1"。 */
function trimZero(v: number): string {
  return String(Number(v.toFixed(6)))
}

// ---------- 上游 ----------

export async function findUpstream(db: D1Database, id: number): Promise<Upstream | null> {
  return db
    .prepare(`SELECT id, name, driver, base_url, enabled, sort, remark, models_synced_at FROM ai_upstreams WHERE id = ?`)
    .bind(id)
    .first<Upstream>()
}

export async function listKeysByUpstream(db: D1Database, upstreamID: number): Promise<UpstreamKey[]> {
  const r = await db
    .prepare(
      `SELECT id, upstream_id, name, api_key, enabled, status, latency_ms, last_error, last_checked_at, last_used_at
       FROM ai_upstream_keys WHERE upstream_id = ? AND enabled = 1`
    )
    .bind(upstreamID)
    .all<UpstreamKey>()
  return r.results ?? []
}

export async function findKey(db: D1Database, id: number): Promise<UpstreamKey | null> {
  return db
    .prepare(
      `SELECT id, upstream_id, name, api_key, enabled, status, latency_ms, last_error, last_checked_at, last_used_at
       FROM ai_upstream_keys WHERE id = ?`
    )
    .bind(id)
    .first<UpstreamKey>()
}

/** Endpoint 拼接：TrimRight(base_url,'/') + '/' + path（不自动补 /v1，base_url 需自带）。 */
export function endpoint(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

export async function markKeyOK(db: D1Database, id: number, latencyMS: number): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_upstream_keys SET status = ?, latency_ms = ?, last_error = NULL, last_used_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(KeyStatus.OK, latencyMS, rfc(), rfc(), id)
    .run()
}

export async function markKeyError(db: D1Database, id: number, errMsg: string): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_upstream_keys SET status = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(KeyStatus.ERROR, errMsg.slice(0, 500), rfc(), rfc(), id)
    .run()
}

export async function markUpstreamModelChecked(
  db: D1Database,
  id: number,
  ok: boolean,
  latencyMS: number,
  errMsg: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_upstream_models SET status = ?, latency_ms = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(ok ? KeyStatus.OK : KeyStatus.ERROR, latencyMS, ok ? null : errMsg, rfc(), rfc(), id)
    .run()
}

// ---------- 计费（Go 版 ConsumeUsage，全平台只此一处） ----------

/** 按倍率折算应扣积分：每千 token × 倍率，向上取整（1 token 也不白送）。 */
export function costOf(ratio: number, totalTokens: number): number {
  if (totalTokens <= 0 || ratio <= 0) return 0
  return Math.ceil((totalTokens / 1000) * ratio)
}

/**
 * 记一次调用用量并按规则扣分：
 * · 消耗积分 = ceil(总 token ÷ 1000 × 实际倍率)；余额不足扣到 0 不出负数
 * · 管理员不扣（平台是自己的）；用量始终入账，ai_usages.points 记实际扣除额
 * 扣分用「读最新余额 → 条件更新」避免并发互踩（D1 batch 保证原子）。
 */
export async function consumeUsage(
  db: D1Database,
  user: UserRow | null,
  deviceID: number,
  model: string,
  ratio: number,
  prompt: number,
  completion: number,
  total: number
): Promise<void> {
  if (total <= 0) total = prompt + completion
  const cost = costOf(ratio, total)
  const now = rfc()
  let charged = 0

  if (user && user.role !== 'admin' && cost > 0) {
    const row = await db.prepare(`SELECT points FROM users WHERE id = ?`).bind(user.id).first<{ points: number }>()
    const balance = row?.points ?? 0
    charged = Math.min(cost, Math.max(0, balance))
    if (charged > 0) {
      await db.batch([
        db
          .prepare(`UPDATE users SET points = points - ?, updated_at = ? WHERE id = ? AND points >= ?`)
          .bind(charged, now, user.id, charged),
        db
          .prepare(
            `INSERT INTO point_logs (user_id, change, after, type, remark, operator_id, created_at, updated_at)
             VALUES (?, ?, ?, 'consume', ?, NULL, ?, ?)`
          )
          .bind(user.id, -charged, balance - charged, `${model} · ${total} token`, now, now)
      ])
    }
  }

  await db
    .prepare(
      `INSERT INTO ai_usages (user_id, device_id, model, ratio, prompt_tokens, completion_tokens, total_tokens, points, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ide', ?, ?)`
    )
    .bind(user?.id ?? null, deviceID > 0 ? deviceID : null, model, ratio, prompt, completion, total, charged, now, now)
    .run()
}

// ---------- 用量汇总（Go 版 UsageSummaryOf） ----------

export interface Bucket {
  calls: number
  tokens: number
  points: number
}

export interface Row {
  label: string
  calls: number
  tokens: number
  points: number
}

export const SERIES_MODELS = 8
export const SERIES_DAYS = 366
export const DAYS_LIMIT = 400
export const MODELS_LIMIT = 100
export const DEFAULT_RANGE_DAYS = 30

/**
 * 解析查询区间（对齐 Go UsageRange）：from/to 是 'YYYY-MM-DD'；缺省最近 30 天；
 * from > to 交换。日界按 TZ_HOURS 时区换算成 UTC 时间戳。
 */
export function usageRange(fromStr: string | undefined, toStr: string | undefined, tz: number): { from: Date; to: Date } {
  const now = new Date()
  let from = fromStr ? dayStartOf(fromStr, tz) : addDays(dayStartOf(fmtDate(now), tz), -(DEFAULT_RANGE_DAYS - 1))
  let to = toStr ? dayEndOf(toStr, tz) : now
  if (from > to) {
    const f = from
    from = dayStartOf(fmtDate(to), tz)
    to = dayEndOf(fmtDate(f), tz)
  }
  return { from, to }
}

function dayStartOf(day: string, tz: number): Date {
  const t = Date.parse(day + 'T00:00:00Z')
  return new Date((Number.isNaN(t) ? Date.now() : t) - tz * 3600_000)
}

function dayEndOf(day: string, tz: number): Date {
  const t = Date.parse(day + 'T00:00:00Z')
  return new Date((Number.isNaN(t) ? Date.now() : t) + 86400_000 - 1 - tz * 3600_000)
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400_000)
}

export interface UsageSummary {
  from: string
  to: string
  points: number
  exempt: boolean
  range: Bucket
  today: Bucket
  yesterday: Bucket
  all: Bucket
  days: Row[]
  models: Row[]
  series: { dates: string[]; models: { label: string; tokens: number; points: number[] }[] }
}

/** 汇总一个用户的用量（exempt=管理员时所有 points 恒为 0）。 */
export async function usageSummaryOf(
  db: D1Database,
  userID: number,
  exempt: boolean,
  from: Date,
  to: Date,
  tz: number
): Promise<UsageSummary> {
  const pointsExpr = exempt ? '0' : 'COALESCE(SUM(points), 0)'
  const todayStart = dayStartUTC(new Date(), tz)
  const yesterdayStart = addDays(todayStart, -1)
  const dayRow = (r: { label: string | null; calls: number; tokens: number; points: number }): Row => ({
    label: r.label ?? '',
    calls: r.calls,
    tokens: r.tokens,
    points: r.points
  })

  const bucket = async (fromS: string | null, toS: string | null): Promise<Bucket> => {
    let q = `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, ${pointsExpr} AS points
             FROM ai_usages WHERE user_id = ?`
    const args: unknown[] = [userID]
    if (fromS) {
      q += ` AND created_at >= ?`
      args.push(fromS)
    }
    if (toS) {
      q += ` AND created_at <= ?`
      args.push(toS)
    }
    return (await db.prepare(q).bind(...args).first<Bucket>()) ?? { calls: 0, tokens: 0, points: 0 }
  }
  const bucketBetween = async (fromS: string, toS: string): Promise<Bucket> =>
    (await db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, ${pointsExpr} AS points
         FROM ai_usages WHERE user_id = ? AND created_at >= ? AND created_at < ?`
      )
      .bind(userID, fromS, toS)
      .first<Bucket>()) ?? { calls: 0, tokens: 0, points: 0 }

  const grouped = async (labelExpr: string, orderBy: string, limit: number): Promise<Row[]> => {
    const r = await db
      .prepare(
        `SELECT ${labelExpr} AS label, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, ${pointsExpr} AS points
         FROM ai_usages WHERE user_id = ? AND created_at >= ? AND created_at <= ?
         GROUP BY ${labelExpr} ORDER BY ${orderBy} LIMIT ?`
      )
      .bind(userID, rfc(from), rfc(to), limit)
      .all<{ label: string | null; calls: number; tokens: number; points: number }>()
    return (r.results ?? []).map(dayRow)
  }

  const [range, today, yesterday, all, days, models] = await Promise.all([
    bucket(rfc(from), rfc(to)),
    bucket(rfc(todayStart), null),
    bucketBetween(rfc(yesterdayStart), rfc(todayStart)),
    bucket(null, null),
    grouped(`DATE(created_at)`, `DATE(created_at) ASC`, DAYS_LIMIT),
    grouped(`model`, `tokens DESC`, MODELS_LIMIT)
  ])

  // 趋势折线：每天 × 每个模型交叉，缺数据的天补 0
  const dates: string[] = []
  for (let d = new Date(from); d <= to && dates.length < SERIES_DAYS; d = addDays(d, 86400_000)) {
    dates.push(fmtDate(d.getTime() + tz * 3600_000))
  }
  const sr = await db
    .prepare(
      `SELECT model, DATE(created_at) AS day, SUM(total_tokens) AS tokens
       FROM ai_usages WHERE user_id = ? AND created_at >= ? AND created_at <= ?
       GROUP BY model, DATE(created_at)`
    )
    .bind(userID, rfc(from), rfc(to))
    .all<{ model: string; day: string; tokens: number }>()
  const byModel = new Map<string, Map<string, number>>()
  for (const x of sr.results ?? []) {
    if (!byModel.has(x.model)) byModel.set(x.model, new Map())
    byModel.get(x.model)!.set(x.day, x.tokens)
  }
  const series = [...byModel.entries()]
    .map(([label, m]) => {
      const points = dates.map((day) => m.get(day) ?? 0)
      return { label, tokens: points.reduce((a, b) => a + b, 0), points }
    })
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, SERIES_MODELS)

  return {
    from: fmtDate(from.getTime() + tz * 3600_000),
    to: fmtDate(to.getTime() + tz * 3600_000),
    points: 0, // handler 里用用户当前余额覆盖
    exempt,
    range,
    today,
    yesterday,
    all,
    days,
    models,
    series: { dates, models: series }
  }
}

// ---------- 积分流水与用量明细 ----------

export interface PointLogRow {
  id: number
  user_id: number
  change: number
  after: number
  type: string
  remark: string
  operator_id: number | null
  created_at: string
  updated_at: string
}

export function typeLabel(typ: string): string {
  if (typ === 'consume') return '消耗'
  if (typ === 'grant') return '发放'
  return '调整'
}

export async function listPointLogs(
  db: D1Database,
  userID: number,
  typ: string,
  page: number,
  per: number
): Promise<{ items: PointLogRow[]; total: number }> {
  const where = typ ? `WHERE user_id = ? AND type = ?` : `WHERE user_id = ?`
  const args: unknown[] = typ ? [userID, typ] : [userID]
  const total =
    (await db.prepare(`SELECT COUNT(*) AS n FROM point_logs ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0
  const r = await db
    .prepare(`SELECT id, user_id, change, after, type, remark, operator_id, created_at, updated_at FROM point_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...args, per, (page - 1) * per)
    .all<PointLogRow>()
  return { items: r.results ?? [], total }
}

export async function listUsages(
  db: D1Database,
  userID: number,
  page: number,
  per: number
): Promise<{
  items: {
    id: number
    model: string
    ratio: number
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    points: number
    created_at: string
  }[]
  total: number
}> {
  const total =
    (await db.prepare(`SELECT COUNT(*) AS n FROM ai_usages WHERE user_id = ?`).bind(userID).first<{ n: number }>())?.n ?? 0
  const r = await db
    .prepare(
      `SELECT id, model, ratio, prompt_tokens, completion_tokens, total_tokens, points, created_at
       FROM ai_usages WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .bind(userID, per, (page - 1) * per)
    .all<{
      id: number
      model: string
      ratio: number
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
      points: number
      created_at: string
    }>()
  return { items: r.results ?? [], total }
}

/** 后台人工调整会员积分：正=发放（封顶 1 亿）、负=扣减（扣到 0 为止）。 */
export async function adjustPoints(
  db: D1Database,
  user: UserRow,
  amount: number,
  remark: string,
  operatorID: number
): Promise<void> {
  if (amount === 0) return
  if (amount > 0) amount = Math.min(amount, 100_000_000)
  else {
    amount = -Math.min(-amount, Math.max(0, user.points))
    if (amount === 0) return
  }
  const newPoints = user.points + amount
  const now = rfc()
  const typ = amount > 0 ? 'grant' : 'adjust'
  await db.batch([
    db.prepare(`UPDATE users SET points = ?, updated_at = ? WHERE id = ?`).bind(newPoints, now, user.id),
    db
      .prepare(
        `INSERT INTO point_logs (user_id, change, after, type, remark, operator_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(user.id, amount, newPoints, typ, remark, operatorID, now, now)
  ])
}

/** 后台会员列表按 id 取（调积分前要拿当前余额）。 */
export async function findUser(db: D1Database, id: number): Promise<UserRow | null> {
  return db
    .prepare(`SELECT id, name, email, password, role, points, status, created_at, updated_at FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>()
}

export function notFound(): never {
  throw fail(404, '会员不存在')
}
