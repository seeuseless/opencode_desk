/**
 * 上游操作：测 Key / 测上游 / 测模型 / 探测 / 自动获取模型 / 导入模型库 / 健康采集落库
 * （对应 Go 版 internal/upstream + store/health.go 的探测写回）。
 * URL 拼接不自动补 /v1——base_url 需自带（与 Go 版 Endpoint 一致）。
 */
import {
  availableUpstreamModels,
  endpoint,
  findModelByName,
  listKeysByUpstream,
  markKeyError,
  markKeyOK,
  markUpstreamModelChecked,
  type UpstreamKey
} from './ai.ts'
import { fail, rfc } from './db.ts'
import { errorOf } from './gateway.ts'

export interface TestResult {
  ok: boolean
  latency_ms: number
  message: string
  models?: number
}

/** 测一把 Key：GET {base}/models，HTTP<400 且能解出 data[].id 即成功。 */
export async function testKey(db: D1Database, key: UpstreamKey, base: string): Promise<TestResult> {
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(endpoint(base, 'models'), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${key.api_key}` }
    })
  } catch (e) {
    const msg = `连接上游失败: ${e instanceof Error ? e.message : String(e)}`
    await markKeyError(db, key.id, msg.slice(0, 500))
    return { ok: false, latency_ms: Date.now() - started, message: msg }
  }
  const text = await res.text()
  const models = idsOf(text)
  if (res.status < 400 && models !== null) {
    await markKeyOK(db, key.id, Date.now() - started)
    return { ok: true, latency_ms: Date.now() - started, message: '连接成功', models: models.length }
  }
  const msg = errorOf(res.status, text)
  await markKeyError(db, key.id, msg.slice(0, 500))
  return { ok: false, latency_ms: Date.now() - started, message: msg }
}

/** 从 /models 响应解出模型 id 列表；结构不对返回 null。 */
function idsOf(text: string): string[] | null {
  try {
    const parsed = JSON.parse(text) as { data?: { id?: unknown }[] }
    if (!Array.isArray(parsed.data)) return null
    const ids = parsed.data
      .map((x) => (typeof x.id === 'string' ? x.id : ''))
      .filter((x) => x !== '')
    return [...new Set(ids)]
  } catch {
    return null
  }
}

/** 测整个上游：取第一把启用的 Key 执行 TestKey；没有可用 Key 给人话。 */
export async function testUpstream(db: D1Database, upstreamID: number, base: string): Promise<TestResult> {
  const keys = await listKeysByUpstream(db, upstreamID)
  if (!keys.length) return { ok: false, latency_ms: 0, message: '还没有可用的 API Key' }
  return testKey(db, keys[0], base)
}

/** 测模型：候选=可用上游模型×各上游 Key，逐个 POST chat/completions（max_tokens:1）直到成功。 */
export async function testModel(
  db: D1Database,
  m: { id: number; name: string }
): Promise<TestResult> {
  const scoped = await availableUpstreamModels(db, m.id)
  const candidates: { key: UpstreamKey; base: string; model: string; scopedId: number }[] = []
  for (const sm of scoped) {
    const keys = await listKeysByUpstream(db, sm.upstream_id)
    for (const k of keys) {
      const up = await db
        .prepare(`SELECT base_url FROM ai_upstreams WHERE id = ?`)
        .bind(sm.upstream_id)
        .first<{ base_url: string }>()
      if (up) candidates.push({ key: k, base: up.base_url, model: sm.model, scopedId: sm.id })
    }
  }
  if (!candidates.length) return { ok: false, latency_ms: 0, message: '该模型还没有可用上游' }

  let lastErr = ''
  for (const cand of candidates) {
    const started = Date.now()
    let res: Response
    try {
      res = await fetch(endpoint(cand.base, 'chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${cand.key.api_key}`
        },
        body: JSON.stringify({
          model: cand.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1
        })
      })
    } catch (e) {
      lastErr = `连接上游失败: ${e instanceof Error ? e.message : String(e)}`
      await markKeyError(db, cand.key.id, lastErr.slice(0, 500))
      continue
    }
    const text = await res.text()
    if (res.status < 400) {
      await markKeyOK(db, cand.key.id, Date.now() - started)
      await markUpstreamModelChecked(db, cand.scopedId, true, Date.now() - started, '')
      return { ok: true, latency_ms: Date.now() - started, message: '调用成功' }
    }
    lastErr = errorOf(res.status, text)
    await markKeyError(db, cand.key.id, lastErr.slice(0, 500))
    await markUpstreamModelChecked(db, cand.scopedId, false, 0, lastErr.slice(0, 500))
  }
  return { ok: false, latency_ms: 0, message: '所有上游与 Key 均失败：' + lastErr }
}

