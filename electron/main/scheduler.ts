/**
 * 计划任务调度器（主进程）。
 *
 * 左侧栏「计划任务」区块的数据与触发都在这里：数据落 ~/.qingniaoai/schedules.json，
 * 到点（30 秒一跳的 tick）在内置「任务」目录新建一个内核会话并发送 prompt——
 * 复用渲染层同一条 REST 链路（adapter.api，model 不传自动回落默认档），
 * 会话随即出现在左栏任务列表里，点「计划任务」行可跳回看结果。
 *
 * 进程关窗后驻留托盘（win:close 只隐藏窗口），调度器照跑。
 *
 * **错过执行时刻**（电脑关机、应用没开）后的补跑语义：
 *  - 任务开着 `catchUp`（默认）且错过未超过 CATCHUP_WINDOW（24h）→ 读盘时保留过期的
 *    nextRun 原值，启动后第一轮 tick 就把它补跑掉，会话标题带 `[补跑]` 与原定时刻；
 *  - 错过更久、或任务关了 catchUp → 读盘时把 nextRun 推进到下个周期，本次不补。
 * 无论哪种都**只补最近那一次**（连续错过多次也只跑一遍，不连环发会话），
 * 且补跑后 nextRun 直接落到未来，不会再立刻触发第二次。
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
 * 「刚过点」判据：nextRun 过期超过 3 个 tick 才认为当时应用没在跑（而不是正常 tick 抖动）。
 * 窗口内的保留 nextRun 原值，交给 tick 正常触发。
 */
const STALE_MS = 3 * TICK_MS
/**
 * 补跑窗口：错过执行时刻超过这么久就不再补，直接推进到下个周期。
 *
 * 24 小时是权衡出来的：只覆盖「电脑睡一觉 / 忘开机」这种最常见的场景；
 * 关机越久，那个时刻的数据越陈，补跑只会让 AI 拿着新数据编旧报告。
 */
const CATCHUP_WINDOW = 24 * HOUR_MS
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

/** 单条归一化：缺字段补默认；过期的 nextRun 按 catchUp 与补跑窗口决定「留着补跑」还是「推进到下个周期」 */
function normalizeTask(x: unknown): ScheduleTask | null {
  const t = x as Partial<ScheduleTask> | null
  if (!t || typeof t.id !== 'string' || !t.id.trim()) return null
  if (typeof t.name !== 'string' || typeof t.prompt !== 'string') return null
  const spec = t.spec as unknown
  if (!isValidSpec(spec)) return null
  const now = Date.now()
  const lastRun = Number(t.lastRun) > 0 ? Number(t.lastRun) : undefined
  const nextRun = Number(t.nextRun) > 0 ? Number(t.nextRun) : 0
  // 缺省视为开：老存档没这个键，不该因为「没记录过」就一律不补
  const catchUp = t.catchUp !== false
  // 刚过点（tick 抖动内）一律留着；错过较久则看 catchUp 与窗口
  const keepForCatchUp = catchUp && nextRun > 0 && nextRun <= now - STALE_MS && nextRun >= now - CATCHUP_WINDOW
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    spec,
    enabled: t.enabled !== false,
    createdAt: Number(t.createdAt) > 0 ? Number(t.createdAt) : now,
    order: Number.isFinite(Number(t.order)) ? Number(t.order) : 0,
    nextRun: nextRun > now - STALE_MS || keepForCatchUp ? nextRun : nextRunAfter(spec, now, lastRun),
    catchUp,
    ...(lastRun ? { lastRun } : {}),
    ...(typeof t.lastSession === 'string' ? { lastSession: t.lastSession } : {}),
    ...(typeof t.lastError === 'string' && t.lastError ? { lastError: t.lastError } : {})
  }
}

