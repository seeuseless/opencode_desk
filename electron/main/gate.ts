/**
 * 「AI 调用其他模型」授权闸门 —— 主进程侧。
 *
 * 背景在 resources/mcp/gate.mjs 的文件头写着，这里只记主进程这一半的职责：
 * MCP 在真正调模型前 POST /qn/authorize 过来，本模块决定「这次要不要问用户」，
 * 要问就**把那个 HTTP 请求挂起**，推一张卡到界面，用户答完再解开。
 *
 * 授权分三层，粒度都比「应用级开关」细：
 *   1. 本次调用（once）   —— 只放行这一下，下一次同类调用还会问
 *   2. 本次会话（session） —— 本次应用运行内不再问（内存，重启即失效）
 *   3. 永久（always）      —— 写进 settings.modelAuth，重启仍在
 * 键是 `角色|provider/model`：同一张脸换个角色（如 glm 既当识图又当生图）会分别问一次，
 * 因为那是两种不同能力、不同费用；而「桌面截图代看」和「describe_image 识图」是同一件事，
 * 归一成同一个键，不必问两遍。
 *
 * **与访问权限档位完全无关**：access 管「能不能改文件/执行命令」，这里管「能不能多调一个模型」。
 * 完全控制档下照样会问——这是产品明确要求。
 */

import { loadSettings, saveSettings } from './config'
import type { ModelAuthAsk, ModelAuthReq, ModelAuthScope, ModelUsed } from './types'

// 数据形状（ModelAuthAsk / ModelUsed / ...）定义在 types.ts：渲染层要用同一份，
// 而渲染层不能 import 主进程模块，所以类型必须住在共享的 types.ts 里。
export type { ModelAuthAsk, ModelAuthReq, ModelAuthScope, ModelRole, ModelUsed } from './types'

/** 一次授权询问最多等用户多久，按角色分开——上限被该角色的 MCP 工具超时卡着 */
const ASK_CAP_MS: Record<string, number> = {
  // 桌面截图那条路最紧：MCP 工具超时只有 30s，内部预算 25s，等不起
  vision: 20000,
  // 生图/生视频/配音/音乐/听写：都是长任务，MCP 超时 120s~600s，可以等用户慢慢看
  image: 90000,
  video: 90000,
  tts: 90000,
  music: 90000,
  asr: 90000
}
const DEFAULT_CAP_MS = 60000

/**
 * 角色归一：桌面截图的视觉代看与 describe_image 识图是**同一个能力**（拿另一个模型看图），
 * 合成一个键，用户在桌面里批准过一次，识图就不必再问一遍。
 */
function normRole(role: string): string {
  return role === 'screen' ? 'vision' : role
}

function grantKey(role: string, id: string): string {
  return normRole(role) + '|' + id
}

// ---------- 状态 ----------

/** 本次应用运行内的授权（session 档） */
const sessionGrants = new Set<string>()
/** 正在等用户作答的请求：reqId → 等待信息 */
const waiting = new Map<
  string,
  { key: string; ask: ModelAuthAsk; resolve: (r: { allowed: boolean; scope?: string; reason?: string }) => void; timer: NodeJS.Timeout }
>()
/** 同一个键被并发询问时，后到的请求搭同一趟车：reqId → 其余等待者 */
const waiters = new Map<string, ((r: { allowed: boolean; scope?: string; reason?: string }) => void)[]>()
/** 调成功过的模型（本轮汇总用，界面自己按回合切分，这里只负责广播 + 留最近若干条） */
const used: ModelUsed[] = []
let usedSeq = 0

/** 推事件给渲染层（index.ts 注入，避免本模块直接依赖 BrowserWindow） */
let sink: ((channel: string, payload: unknown) => void) | null = null
export function setModelAuthSink(fn: (channel: string, payload: unknown) => void): void {
  sink = fn
}

function emit(channel: string, payload: unknown): void {
  try {
    sink?.(channel, payload)
  } catch {
    /* 窗口已销毁等：授权流程不能因为推送失败而卡住，HTTP 那侧仍会等到超时并拒绝 */
  }
}

// ---------- 判定 ----------

/** 是否已获授权（会话级或永久级） */
export function isModelGranted(role: string, id: string): boolean {
  const key = grantKey(role, id)
  if (sessionGrants.has(key)) return true
  return loadSettings().modelAuth.includes(key)
}

/** 把一次授权落进对应的层 */
function remember(role: string, id: string, scope: ModelAuthScope): void {
  const key = grantKey(role, id)
  if (scope === 'session') sessionGrants.add(key)
  if (scope === 'always') {
    const s = loadSettings()
    if (!s.modelAuth.includes(key)) saveSettings({ ...s, modelAuth: [...s.modelAuth, key] })
  }
}

