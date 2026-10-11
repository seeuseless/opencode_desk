/**
 * OpenAI 兼容网关（契约第 2 节 / Go 版 internal/gateway）。
 *
 * 模型名是唯一对外标识；一个模型名可被多个上游同时提供，依次尝试：
 * 先在一个上游内部的多把 Key 之间故障转移，用尽后换下一个上游。
 * 只在「还没开始回包」的阶段重试（连不上、401、429、5xx）——一旦开始推流就不再切换。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  availableUpstreamModels,
  consumeUsage,
  effectiveRatio,
  endpoint,
  findModelByName,
  findUpstream,
  listKeysByUpstream,
  listModels,
  markKeyError,
  markKeyOK,
  markUpstreamModelChecked,
  type Model,
  type Upstream,
  type UpstreamKey,
  type UpstreamModel
} from './ai.ts'
import { userOf, auth, type AppEnv } from './auth.ts'
import { fail, runBg } from './db.ts'

export const gw = new Hono<AppEnv>()
gw.use('*', auth)

/** GET /api/ide/v1/models — 可用模型清单（没有上游能提供的不对外暴露）。 */
gw.get('/models', async (c) => {
  const db = c.env.DB
  const list = await listModels(db)
  const data: Record<string, unknown>[] = []
  for (const m of list) {
    const avail = await availableUpstreamModels(db, m.id)
    if (avail.length === 0) continue
    data.push(await modelPayload(c, m, avail))
  }
  return c.json({ object: 'list', data })
})

async function modelPayload(
  c: Context<AppEnv>,
  m: Model,
  avail: UpstreamModel[]
): Promise<Record<string, unknown>> {
  const upstreams: Record<string, unknown>[] = []
  const names: string[] = []
  const seen = new Set<string>()
  for (const sm of avail) {
    const up = await findUpstream(c.env.DB, sm.upstream_id)
    if (!up) continue
    upstreams.push({ name: up.name, model: sm.model, status: sm.status })
    if (up.name && !seen.has(up.name)) {
      seen.add(up.name)
      names.push(up.name)
    }
  }
  const ownedBy = names.join(' / ') || 'platform'
  return {
    id: m.name,
    object: 'model',
    created: Math.floor(Date.parse(m.created_at) / 1000),
    owned_by: ownedBy,
    name: m.name,
    builtin: !!m.builtin,
    ratio: m.ratio,
    free: !!m.free,
    discount: m.discount,
    discount_label: discountLabelOf(m),
    effective_ratio: effectiveRatio(m),
    upstreams
  }
}

function discountLabelOf(m: Model): string {
  if (m.discount == null) return ''
  return String(Number(m.discount.toFixed(6))) + 'x'
}

// ---------- chat/completions ----------

interface Candidate {
  scoped: UpstreamModel
  key: UpstreamKey
  up: Upstream
}

/** Key 排序：状态 ok(0) < unknown(1) < error(2)，同状态按 last_used_at 最久未用优先。 */
function orderedKeys(keys: UpstreamKey[]): UpstreamKey[] {
  const rank = (s: string): number => (s === 'ok' ? 0 : s === 'unknown' ? 1 : 2)
  return [...keys].sort((a, b) => {
    const ra = rank(a.status)
    const rb = rank(b.status)
    if (ra !== rb) return ra - rb
    return Date.parse(a.last_used_at ?? '') - Date.parse(b.last_used_at ?? '')
  })
}

async function candidates(db: D1Database, m: Model): Promise<Candidate[]> {
  const scoped = await availableUpstreamModels(db, m.id)
  const out: Candidate[] = []
  for (const sm of scoped) {
    const up = await findUpstream(db, sm.upstream_id)
    if (!up) continue
    const keys = await listKeysByUpstream(db, sm.upstream_id)
    for (const k of orderedKeys(keys)) out.push({ scoped: sm, key: k, up })
  }
  return out
}

