/**
 * 计划任务调度器（主进程）。
 *
 * 左侧栏「计划任务」区块的数据与触发都在这里：数据落 ~/.qingniaoai/schedules.json，
 * 到点（30 秒一跳的 tick）在内置「任务」目录新建一个内核会话并发送 prompt——
 * 复用渲染层同一条 REST 链路（adapter.api，model 不传自动回落默认档），
 * 会话随即出现在左栏任务列表里，点「计划任务」行可跳回看结果。
 *
 * 进程关窗后驻留托盘（win:close 只隐藏窗口），调度器照跑；
 * 应用完全没在跑导致错过执行时刻的（nextRun 过期超 3 个 tick 窗口），**跳过本次**：
 * 读盘归一化时把过期的 nextRun 推进到下一个周期（窗口内的刚过点不算错过，留给 tick 触发）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { qingniaoHome } from './config.ts'
import { adapter } from './adapter.ts'
import type { ScheduleRan, ScheduleSpec, ScheduleTask } from './types.ts'

const TICK_MS = 30_000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/**
 * 「错过」判据：nextRun 过期超过 3 个 tick 才认为当时应用没在跑 → 跳过推进下个周期；
 * 窗口内（正常 tick 抖动 / 刚过点）保留 nextRun 原值，交给 tick 触发执行。
 */
const STALE_MS = 3 * TICK_MS
/** 内置「任务」目录（startScheduler 注入，= 主进程 index.ts 的 workspace） */
let workspace = ''
/** 执行完成通知（index.ts 注入：转发 schedule:ran 给渲染层） */
let onRan: ((r: ScheduleRan) => void) | null = null
/** tick / 手动执行共用的任务锁：防止同一任务并发创建多个会话 */
const runningTaskIds = new Set<string>()
/** 防止上一轮 tick 尚未完成时，下一轮 30 秒定时器重入 */
let ticking = false

const schedulesPath = () => join(qingniaoHome(), 'schedules.json')

/** 形状校验：只认三种定时方式，时刻/间隔越界一律判非法（手改存档时防崩） */
function isValidSpec(x: unknown): x is ScheduleSpec {
  const s = x as Partial<{ kind: string; day: number; hour: number; minute: number; everyHours: number }> | null
  if (!s) return false
  const ok = (n: unknown, max: number) => Number.isFinite(Number(n)) && Number(n) >= 0 && Number(n) < max
  if (s.kind === 'daily' || s.kind === 'weekly') {
    if (!ok(s.hour, 24) || !ok(s.minute, 60)) return false
    if (s.kind === 'weekly') return Number(s.day) >= 1 && Number(s.day) <= 7
    return true
  }
  return s.kind === 'hourly' && Number(s.everyHours) >= 1 && Number(s.everyHours) <= 24
}

/** 单条归一化：缺字段补默认，过期的 nextRun 重算到下个周期（即「错过跳过」语义） */
function normalizeTask(x: unknown): ScheduleTask | null {
  const t = x as Partial<ScheduleTask> | null
  if (!t || typeof t.id !== 'string' || !t.id.trim()) return null
  if (typeof t.name !== 'string' || typeof t.prompt !== 'string') return null
  const spec = t.spec as unknown
  if (!isValidSpec(spec)) return null
  const now = Date.now()
  const lastRun = Number(t.lastRun) > 0 ? Number(t.lastRun) : undefined
  const nextRun = Number(t.nextRun) > 0 ? Number(t.nextRun) : 0
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    spec,
    enabled: t.enabled !== false,
    createdAt: Number(t.createdAt) > 0 ? Number(t.createdAt) : now,
    nextRun: nextRun > now - STALE_MS ? nextRun : nextRunAfter(spec, now, lastRun),
    ...(lastRun ? { lastRun } : {}),
    ...(typeof t.lastSession === 'string' ? { lastSession: t.lastSession } : {}),
    ...(typeof t.lastError === 'string' && t.lastError ? { lastError: t.lastError } : {})
  }
}