/**
 * 探测一把 Key：对上游全部启用模型逐个发一条 1 token 的对话，把每个模型标成 ok/error。
 * 上游没有任何启用模型时给人话提示。
 */
export async function probeKey(db: D1Database, key: UpstreamKey, upstreamID: number, base: string): Promise<TestResult> {
  const models = await db
    .prepare(`SELECT id, model FROM ai_upstream_models WHERE upstream_id = ? AND enabled = 1`)
    .bind(upstreamID)
    .all<{ id: number; model: string }>()
  const list = models.results ?? []
  if (!list.length) return { ok: false, latency_ms: 0, message: '还没有上游模型，请先「自动获取模型」' }

  let okCount = 0
  for (const sm of list) {
    const started = Date.now()
    try {
      const res = await fetch(endpoint(base, 'chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${key.api_key}`
        },
        body: JSON.stringify({ model: sm.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
      })
      const text = await res.text()
      if (res.status < 400) {
        okCount++
        await markUpstreamModelChecked(db, sm.id, true, Date.now() - started, '')
      } else {
        await markUpstreamModelChecked(db, sm.id, false, 0, errorOf(res.status, text).slice(0, 500))
      }
    } catch (e) {
      await markUpstreamModelChecked(db, sm.id, false, 0, `连接上游失败: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500))
    }
  }
  await markKeyOK(db, key.id, 0)
  return { ok: okCount > 0, latency_ms: 0, message: `探测完成：${okCount}/${list.length} 可用` }
}

/**
 * 自动获取模型：用第一把启用的 Key 拉 {base}/models，逐个 INSERT OR IGNORE 到上游模型
 * （已存在的不改 enabled/status、不刷新时间）；count = 本次新增条数。
 */
export async function syncModels(
  db: D1Database,
  upstreamID: number,
  base: string
): Promise<{ message: string; count: number }> {
  const keys = await listKeysByUpstream(db, upstreamID)
  let ids: string[] | null = null
  let lastErr = ''
  for (const key of keys) {
    try {
      const res = await fetch(endpoint(base, 'models'), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${key.api_key}` }
      })
      const text = await res.text()
      if (res.status < 400) {
        ids = idsOf(text)
        if (ids !== null) break
      } else {
        lastErr = errorOf(res.status, text)
      }
    } catch (e) {
      lastErr = `连接上游失败: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (ids === null) {
    // 与 Go 版一致：拿不到清单走 500「服务端内部错误」（lastErr 已在各 key 的 last_error 里）
    throw fail(500, lastErr ? `服务端内部错误（${lastErr}）` : '服务端内部错误')
  }

  let count = 0
  for (const id of ids) {
    const r = await db
      .prepare(
        `INSERT INTO ai_upstream_models (upstream_id, model_id, model, enabled, status, created_at, updated_at)
         SELECT ?, NULL, ?, 1, 'unknown', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM ai_upstream_models WHERE upstream_id = ? AND model = ?)`
      )
      .bind(upstreamID, id, rfc(), rfc(), upstreamID, id)
      .run()
    count += r.meta.changes ?? 0
  }
  await db.prepare(`UPDATE ai_upstreams SET models_synced_at = ?, updated_at = ? WHERE id = ?`).bind(rfc(), rfc(), upstreamID).run()
  return { message: '已同步', count }
}

/** 导入到模型库：按 name 精确去重；新模型建好后自动按名认领上游模型。names 空 = 导该上游全部启用模型。 */
export async function importModels(
  db: D1Database,
  upstreamID: number,
  names: string[] | undefined,
  builtin: boolean,
  ratio: number
): Promise<{ message: string; count: number }> {
  let source: { model: string }[]
  if (names && names.length) {
    source = names.map((model) => ({ model }))
  } else {
    const r = await db
      .prepare(`SELECT model FROM ai_upstream_models WHERE upstream_id = ? AND enabled = 1`)
      .bind(upstreamID)
      .all<{ model: string }>()
    source = r.results ?? []
  }
  const effective = ratio > 0 ? ratio : 1
  let count = 0
  for (const s of source) {
    if (await findModelByName(db, s.model)) continue
    const now = rfc()
    const r = await db
      .prepare(
        `INSERT INTO ai_models (name, builtin, ratio, enabled, remark, sort, free, discount, created_at, updated_at)
         VALUES (?, ?, ?, 1, '', 0, 0, NULL, ?, ?)`
      )
      .bind(s.model, builtin ? 1 : 0, effective, now, now)
      .run()
    count++
    const modelID = r.meta.last_row_id ?? 0
    if (modelID > 0) {
      await db
        .prepare(`UPDATE ai_upstream_models SET model_id = ?, updated_at = ? WHERE upstream_id = ? AND model = ? AND model_id IS NULL`)
        .bind(modelID, now, upstreamID, s.model)
        .run()
    }
  }
  return { message: '已导入', count }
}

/**
 * 健康采集落库（cron 每分钟调）：明细写 ai_model_health_checks，
 * 按天聚合 upsert ai_model_health_days（仅已匹配 model_id 的计入；失败的也计入 total）。
 */
export async function recordHealthCheck(
  db: D1Database,
  upstreamModelID: number,
  ok: boolean,
  latencyMS: number,
  errMsg: string
): Promise<void> {
  const now = rfc()
  const day = now.slice(0, 10)
  const sm = await db
    .prepare(`SELECT model_id FROM ai_upstream_models WHERE id = ?`)
    .bind(upstreamModelID)
    .first<{ model_id: number | null }>()
  await db
    .prepare(`INSERT INTO ai_model_health_checks (upstream_model_id, ok, latency_ms, error, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(upstreamModelID, ok ? 1 : 0, latencyMS || null, ok ? null : errMsg, now)
    .run()
  if (!sm?.model_id) return
  await db
    .prepare(
      `INSERT INTO ai_model_health_days (model_id, day, total, ok, created_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (model_id, day) DO UPDATE SET total = total + 1, ok = ok + excluded.ok`
    )
    .bind(sm.model_id, day, ok ? 1 : 0, now)
    .run()
}

/** 健康采集的一轮：每个启用的上游只探一个模型（同上游多模型轮换，取最久没检查的那个）。 */
export async function probeRound(db: D1Database): Promise<void> {
  const upstreams = await db
    .prepare(`SELECT id, base_url FROM ai_upstreams WHERE enabled = 1 ORDER BY sort ASC, id ASC`)
    .all<{ id: number; base_url: string }>()
  for (const up of upstreams.results ?? []) {
    const sm = await db
      .prepare(
        `SELECT id, model FROM ai_upstream_models
         WHERE upstream_id = ? AND enabled = 1 AND model_id IS NOT NULL
         ORDER BY last_checked_at IS NULL DESC, last_checked_at ASC LIMIT 1`
      )
      .bind(up.id)
      .first<{ id: number; model: string }>()
    if (!sm) continue
    const keys = await listKeysByUpstream(db, up.id)
    if (!keys.length) continue
    const key = keys[0]
    const started = Date.now()
    let ok = false
    let err = ''
    try {
      const res = await fetch(endpoint(up.base_url, 'chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${key.api_key}`
        },
        body: JSON.stringify({ model: sm.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
      })
      const text = await res.text()
      ok = res.status < 400
      if (!ok) err = errorOf(res.status, text)
    } catch (e) {
      err = `连接上游失败: ${e instanceof Error ? e.message : String(e)}`
    }
    const latency = Date.now() - started
    await markUpstreamModelChecked(db, sm.id, ok, ok ? latency : 0, err)
    await recordHealthCheck(db, sm.id, ok, latency, err)
  }
}