/** 撤销授权：key 省略＝清空全部（会话级与永久级一起）；返回撤销后的永久清单 */
export function revokeModelAuth(key?: string): string[] {
  const s = loadSettings()
  if (!key) {
    sessionGrants.clear()
    if (s.modelAuth.length) saveSettings({ ...s, modelAuth: [] })
    return []
  }
  sessionGrants.delete(key)
  // 角色归一后同键一并删：界面展示的是归一后的键，但老存档里可能存的是归一前的写法
  const [rawRole, rawId] = String(key).split('|')
  const norm = rawRole ? grantKey(rawRole, rawId ?? '') : key
  const next = s.modelAuth.filter((k) => k !== key && k !== norm)
  if (next.length !== s.modelAuth.length) saveSettings({ ...s, modelAuth: next })
  return next
}

/** 当前永久授权清单（设置界面展示 / 撤销用） */
export function modelAuthList(): string[] {
  return loadSettings().modelAuth
}

/**
 * 请求一次授权。已授权立即返回；未授权则推卡并挂起，直到用户作答或超时。
 * 同一个键同时来多个请求时**合并成一次询问**——桌面控制可能在一轮里并发好几处取画面，
 * 弹一堆一模一样的卡是灾难。
 */
export function requestModelAuth(req: ModelAuthReq): Promise<{ allowed: boolean; scope?: string; reason?: string }> {
  const role = normRole(String(req?.role ?? 'other'))
  const id = String(req?.id ?? '').trim()
  if (!id) return Promise.resolve({ allowed: true, scope: 'no-target' })
  if (isModelGranted(role, id)) return Promise.resolve({ allowed: true, scope: 'granted' })

  const key = grantKey(role, id)
  // 已经有同键的询问在等 → 搭同一趟车，别再弹第二张一模一样的卡
  for (const w of waiting.values()) {
    if (w.key !== key) continue
    return new Promise((resolve) => {
      const list = waiters.get(w.ask.reqId)
      if (list) list.push(resolve)
      else resolve({ allowed: true, scope: 'unknown' })
    })
  }

  const reqId = `ma_${Date.now().toString(36)}_${(usedSeq++).toString(36)}`
  const ask: ModelAuthAsk = {
    reqId,
    role,
    id,
    label: String(req?.label ?? '').trim() || id,
    provider: String(req?.provider ?? '').trim(),
    at: Date.now()
  }
  const cap = ASK_CAP_MS[normRole(role)] ?? DEFAULT_CAP_MS
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(reqId, { allowed: false, reason: 'timeout' }), cap)
    timer.unref?.()
    waiting.set(reqId, { key, ask, resolve, timer })
    waiters.set(reqId, [])
    emit('modelauth:ask', ask)
  })
}

function finish(reqId: string, result: { allowed: boolean; scope?: string; reason?: string }): void {
  const w = waiting.get(reqId)
  const extra = waiters.get(reqId) ?? []
  waiting.delete(reqId)
  waiters.delete(reqId)
  if (w) {
    clearTimeout(w.timer)
    w.resolve(result)
  }
  for (const r of extra) r(result)
}

/** 用户在界面上作答 */
export function replyModelAuth(reqId: string, scope: ModelAuthScope): boolean {
  const w = waiting.get(String(reqId))
  if (!w) return false
  if (scope === 'reject') {
    finish(w.ask.reqId, { allowed: false, reason: 'rejected' })
    return true
  }
  remember(w.ask.role, w.ask.id, scope)
  finish(w.ask.reqId, { allowed: true, scope: scope === 'once' ? 'once' : 'granted' })
  return true
}

/** 程序退出 / 重置时把挂起的请求全部拒掉，别让 MCP 收到「允许」 */
export function rejectAllPending(): void {
  for (const reqId of [...waiting.keys()]) finish(reqId, { allowed: false, reason: 'rejected' })
}

// ---------- 用量 ----------

/** 记一条「某模型真的被调用了」，供界面按回合汇总 */
export function noteModelUsed(req: ModelAuthReq): void {
  const id = String(req?.id ?? '').trim()
  if (!id) return
  const rec: ModelUsed = {
    role: normRole(String(req?.role ?? 'other')),
    id,
    label: String(req?.label ?? '').trim() || id,
    provider: String(req?.provider ?? '').trim(),
    at: Date.now()
  }
  used.push(rec)
  if (used.length > 200) used.splice(0, used.length - 200)
  emit('modelauth:used', rec)
}

/** 本地控制端点的 `/qn/*` 路由（index.ts 调） */
export async function handleGate(path: string, body: Record<string, unknown>): Promise<unknown> {
  if (path === 'authorize') return requestModelAuth(body as ModelAuthReq)
  if (path === 'model-used') {
    noteModelUsed(body as ModelAuthReq)
    return { ok: true }
  }
  if (path === 'modelauth-list') return { items: modelAuthList() }
  if (path === 'modelauth-revoke') return { items: revokeModelAuth(typeof body.key === 'string' ? body.key : undefined) }
  throw new Error('未知闸门操作：' + path)
}