/** 读全量清单：文件缺失/损坏按空列表处理（与 settings.json 的容错风格一致） */
export function readSchedules(): ScheduleTask[] {
  try {
    if (!existsSync(schedulesPath())) return []
    const raw = JSON.parse(readFileSync(schedulesPath(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeTask).filter((t): t is ScheduleTask => !!t)
  } catch {
    return []
  }
}

function writeSchedules(list: ScheduleTask[]): void {
  mkdirSync(qingniaoHome(), { recursive: true })
  writeFileSync(schedulesPath(), JSON.stringify(list, null, 2))
}

/** 严格晚于 from 的首个执行时刻。
 * hourly 型以 anchor（lastRun 或 createdAt）为对齐基准，其余两种只看时刻本身。 */
export function nextRunAfter(spec: ScheduleSpec, from: number, anchor?: number): number {
  if (spec.kind === 'hourly') {
    const step = spec.everyHours * HOUR_MS
    const base = anchor ?? from
    // 严格晚于 from 的首个对齐步（from 恰落步上也要 +1 步）；from 早于 base 时即 base 本身
    return base + (Math.floor((from - base) / step) + 1) * step
  }
  const at = new Date(from)
  at.setHours(spec.hour, spec.minute, 0, 0)
  let t = at.getTime()
  if (spec.kind === 'weekly') {
    // day: 1-7（周一..周日）→ JS getDay()：0=周日, 6=周六
    const target = spec.day === 7 ? 0 : spec.day
    t += ((target - at.getDay() + 7) % 7) * DAY_MS
    if (t <= from) t += 7 * DAY_MS
    return t
  }
  if (t <= from) t += DAY_MS
  return t
}

/** 新建：补 createdAt / nextRun；编辑：保留执行历史（lastRun/lastSession/lastError），按新 spec 重算 nextRun */
export function upsertSchedule(t: ScheduleTask): ScheduleTask[] {
  const norm = normalizeTask(t)
  if (!norm) throw new Error('计划任务数据不合法')
  const now = Date.now()
  const list = readSchedules()
  const old = list.find((x) => x.id === norm.id)
  if (old) {
    norm.createdAt = old.createdAt
    norm.lastRun = old.lastRun
    norm.lastSession = old.lastSession
    norm.lastError = old.lastError
    norm.nextRun = nextRunAfter(norm.spec, now, old.lastRun)
    list.splice(list.indexOf(old), 1, norm)
  } else {
    norm.createdAt = now
    norm.nextRun = nextRunAfter(norm.spec, now, now)
    list.push(norm)
  }
  writeSchedules(list)
  return list
}

export function removeSchedule(id: string): ScheduleTask[] {
  const list = readSchedules().filter((x) => x.id !== id)
  writeSchedules(list)
  return list
}

/** 执行一次：建会话 + 发 prompt（两步都是内核即时受理，跑不跑完不阻塞这里） */
async function runTask(task: ScheduleTask): Promise<{ sessionId?: string; error?: string }> {
  if (!workspace) return { error: '执行目录未初始化' }
  const qs = '?directory=' + encodeURIComponent(workspace)
  const r1 = await adapter.api('/session' + qs, 'POST', { title: '[计划] ' + task.name })
  if (r1.status >= 400) return { error: String(r1.data ?? '创建会话失败') }
  const sid = (r1.data as { id?: string } | null)?.id
  if (!sid) return { error: '创建会话未返回 id' }
  const r2 = await adapter.api('/session/' + sid + '/message' + qs, 'POST', {
    parts: [{ type: 'text', text: task.prompt }]
  })
  if (r2.status >= 400) return { sessionId: sid, error: String(r2.data ?? '发送任务内容失败') }
  return { sessionId: sid }
}

/** 领取本轮执行：先推进并落盘 nextRun，避免执行中崩溃/重入后再次创建同一轮会话 */
function claimSchedule(list: ScheduleTask[], task: ScheduleTask): void {
  task.lastRun = Date.now()
  task.nextRun = nextRunAfter(task.spec, task.lastRun, task.lastRun)
  writeSchedules(list)
}

/** 回写执行结果；不覆盖执行期间可能被用户编辑的 nextRun */
function writeRunResult(id: string, res: { sessionId?: string; error?: string }): void {
  const list = readSchedules()
  const task = list.find((x) => x.id === id)
  if (!task) return
  task.lastRun = Date.now()
  if (res.sessionId) task.lastSession = res.sessionId
  if (res.error) task.lastError = res.error
  else task.lastError = undefined
  writeSchedules(list)
}

/** 立即执行（行上「立即执行一次」）：成功/失败都把结果回写清单 */
export async function runScheduleNow(id: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const task = readSchedules().find((x) => x.id === id)
  if (!task) return { ok: false, error: '任务不存在' }
  if (runningTaskIds.has(id)) return { ok: false, error: '任务正在执行' }
  runningTaskIds.add(id)
  try {
    if (!(await adapter.isHealthy())) return { ok: false, error: '内核未启动，无法执行' }
    const list = readSchedules()
    const claimed = list.find((x) => x.id === id)
    if (!claimed) return { ok: false, error: '任务不存在' }
    claimSchedule(list, claimed)
    const res = await runTask(claimed)
    writeRunResult(id, res)
    if (res.sessionId) onRan?.({ taskId: id, sessionId: res.sessionId, name: claimed.name })
    return res.error ? { ok: false, error: res.error, sessionId: res.sessionId } : { ok: true, sessionId: res.sessionId }
  } finally {
    runningTaskIds.delete(id)
  }
}

/** 一轮 tick：到点的执行，错过的（过期超三个 tick）不补、推进周期 */
async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    if (!(await adapter.isHealthy())) return // 内核没起来：本轮全跳过，等下一轮（nextRun 不动）
    const list = readSchedules()
    const now = Date.now()
    for (const task of list) {
      if (!task.enabled || task.nextRun > now || runningTaskIds.has(task.id)) continue
      runningTaskIds.add(task.id)
      try {
        // 到点（或 tick 抖动内）：先领取本轮，再执行。错过的在 readSchedules 归一化时已推进过，不会落在这里补跑。
        claimSchedule(list, task)
        const res = await runTask(task)
        writeRunResult(task.id, res)
        if (res.sessionId) onRan?.({ taskId: task.id, sessionId: res.sessionId, name: task.name })
      } finally {
        runningTaskIds.delete(task.id)
      }
    }
  } finally {
    ticking = false
  }
}

export function startScheduler(ws: string, notify: (r: ScheduleRan) => void): void {
  workspace = ws
  onRan = notify
  if (!timer) {
    timer = setInterval(() => {
      void tick()
    }, TICK_MS)
    void tick()
  }
}

let timer: NodeJS.Timeout | null = null