/** POST /api/ide/v1/chat/completions — 对话转发（流式逐块透传 + 边转发边扫用量）。 */
gw.post('/chat/completions', async (c) => {
  let raw: Record<string, unknown>
  try {
    raw = (await c.req.json()) as Record<string, unknown>
  } catch {
    throw fail(422, '请求体不是合法 JSON')
  }
  const model = typeof raw.model === 'string' ? raw.model : ''
  if (!model || model.length > 190) throw fail(422, 'model 必填且不超过 190 字')
  const msgs = raw.messages
  if (!Array.isArray(msgs) || msgs.length === 0) throw fail(422, 'messages 必填且为非空数组')
  const stream = raw.stream === true

  const m = await findModelByName(c.env.DB, model)
  if (!m) throw fail(404, '模型不存在或没有可用上游：' + model)
  const cands = await candidates(c.env.DB, m)
  if (cands.length === 0) {
    throw fail(503, '该模型还没有可用上游：请在上游里「自动获取模型」或补一把可用 Key')
  }

  // 除 model 外的所有字段原样转发；计费按「实际倍率」（限免 0、打折已乘折扣）
  const ratio = effectiveRatio(m)
  const u = userOf(c)
  const deviceID = await deviceIDOf(c, u)

  let lastErr = '未知错误'
  for (const cand of cands) {
    const started = Date.now()
    const body: Record<string, unknown> = { ...raw }
    delete body.model
    body.model = cand.scoped.model
    body.stream = stream
    if (stream && !('stream_options' in body)) {
      // 让上游在最后一块带上 usage，否则流式调用没法计费
      body.stream_options = { include_usage: true }
    }

    let res: Response
    try {
      res = await fetch(endpoint(cand.up.base_url, 'chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${cand.key.api_key}`
        },
        body: JSON.stringify(body)
      })
    } catch (e) {
      lastErr = `连接上游失败: ${e instanceof Error ? e.message : String(e)}`
      await markKeyError(c.env.DB, cand.key.id, lastErr.slice(0, 500))
      continue
    }

    if (res.status >= 400) {
      const text = await res.text()
      lastErr = errorOf(res.status, text)
      await markKeyError(c.env.DB, cand.key.id, lastErr.slice(0, 500))
      await maybeMarkModelMissing(c.env.DB, cand, lastErr)
      continue
    }

    await markKeyOK(c.env.DB, cand.key.id, Date.now() - started)
    await markUpstreamModelChecked(c.env.DB, cand.scoped.id, true, Date.now() - started, '')

    if (!stream) {
      const json = await res.text()
      const usage = usageOfText(json)
      if (usage) {
        const { prompt, completion, total } = usageTokens(usage)
        await consumeUsage(c.env.DB, u, deviceID, m.name, ratio, prompt, completion, total)
      }
      return c.body(json, 200, { 'Content-Type': 'application/json; charset=utf-8' })
    }

    // 流式：拿到响应头就算「开始回包」，之后任何失败都不能再切 Key。
    // 逐块透传给客户端，同时扫出最后一块里的 usage；流结束后 waitUntil 扣费——计费不阻塞用户看输出。
    let usage: Record<string, unknown> | null = null
    let streamEnded: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      streamEnded = resolve
    })
    const decoder = new TextDecoder()
    let buf = ''
    const scanned = res.body!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctrl) {
          ctrl.enqueue(chunk)
          buf += decoder.decode(chunk, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const found = usageOfLine(line)
            if (found) usage = found
          }
        },
        flush() {
          for (const line of buf.split('\n')) {
            const found = usageOfLine(line)
            if (found) usage = found
          }
          streamEnded()
        }
      })
    )
    runBg(
      c,
      (async () => {
        // 等扫流结束（流正常结束/flush 会让 resolve；客户端断流则 60s 兜底），usage 定格后再入账
        await Promise.race([finished, new Promise((r) => setTimeout(r, 60_000))])
        if (usage) {
          const { prompt, completion, total } = usageTokens(usage)
          await consumeUsage(c.env.DB, u, deviceID, m.name, ratio, prompt, completion, total)
        }
      })()
    )
    return new Response(scanned, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive'
      }
    })
  }
  throw fail(502, `所有上游与 API Key 均调用失败：${lastErr}`)
})

async function maybeMarkModelMissing(db: D1Database, cand: Candidate, errMsg: string): Promise<void> {
  const lower = errMsg.toLowerCase()
  if (lower.includes('404') || errMsg.includes('不存在') || lower.includes('not found')) {
    await markUpstreamModelChecked(db, cand.scoped.id, false, 0, errMsg.slice(0, 500))
  }
}

/** 从一块文本里找带 usage 的 data: 行（流式的 usage 在最后一块）。 */
function usageOfLine(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t.startsWith('data:')) return null
  const payload = t.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const u = parsed.usage
    if (u && typeof u === 'object' && Object.keys(u).length > 0) return u as Record<string, unknown>
  } catch {
    /* 非整行 JSON，忽略 */
  }
  return null
}

function usageOfText(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const u = parsed.usage
    if (u && typeof u === 'object' && Object.keys(u).length > 0) return u as Record<string, unknown>
  } catch {
    /* 非 JSON */
  }
  return null
}

function usageTokens(u: Record<string, unknown>): { prompt: number; completion: number; total: number } {
  const prompt = toInt(u['prompt_tokens'])
  const completion = toInt(u['completion_tokens'])
  let total = toInt(u['total_tokens'])
  if (total <= 0) total = prompt + completion
  return { prompt, completion, total }
}

function toInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v)
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.trunc(n) : 0
  }
  return 0
}

/** 用量归属到哪台电脑：客户端在请求头带上 X-Qingniao-Device；拿不到记 0（仍入账）。 */
async function deviceIDOf(c: Context<AppEnv>, u: { id: number }): Promise<number> {
  const id = toInt(c.req.header('X-Qingniao-Device'))
  if (id <= 0) return 0
  const dev = await c.env.DB.prepare(`SELECT id, user_id FROM ide_devices WHERE id = ?`).bind(id).first<{ user_id: number }>()
  return dev && dev.user_id === u.id ? id : 0
}

/** 上游错误响应 → 可读文本（上游测试/探测与网关共用）。 */
export function errorOf(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const err = parsed.error
    if (err && typeof err === 'object') {
      const msg = (err as Record<string, unknown>).message
      if (typeof msg === 'string' && msg) return `HTTP ${status} ${msg}`
    }
    if (typeof parsed.message === 'string' && parsed.message) return `HTTP ${status} ${parsed.message}`
  } catch {
    /* 非 JSON */
  }
  const s = body.trim().slice(0, 200)
  return s ? `HTTP ${status} ${s}` : `HTTP ${status}`
}