/** 读全量清单：旧数据没有 order 时按创建时间倒序初始化；文件缺失/损坏按空列表处理 */
export function readSchedules(): ScheduleTask[] {
  try {
    if (!existsSync(schedulesPath())) return []
    const raw = JSON.parse(readFileSync(schedulesPath(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    const hasOrder = raw.every((x) => {
      const t = x as Partial<ScheduleTask> | null
      return !!t && typeof t.order === 'number' && Number.isFinite(t.order)
    })
    return raw
      .map(normalizeTask)
      .filter((t): t is ScheduleTask => !!t)
      .sort((a, b) => (hasOrder ? a.order - b.order : b.createdAt - a.createdAt))
      .map((t, order) => ({ ...t, order }))
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

/** spec 拍平成可比对的元组（判「用户只是改了个名字」还是「真的改了周期」用） */
function specKey(s: ScheduleSpec): string {
  if (s.kind === 'hourly') return `hourly:${s.everyHours}`
  if (s.kind === 'daily') return `daily:${s.hour}:${s.minute}`
  return `weekly:${s.day}:${s.hour}:${s.minute}`
}
function sameSpec(a: ScheduleSpec, b: ScheduleSpec): boolean {
  return specKey(a) === specKey(b)
}

/**
 * 新建：补 createdAt / nextRun；
 * 编辑：保留执行历史（lastRun/lastSession/lastError），按新 spec 重算 nextRun ——
 * **但周期没改时，要把还等着补跑的那一次留住**。
 *
 * 为什么不能一律重算（2026-09-29 实测踩到）：应用在 08:00 启动、正准备补跑 07:00 那一次，
 * 用户在这 15 秒内进表单改了个名字点了保存，`nextRunAfter(spec, now)` 就把它推到明天，
 * 补跑被一次改名静默吃掉。周期真的改了（7:00 → 9:00）则该丢掉旧时刻：新周期从现在起生效。
 */
export function upsertSchedule(t: ScheduleTask): ScheduleTask[] {
  const norm = normalizeTask(t)
  if (!norm) throw new Error('计划任务数据不合法')
  const now = Date.now()
  const list = readSchedules()
  const old = list.find((x) => x.id === norm.id)
  if (old) {
    norm.createdAt = old.createdAt
    norm.order = old.order
    norm.lastRun = old.lastRun
    norm.lastSession = old.lastSession
    norm.lastError = old.lastError
    // old 已被 readSchedules 归一化过：待补跑的那一次原样留在 old.nextRun 上
    const pending = old.nextRun <= now - STALE_MS && sameSpec(old.spec, norm.spec) && norm.catchUp
    norm.nextRun = pending ? old.nextRun : nextRunAfter(norm.spec, now, old.lastRun)
    list.splice(list.indexOf(old), 1, norm)
  } else {
    norm.createdAt = now
    norm.order = list.length ? Math.min(...list.map((x) => x.order)) - 1 : 0
    norm.nextRun = nextRunAfter(norm.spec, now, now)
    list.unshift(norm)
  }
  writeSchedules(list)
  return list
}

export function removeSchedule(id: string): ScheduleTask[] {
  const list = readSchedules().filter((x) => x.id !== id)
  writeSchedules(list)
  return list
}

/** 拖拽排序：接收完整有序任务 id，落盘前重新压紧 order */
export function reorderSchedules(ids: string[]): ScheduleTask[] {
  const list = readSchedules()
  if (ids.length !== list.length || new Set(ids).size !== ids.length || ids.some((id) => !list.some((x) => x.id === id))) {
    return list
  }
  const byId = new Map(list.map((x) => [x.id, x]))
  const next = ids.map((id, order) => ({ ...byId.get(id)!, order }))
  writeSchedules(next)
  return next
}

/** 会话标题：正常到点是「[计划] 名」，补跑带「[补跑]」与原定时刻 —— 否则用户看到早上 8 点
 *  执行了一条「5 点的日报」会以为定时错了；原定时刻也得写进去，才好判断补的是哪一次 */
function sessionTitle(task: ScheduleTask, catchUpAt?: number): string {
  if (!catchUpAt) return '[计划] ' + task.name
  return '[补跑] ' + task.name + '（原定 ' + fmtLocal(catchUpAt) + '）'
}

const p2 = (n: number): string => String(n).padStart(2, '0')
/** 本地时间 YYYY-MM-DD HH:mm */
function fmtLocal(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 执行一次：建会话 + 异步发送 prompt；内核受理后立即返回，不等待本轮对话完成 */
async function runTask(task: ScheduleTask, catchUpAt?: number): Promise<{ sessionId?: string; error?: string }> {
  if (!workspace) return { error: '执行目录未初始化' }
  const qs = '?directory=' + encodeURIComponent(workspace)
  const r1 = await adapter.api('/session' + qs, 'POST', { title: sessionTitle(task, catchUpAt) })
  if (r1.status >= 400) return { error: String(r1.data ?? '创建会话失败') }
  const sid = (r1.data as { id?: string } | null)?.id
  if (!sid) return { error: '创建会话未返回 id' }
  const r2 = await adapter.api('/session/' + sid + '/prompt_async' + qs, 'POST', {
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

/** 一轮 tick：到点的执行；错过未超窗口且任务开着 catchUp 的补跑一次（标题与通知都带「补跑」） */
async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    if (!(await adapter.isHealthy())) return // 内核没起来：本轮全跳过，等下一轮（nextRun 不动）
    const now = Date.now()
    const dueIds = readSchedules()
      .filter((task) => task.enabled && task.nextRun <= now && !runningTaskIds.has(task.id))
      .map((task) => task.id)
    for (const id of dueIds) {
      // 每个任务领取前重读：前一个任务执行期间可能发生拖拽、编辑或删除，不能拿轮次开始时的旧快照回写。
      const list = readSchedules()
      const task = list.find((x) => x.id === id)
      if (!task || !task.enabled || task.nextRun > now || runningTaskIds.has(task.id)) continue
      // 过期超过三个 tick = 当时应用没在跑。补跑的话这次就是补那一轮；
      // 不补的话 readSchedules 归一化时已把 nextRun 推进到下个周期，落不到这里。
      const missed = task.nextRun < now - STALE_MS
      runningTaskIds.add(task.id)
      try {
        // 先领取本轮（nextRun 推到未来）再执行：保证补跑不会立刻再触发第二次，
        // 执行中崩溃也不会重复创建同一轮会话。
        const dueAt = task.nextRun
        claimSchedule(list, task)
        const res = await runTask(task, missed ? dueAt : undefined)
        writeRunResult(id, res)
        if (res.sessionId)
          onRan?.({
            taskId: id,
            sessionId: res.sessionId,
            name: task.name,
            ...(missed ? { catchUp: { at: dueAt } } : {})
          })
      } finally {
        runningTaskIds.delete(task.id)
      }
    }
  } finally {
    ticking = false
  }
}

/** 还有到点 / 待补跑的任务没处理吗（决定启动期还要不要继续等内核） */
function hasPending(): boolean {
  const now = Date.now()
  return readSchedules().some((t) => t.enabled && t.nextRun <= now)
}

/**
 * 开机补跑要「打开应用就跑」，不能干等一个 tick 周期。
 *
 * 内核是 startScheduler 之前才刚 spawn 的，第一次 tick 撞上 `isHealthy() === false`
 * 会整轮跳过（nextRun 不动），于是一次补跑要等满 30 秒才发生。这里加一条短间隔重试阶梯：
 * 还有待办就每 2 秒再试一次，最多约 16 秒；处理完（nextRun 已推到未来）立刻收手。
 * 与定时 tick 共用 tick() 自身的 ticking 锁与 per-task 锁，不会重复创建会话。
 */
async function catchUpOnStart(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tick()
    if (!hasPending()) return
    await new Promise((r) => setTimeout(r, 2000))
  }
}

export function startScheduler(ws: string, notify: (r: ScheduleRan) => void): void {
  workspace = ws
  onRan = notify
  if (!timer) {
    timer = setInterval(() => {
      void tick()
    }, TICK_MS)
    void catchUpOnStart()
  }
}

let timer: NodeJS.Timeout | null = null
