import { adapter } from './adapter.ts'
import type { LocalUsage, LocalUsageRow } from './types.ts'

/**
 * 本机用量统计（设置 → 使用量的「本机统计」块）。
 *
 * 数据全部来自内核的会话存储，经内核官方 REST 读出，**不碰 SQLite 内部结构**：
 *   GET /session               → 全部会话（不带 directory 就是跨项目的全集，含 time.updated）
 *   GET /session/{id}/message  → 会话消息，assistant 消息的 info 带 tokens / modelID / time
 *
 * 聚合口径：tokens 用消息的 tokens.total（内核口径，含 cache），调用次数按 assistant 消息条数，
 * 日期取消息创建时刻的本地时区。平台统计是全设备口径，这里是这台机器的口径，两者并列展示。
 */

/** 一条助手消息的用量事实（从内核 message info 里摘出来的最小记录） */
interface UsageFact {
  /** 消息创建时刻（epoch ms） */
  ts: number
  /** 模型 ID（条形图与趋势线的分组键） */
  model: string
  /** tokens.total（含 cache） */
  tokens: number
}

/** 会话级缓存：time.updated 没变的会话直接复用上次摘出的用量事实，不重复拉消息 */
const cache = new Map<string, { updated: number; facts: UsageFact[] }>()

interface SessionInfo {
  id: string
  time?: { updated?: number }
}

function ymdLocal(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 区间内每一天（YYYY-MM-DD，升序，含首尾） */
function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(from + 'T00:00:00')
  const end = new Date(to + 'T00:00:00')
  for (let d = start; d <= end; d.setDate(d.getDate() + 1)) out.push(ymdLocal(d.getTime()))
  return out
}

/** 摘一个会话的用量事实：缓存命中直接复用，否则拉全量消息后逐条摘 */
async function factsOf(sess: SessionInfo): Promise<UsageFact[]> {
  const updated = sess.time?.updated ?? 0
  const hit = cache.get(sess.id)
  if (hit && hit.updated === updated) return hit.facts
  const res = await adapter.api(`/session/${sess.id}/message`)
  if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(String(res.data ?? '内核消息列表不可用'))
  const facts: UsageFact[] = []
  for (const env of res.data as Array<{ info?: { role?: string; modelID?: string; tokens?: { total?: number }; time?: { created?: number } } }>) {
    const info = env.info
    if (!info || info.role !== 'assistant' || !info.tokens) continue
    facts.push({ ts: info.time?.created ?? 0, model: info.modelID || '?', tokens: info.tokens.total ?? 0 })
  }
  cache.set(sess.id, { updated, facts })
  return facts
}

/**
 * 汇总本机用量。from/to 为空时按「今天」处理（今日/昨日/累计不依赖区间，永远可算）。
 *
 * 请求全部走本地内核（127.0.0.1），分批并发拉消息（一批 6 个）避免大会话库时一瞬打满；
 * 单个会话拉取失败跳过（内核重启间隙可能短暂 502），已缓存的那部分照常汇总。
 */
export async function localUsage(from: string, to: string): Promise<LocalUsage> {
  const res = await adapter.api('/session')
  if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(String(res.data ?? '内核会话列表不可用'))
  const sessions = res.data as SessionInfo[]

  // 消失的会话清缓存（删除会话后不留孤儿数据）
  const alive = new Set(sessions.map((s) => s.id))
  for (const sid of cache.keys()) if (!alive.has(sid)) cache.delete(sid)

  // 分批并发摘事实；单会话失败跳过不炸整体
  const batches: SessionInfo[][] = []
  for (let i = 0; i < sessions.length; i += 6) batches.push(sessions.slice(i, i + 6))
  const facts: UsageFact[] = []
  for (const batch of batches) {
    const parts = await Promise.all(
      batch.map((s) => factsOf(s).catch(() => [] as UsageFact[]))
    )
    for (const part of parts) facts.push(...part)
  }

  const today = ymdLocal(Date.now())
  const yesterday = ymdLocal(Date.now() - 86_400_000)
  const f = from || today
  const t = to || today

  // 滚动窗口起点（含今天，往前 N-1 天）：与今日/昨日一样是固定口径，不随区间筛选变化
  const dayStart = (offsetDays: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - offsetDays)
    return ymdLocal(d.getTime())
  }
  const last7From = dayStart(6)
  const last30From = dayStart(29)
  const last90From = dayStart(89)

  const empty = { calls: 0, tokens: 0 }
  const all = { ...empty }
  const todayB = { ...empty }
  const yesterdayB = { ...empty }
  const range = { ...empty }
  const last7 = { ...empty }
  const last30 = { ...empty }
  const last90 = { ...empty }
  const byModel = new Map<string, { calls: number; tokens: number }>()
  const byDayModel = new Map<string, number>() // `${date}\u0000${model}` → tokens
  for (const fact of facts) {
    all.calls += 1
    all.tokens += fact.tokens
    const day = ymdLocal(fact.ts)
    if (day === today) {
      todayB.calls += 1
      todayB.tokens += fact.tokens
    } else if (day === yesterday) {
      yesterdayB.calls += 1
      yesterdayB.tokens += fact.tokens
    }
    // 滚动窗口逐级收紧（90 ⊃ 30 ⊃ 7），上限恒为今天
    if (day >= last90From) {
      last90.calls += 1
      last90.tokens += fact.tokens
      if (day >= last30From) {
        last30.calls += 1
        last30.tokens += fact.tokens
        if (day >= last7From) {
          last7.calls += 1
          last7.tokens += fact.tokens
        }
      }
    }
    if (day >= f && day <= t) {
      range.calls += 1
      range.tokens += fact.tokens
      const m = byModel.get(fact.model) ?? { calls: 0, tokens: 0 }
      m.calls += 1
      m.tokens += fact.tokens
      byModel.set(fact.model, m)
      const key = day + '\u0000' + fact.model
      byDayModel.set(key, (byDayModel.get(key) ?? 0) + fact.tokens)
    }
  }

  const dates = eachDay(f, t)
  // token 总量为 0 的模型不展示（异常轮/空轮会有 calls>0 但 tokens=0 的记录，条形图上是一根看不见的杆）
  const models: LocalUsageRow[] = [...byModel.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .filter((m) => m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  const series = {
    dates,
    models: models.map((m) => ({
      label: m.label,
      tokens: m.tokens,
      points: dates.map((d) => byDayModel.get(d + '\u0000' + m.label) ?? 0)
    }))
  }

  return { from: f, to: t, range, today: todayB, yesterday: yesterdayB, all, last7, last30, last90, models, series }
}
