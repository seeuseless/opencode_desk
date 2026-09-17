import { useEffect, useRef, useState, type ReactNode } from 'react'
import hljs from 'highlight.js/lib/common'
import {
  AlertCircle, ArrowDown, Brain, Bot, Check, ChevronDown, ChevronRight, Copy, FileDiff as FileDiffIcon, FilePlus, FileText,
  Folder, Globe, HelpCircle, ListChecks, LoaderCircle, Pencil, RotateCw, Search, Send, Sparkles,
  Square, Terminal, Trash2, Wrench, X
} from 'lucide-react'
import { oc, MEMORY_PREFIX, type FileDiff, type MessageView, type ModelSel, type Part, type PtySession, type QuestionAsk, type Session } from '../oc'
import type { ProviderCfg } from '../../../electron/main/types'
import { ModelPicker, type ModelGroup } from './ModelPicker'
import { ProjectPicker } from './ProjectPicker'
import { Modal } from './Modal'
import { Markdown } from './Markdown'
import type { Project } from './Sidebar'

interface Props {
  project?: Project
  projects: Project[]
  sessionId: string
  model: string
  onModelChange: (key: string) => void
  settings: ProviderCfg[]
  /** 设置已加载完成（区分"提供商还没加载"与"真的没有提供商"，防止启动时清掉存档模型） */
  settingsReady: boolean
  /** 草稿首发：内核会话此刻才创建 */
  onDraftCreated: (s: Session) => void
  onRefreshSessions: () => void
  /** 上报某会话的处理中状态（多任务并行互不覆盖），侧栏任务行据此显示/移除加载图标 */
  onBusy: (sid: string, running: boolean) => void
  /** 自增信号：点 + / 点任务时自动聚焦输入框 */
  focusSignal: number
  /** 跳转到设置页（配置模型） */
  onOpenSettings?: () => void
  /** 点击左端项目文件夹：弹出系统选目录对话框 */
  onPickDir: () => void
  /** 切换当前激活项目（点击左侧项目下拉中的某项） */
  onSwitchProject: (id: string) => void
}

/** 'pid/mid' → ModelSel；'' → 跟随内核默认 */
function parseModel(key: string): ModelSel | undefined {
  if (!key) return undefined
  const i = key.indexOf('/')
  return { providerID: key.slice(0, i), modelID: key.slice(i + 1) }
}

/** 任务被中断后的自动重试：间隔 10 秒，最多 10 次；耗尽后交给界面上的手动重试按钮 */
const RETRY_INTERVAL_MS = 10000
const RETRY_MAX = 10
/** 自动重试提示文案：续跑上一轮的半截任务，不必重复原文 */
const RETRY_CONTINUE = '继续'

/** 会话中断的识别：助手消息自带错误，或回合结束时还残留 running/pending 的工具调用（半截截断）。
 *  关键修正：助手消息已有有效文本产出 → 视为回合正常完成，不算中断；
 *  否则「写 Java 示例」这类纯文本回复（即便有残留 tool part）会被误判为中断，触发不该触发的自动续跑。 */
function isAbortedAssistant(m: MessageView): boolean {
  const err = (m.info as unknown as { error?: { name?: string } }).error
  if (err) return err.name !== 'MessageAbortedError'
  // 已有正文产出 = 该轮有效完成；残留的 running/pending tool part 属工具未跑完，不是回合被截断
  if (m.parts.some((x) => x.type === 'text' && (x.text ?? '').length > 0)) return false
  return m.parts.some((x) => x.type === 'tool' && (x.state?.status === 'running' || x.state?.status === 'pending'))
}

/** 内核工具名 → 是否会改文件（决定要不要拉差量展示 +N/-M） */
function isFileTool(tool: string): boolean {
  const t = tool.toLowerCase()
  return t === 'write' || t === 'edit' || t === 'patch' || t === 'apply_patch'
}

/** 工具入参里的目标文件（write/edit 带 filePath，patch 带 files） */
function toolFiles(part: Part): string[] {
  const inp = part.state?.input ?? {}
  const out: string[] = []
  for (const k of ['filePath', 'path', 'file']) if (typeof inp[k] === 'string') out.push(inp[k] as string)
  if (Array.isArray(inp.files)) for (const f of inp.files) if (typeof f === 'string') out.push(f as string)
  return out
}

/** 路径归一化：统一分隔符与小写，用于差量与工具入参匹配 */
function normPath(s: string): string {
  return s.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/** 从整轮差量里挑出这个工具改到的文件；只有一条差量时直接兜底，否则必须路径匹配得上 */
function matchedDiff(diffs: FileDiff[] | undefined, part: Part): FileDiff | undefined {
  if (!diffs || diffs.length === 0) return undefined
  if (diffs.length === 1) return diffs[0]
  const files = toolFiles(part).map(normPath)
  if (!files.length) return undefined
  return diffs.find((d) => files.includes(normPath(d.file)))
}

/** 从工具自身的 state.metadata 取该工具的差量：edit 存 filediff={file,patch,+,−}，
 *  apply_patch/write 存 files[]=[{file|filePath|relativePath, patch, additions, deletions}]。
 *  这是内核随工具一起给的结构化结果，最可靠，不依赖 session 的差量计算。 */
function metaDiffs(part: Part): FileDiff[] {
  const md = part.state?.metadata
  if (!md) return []
  const out: FileDiff[] = []
  const fd = md.filediff as FileDiff | undefined
  if (fd && typeof fd.file === 'string' && typeof fd.patch === 'string') out.push(fd)
  if (Array.isArray(md.files)) {
    for (const f of md.files) {
      const o = f as Record<string, unknown>
      const file =
        typeof o.file === 'string' ? o.file
        : typeof o.filePath === 'string' ? o.filePath
        : typeof o.relativePath === 'string' ? o.relativePath
        : ''
      if (!file) continue
      out.push({
        file,
        patch: typeof o.patch === 'string' ? o.patch : '',
        additions: typeof o.additions === 'number' ? o.additions : 0,
        deletions: typeof o.deletions === 'number' ? o.deletions : 0
      })
    }
  }
  return out
}

/** 助手消息 → 所属用户消息 id：内核把整轮差量挂在用户消息上，拉差量必须用用户消息 id */
function turnOwners(list: MessageView[]): Map<string, string> {
  const m = new Map<string, string>()
  let cur = ''
  for (const x of list) {
    if (x.info.role === 'user') cur = x.info.id
    else if (cur) m.set(x.info.id, cur)
  }
  return m
}

/** 重试时该发什么：上一轮没有任何产出就重发原文，有产出就发「继续」让模型从断点接着做 */
function continuationText(list: MessageView[]): string {
  const lastUser = [...list].reverse().find((m) => m.info.role === 'user')
  const lastAsst = [...list].reverse().find((m) => m.info.role === 'assistant')
  const text = lastUser
    ? lastUser.parts.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n').trim()
    : ''
  if (!text) return ''
  return lastAsst && lastAsst.parts.length ? RETRY_CONTINUE : text
}

/** 内核 todo 清单项（opencode todo.updated 事件） */
interface TodoItem {
  content: string
  status: string
  priority?: string
}

/** 上游错误 → 一句人话（错误条展示，不 dump 原始 JSON） */
function humanizeError(raw: string): string {
  if (/insufficient[_ ]credit|quota|balance|arrears|exceeded your current/i.test(raw)) return '账户额度不足或已欠费，请检查该提供商的余额。'
  if (/invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication/i.test(raw)) return 'API Key 无效或未通过认证，请到设置里检查该提供商的密钥。'
  if (/rate[_ ]?limit|too many requests|429/i.test(raw)) return '请求过于频繁，已被限流，请稍候片刻再试。'
  if (/model[_ ]not[_ ]found|does not exist|unknown model|unsupported model|provider.{0,20}not found/i.test(raw)) return '请求的模型在该端点不存在或不可用，请更换模型。'
  if (/timeout|timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(raw)) return '无法连接模型端点，请检查 Base URL 与网络。'
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw
}

export function ChatView(p: Props) {
  const [msgs, setMsgs] = useState<MessageView[]>([])
  const [input, setInput] = useState('')
  /** 处理中的会话集合：可能多任务并行（A 在跑，切去 B 又发一轮），每个会话独立记账 */
  const [busySet, setBusySet] = useState<Record<string, boolean>>({})
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  /** 队列项记录发起时的会话：消费时回原会话执行，不跟当前视图走 */
  const [queue, setQueue] = useState<{ sid: string; text: string }[]>([])
  const [qCollapsed, setQCollapsed] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)

  const dirRef = useRef<string | undefined>(p.project?.path)
  const sidRef = useRef(p.sessionId)
  const texts = useRef<Map<string, string>>(new Map())
  const toolRaw = useRef<Map<string, string>>(new Map())
  const roles = useRef<Map<string, 'user' | 'assistant'>>(new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 本轮发送前已存在的消息 id：用于判断本轮是否已开始产出
  const turnBase = useRef<Set<string>>(new Set())
  // 正在执行的 prompt：断网时自动暂停，网络恢复后自动重发（sid + 原文）
  const inflight = useRef<{ sid: string; text: string } | null>(null)
  // 已发送消息的历史：Ctrl+Z 逐条回看、Ctrl+Y 前进；histPos == length 表示在草稿态
  const hist = useRef<string[]>([])
  const histPos = useRef(0)
  const draftRef = useRef('')
  // 打字机：partID → 已吐出的字符数；ticker 定时器；被插队的队列项下标
  const shown = useRef<Map<string, number>>(new Map())
  const ticker = useRef<number | null>(null)
  const hijack = useRef<number | null>(null)
  // 草稿首发创建的会话：跳过一次历史重载，避免闪掉乐观插入的用户消息
  const justCreated = useRef('')
  // 写入/编辑进行中的内容预览（partID → 已流出的文件内容）
  const [previews, setPreviews] = useState<Record<string, string>>({})
  // 本轮开发任务清单（todo.write / todo.updated 事件驱动，完成项中划线）
  const [todos, setTodos] = useState<TodoItem[]>([])
  // 内核 question 工具的待答问题（事件 + busy 轮询双通道，阻塞等待用户应答）
  const [asks, setAsks] = useState<QuestionAsk[]>([])
  // 内核管理的终端（pty）：有 running 的才在项目名旁显示入口
  const [terms, setTerms] = useState<PtySession[]>([])
  const [showTerms, setShowTerms] = useState(false)
  const asksRef = useRef<QuestionAsk[]>([])
  asksRef.current = asks
  /** 正在提交应答的请求 id：轮询对账时跳过，防止卡片闪回 */
  const replyingRef = useRef<Set<string>>(new Set())
  // bash 类工具的起始计时：长跑超 30s 视为「终端运行中」，不算处理中
  const termStart = useRef<Record<string, number>>({})
  // 轮询兜底指纹：当前会话已渲染的消息+part 长度，无变化则跳过 setState，避免每轮无谓渲染
  const pollFingerprint = useRef('')
  // 各 busy 会话所属项目路径：多项目并行时停止/重试都要带 directory，否则内核找不到该会话
  const busyDir = useRef<Record<string, string | undefined>>({})
  // 已拉到的整轮文件差量：用户消息 id → 差量列表（工具行据此显示 +N/-M，展开显示差量代码）
  const [diffs, setDiffs] = useState<Record<string, FileDiff[]>>({})
  const diffsBusy = useRef<Set<string>>(new Set())
  // 中断自动重试登记表：sid → { 重试次数, 定时器 }；无定时器 = 次数耗尽，等用户手动点重试
  const retries = useRef<Map<string, { count: number; timer?: number }>>(new Map())
  // 重试状态在 ref 里，同步成 state 供渲染（pending=有定时器待执行；无定时器=次数耗尽）
  const [retryView, setRetryView] = useState<Record<string, { count: number; pending: boolean }>>({})
  function syncRetryView() {
    const v: Record<string, { count: number; pending: boolean }> = {}
    retries.current.forEach((r, k) => { v[k] = { count: r.count, pending: r.timer != null } })
    setRetryView(v)
  }

  dirRef.current = p.project?.path
  sidRef.current = p.sessionId

  /** 当前查看的会话是否在处理中——别的会话在跑时，这里必须是 false（不显示思考、不排队） */
  const busy = p.sessionId !== '' && !!busySet[p.sessionId]
  /** 任意会话在处理中 → 显示停止按钮，可一键停掉所有并行任务（不只是当前会话） */
  const anyBusy = Object.keys(busySet).some((s) => busySet[s])
  /** 当前会话的自动重试状态（pending=等待下一次重试；无定时器=次数耗尽等手动重试） */
  const retryState = p.sessionId ? retryView[p.sessionId] : undefined
  /** 助手消息 → 所属用户消息 id（差量按用户消息拉，这里做渲染期的映射） */
  const turnOwner = turnOwners(msgs)
  // 最新一条助手消息：只有它身上的 running 工具是"真在跑"；更早轮次的残留 running 按中断展示，
  // 否则发新消息后旧轮还挂着加载动画、新轮又在思考，两轮状态混在一起
  const lastAid = [...msgs].reverse().find((m) => m.info.role === 'assistant')?.info.id
  // 终端长跑：本轮最新运行中的工具是终端且持续 30s 以上 → 任务卡在终端上，不再算「处理中」，
  // 新消息发送将中止当前轮并接管
  let terminalBlocked = false
  if (busy && lastAid) {
    const m = msgs.find((x) => x.info.id === lastAid)
    const runTool = m?.parts.find((x) => x.type === 'tool' && x.state?.status === 'running')
    const tname = (runTool?.tool ?? '').toLowerCase()
    if (runTool && (tname === 'bash' || tname === 'shell' || tname === 'execute')) {
      const t0 = termStart.current[runTool.id] ?? (termStart.current[runTool.id] = Date.now())
      terminalBlocked = Date.now() - t0 > 30000
    }
  } else if (Object.keys(termStart.current).length) {
    termStart.current = {}
  }

  /** busySet 的同步镜像 + 修改入口：事件回调（effect 只注册一次）里要用最新值 */
  const busySetRef = useRef<Record<string, boolean>>({})
  /** 同理，onBusy prop 取最新引用，防事件闭包用到旧函数 */
  const onBusyRef = useRef(p.onBusy)
  onBusyRef.current = p.onBusy
  function markBusy(sid: string, running: boolean, dir?: string) {
    if (!sid) return
    const next = { ...busySetRef.current }
    if (running) {
      next[sid] = true
      // 记录会话所属项目：多项目并行时停止/重试必须带同一 directory，否则内核找不到该会话
      busyDir.current[sid] = dir ?? dirRef.current
    } else {
      delete next[sid]
    }
    busySetRef.current = next
    setBusySet(next)
    onBusyRef.current(sid, running)
  }
  const busySids = () => Object.keys(busySetRef.current).filter((s) => busySetRef.current[s])

  /** 取消某会话待执行的自动重试（用户自己发新消息/手动停止时，不再让旧任务续跑） */
  function cancelRetry(sid: string) {
    const r = retries.current.get(sid)
    if (!r) return
    if (r.timer != null) clearTimeout(r.timer)
    retries.current.delete(sid)
    syncRetryView()
  }

  /**
   * 任务被中断（回合报错 / 回合结束时残留半截工具调用 / 内核重启）后自动续跑：
   * 间隔 10 秒，最多 10 次；次数耗尽后不再自动重试，改由对话末尾的手动重试按钮交给用户。
   * 上一轮没有产出就重发原文，有产出就发「继续」让模型从断点接着做。
   */
  function scheduleRetry(sid: string, msgs?: MessageView[]) {
    if (!sid || navigator.onLine === false) return
    if (retries.current.get(sid)?.timer != null) return
    const dir = busyDir.current[sid] ?? (sid === sidRef.current ? dirRef.current : undefined)
    const start = (list: MessageView[]) => {
      const text = continuationText(list)
      if (!text) {
        retries.current.delete(sid)
        syncRetryView()
        return
      }
      if ((retries.current.get(sid)?.count ?? 0) >= RETRY_MAX) return
      retries.current.set(sid, {
        count: (retries.current.get(sid)?.count ?? 0) + 1,
        timer: window.setTimeout(() => {
          retries.current.delete(sid)
          syncRetryView()
          markBusy(sid, false)
          setError('')
          void runPrompt(text, sid, dir)
        }, RETRY_INTERVAL_MS)
      })
      syncRetryView()
    }
    if (msgs) return start(msgs)
    oc.messages(sid, dir).then(start).catch(() => {
      retries.current.delete(sid)
      syncRetryView()
    })
  }

  /** 重试次数耗尽后的手动重试：读回会话历史后直接续跑上一轮 */
  async function retryNow() {
    const sid = p.sessionId
    if (!sid) return
    const dir = busyDir.current[sid]
    let list = msgs
    if (sid !== sidRef.current) {
      try {
        list = await oc.messages(sid, dir)
      } catch {
        return
      }
    }
    const text = continuationText(list)
    if (!text) {
      setError('找不到可重试的内容')
      return
    }
    retries.current.delete(sid)
    syncRetryView()
    markBusy(sid, false)
    setError('')
    void runPrompt(text, sid, dir)
  }

  /** 编辑用户消息后重发：把会话撤回该条之前（移除旧回复），再用新文本触发 AI 重新回复 */
  async function resendMessage(uid: string, newText: string) {
    const sid = p.sessionId
    if (!sid) return
    const dir = busyDir.current[sid] ?? p.project?.path
    cancelRetry(sid)
    setError('')
    try {
      await oc.revert(sid, dir, uid)
    } catch (e) {
      const st = (e as Error & { status?: number }).status
      // 502/503 主进程代抛传输层故障，内核可能仍在跑，交给状态收尾
      if (st && st !== 502 && st !== 503) {
        setError(('撤回失败：' + (e instanceof Error ? e.message : String(e))).slice(0, 120))
        return
      }
    }
    // 撤回后历史已不含被编辑的那条（若有残留本地也剔除，避免新旧重复），再重发新文本
    try {
      texts.current.clear()
      shown.current.clear()
      const list = await oc.messages(sid, dir)
      setMsgs(hydrate(list.filter((m) => m.info.id !== uid), shown.current, texts.current))
    } catch { /* 保留现状，由重发接续 */ }
    void runPrompt(newText, sid, dir)
  }

  /** 停止全部任务：先清本地状态让界面立刻回落到可输入（不等内核回执），再向内核逐个中止 */
  async function stopAll() {
    for (const sid of busySids()) {
      const dir = busyDir.current[sid]
      cancelRetry(sid)
      markBusy(sid, false)
      delete busyDir.current[sid]
      oc.abort(sid, dir).catch((e) => {
        const st = (e as Error & { status?: number }).status
        // 502/503 是主进程代抛的传输层故障（内核仍在跑），不代表停止没送到
        if (!st || st === 502 || st === 503) return
        const msg = e instanceof Error ? e.message : String(e)
        setError('停止失败：' + msg.slice(0, 120))
      })
    }
    inflight.current = null
    setQueue([])
  }

  // 模型级联菜单：仅用户自建（启用）且配有模型的提供商，一级=提供商、二级=模型
  const groups: ModelGroup[] = p.settings
    .filter((x) => x.enabled && x.id && x.models.length)
    .map((c) => ({ id: c.id, label: c.name || c.id, models: c.models.map((m) => ({ mid: m })) }))

  // 无选中或选中已失效（提供商被停用/删除/模型被改）时，自动落到第一个可用模型。
  // 关键：设置尚未加载完成时绝不能跑校验——此刻 groups 为空，会把用户的存档值误判失效清掉。
  useEffect(() => {
    if (!p.settingsReady) return
    const i = p.model.indexOf('/')
    const valid =
      i > 0 && groups.some((g) => g.id === p.model.slice(0, i) && g.models.some((m) => m.mid === p.model.slice(i + 1)))
    if (!valid) p.onModelChange(groups[0] ? `${groups[0].id}/${groups[0].models[0].mid}` : '')
  }, [p.model, p.settings, p.settingsReady])

  // 切换项目/会话：先清旧内容再拉历史（项目切换瞬间 sessionId 为空）
  useEffect(() => {
    if (justCreated.current && justCreated.current === p.sessionId) {
      justCreated.current = ''
      return
    }
    texts.current.clear()
    toolRaw.current.clear()
    shown.current.clear()
    setPreviews({})
    setQueue([])
    setTodos([])
    setAsks([])
    if (!p.sessionId) {
      setMsgs([])
      setInput('')
      return
    }
    oc.messages(p.sessionId, p.project?.path)
      .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [p.sessionId, p.project?.path])

  // 订阅内核事件：token 级增量 + part 快照 + 会话空闲
  useEffect(() => {
    const off = window.qingniao.onEvent(async (raw) => {
      const e = raw as { type: string; properties: Record<string, unknown> }
      if (e.type === 'message.updated') {
        const info = e.properties.info as MessageView['info'] | undefined
        if (info) roles.current.set(info.id, info.role)
      } else if (e.type === 'message.part.delta') {
        const pr = e.properties as { sessionID: string; messageID: string; partID: string; field: string; delta: string }
        if (pr.sessionID !== sidRef.current) return
        if (pr.field === 'text' || pr.field === 'reasoning')
          setMsgs((prev) => appendDelta(prev, pr, texts.current, roles.current, shown.current, startTicker))
        else if (pr.field === 'input') {
          // 工具入参流：累积原始 JSON，抽取 content/command 做打字预览
          const rawStr = (toolRaw.current.get(pr.partID) ?? '') + pr.delta
          toolRaw.current.set(pr.partID, rawStr)
          const contentShown = extractToolContent(rawStr)
          if (contentShown) setPreviews((prev) => ({ ...prev, [pr.partID]: contentShown }))
        }
      } else if (e.type === 'message.part.updated') {
        const part = e.properties.part as Part
        if (part.sessionID !== sidRef.current) return
        if (part.type === 'tool' && part.state?.status !== 'running') {
          setPreviews((prev) => {
            if (!(part.id in prev)) return prev
            const next = { ...prev }
            delete next[part.id]
            return next
          })
        }
        setMsgs((prev) => applySnapshot(prev, part, texts.current, roles.current, shown.current, startTicker))
      } else if (e.type === 'todo.updated') {
        const pr = e.properties as { sessionID?: string; todos?: TodoItem[] }
        if (pr.sessionID !== sidRef.current) return
        setTodos(pr.todos ?? [])
      } else if (e.type === 'question.v2.asked') {
        const q = e.properties as unknown as QuestionAsk
        if (q && q.id && q.sessionID === sidRef.current) setAsks((prev) => [...prev.filter((x) => x.id !== q.id), q])
      } else if (e.type === 'question.v2.replied' || e.type === 'question.v2.rejected') {
        const pr = e.properties as { requestID?: string }
        setAsks((prev) => prev.filter((x) => x.id !== pr.requestID))
      } else if (e.type === 'session.idle') {
        const idleSid = (e.properties as { sessionID?: string }).sessionID
        if (!idleSid || !busySetRef.current[idleSid]) return
        // 处理中的会话空闲：无论用户是否切走都要清该会话的 busy（防切回时残留"正在思考"）
        markBusy(idleSid, false)
        const isCurrent = idleSid === sidRef.current
        oc.messages(idleSid, isCurrent ? dirRef.current : undefined)
          .then((list) => {
            // 回合结束但还残留半截工具调用（写入空转、断流截断）= 中断，自动续跑
            const last = list[list.length - 1]
            if (last && (last.info.role === 'user' || isAbortedAssistant(last))) scheduleRetry(idleSid, list)
            if (!isCurrent) return
            setTodos([])
            setMsgs(hydrate(list, shown.current, texts.current))
            p.onRefreshSessions()
          })
          .catch(() => { /* 事件流已展示内容 */ })
      } else if (e.type === 'qingniao.sse.reconnected') {
        // SSE 桥断线重连：断开期间可能漏掉 session.idle，busy 会话做一次轻量重同步
        for (const s of Object.keys(busySetRef.current)) {
          if (!s) continue
          oc.messages(s, s === sidRef.current ? dirRef.current : undefined)
            .then((list) => {
              // 该会话最后一条助手消息已有完整文本 → 视为已完成，清 busy
              const last = [...list].reverse().find((m) => m.info.role === 'assistant' && (m.parts.some((x) => x.type === 'text' && x.text)))
              if (last) markBusy(s, false)
              // 重连前任务被中断（断流截断/残留半截工具调用）→ 自动续跑
              if (isAbortedAssistant(list[list.length - 1])) scheduleRetry(s, list)
            })
            .catch(() => {})
          if (s === sidRef.current) {
            setTodos([])
            oc.messages(s, dirRef.current)
              .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
              .catch(() => {})
          }
        }
      } else if (e.type === 'qingniao.kernel.started') {
        // 内核（重）启动：重启前在跑的回合已失效（任务为内存态），清本地 busy 与待重发记录；
        // 残留的 running tool part 由渲染层按"非 busy 即中断"处理，不再死转圈
        const wasBusy = busySids()
        for (const s of wasBusy) markBusy(s, false)
        inflight.current = null
        setTodos([])
        setAsks([])
        setError('')
        // 重启打断的任务自动续跑（会话记录在磁盘，重发原文即可接着做）
        for (const s of wasBusy) scheduleRetry(s)
        if (sidRef.current) {
          oc.messages(sidRef.current, dirRef.current)
            .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
            .catch(() => {})
        }
      } else if (e.type === 'qingniao.kernel.unhealthy') {
        // 主进程自动重启内核后，本地 busy 状态全部失效，做一次整体重同步
        setError('内核连接异常，正在自动恢复…')
        for (const s of Object.keys(busySetRef.current)) markBusy(s, false)
        if (sidRef.current) {
          setTodos([])
          oc.messages(sidRef.current, dirRef.current)
            .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
            .catch(() => {})
        }
      } else if (e.type === 'session.error') {
        const pr = e.properties as { sessionID?: string; error?: { name?: string; message?: string } }
        const sid = pr.sessionID
        if (!sid) return
        // 只对仍在处理中的会话自动续跑；用户已手动停止的会话出了报错事件，不得再自动拉起
        const owned = !!busySetRef.current[sid]
        if (owned) markBusy(sid, false)
        const isCurrent = sid === sidRef.current
        oc.messages(sid, isCurrent ? dirRef.current : busyDir.current[sid])
          .then((list) => {
            const last = list[list.length - 1]
            if (owned && last && last.info.role === 'assistant' && isAbortedAssistant(last)) scheduleRetry(sid, list)
            if (!isCurrent) return
            setMsgs(hydrate(list, shown.current, texts.current))
            setError(humanizeError(pr.error?.message ?? '未知错误'))
            p.onRefreshSessions()
          })
          .catch(() => { if (isCurrent) setError(humanizeError(pr.error?.message ?? '未知错误')) })
      }
    })
    return off
  }, [])

  // 打字机心跳：每帧把未吐完的 text part 匀速推进
  function startTicker() {
    if (ticker.current != null) return
    ticker.current = window.setInterval(() => {
      let pending = false
      texts.current.forEach((full, id) => {
        if ((shown.current.get(id) ?? 0) < full.length) pending = true
      })
      if (!pending) {
        if (ticker.current != null) { clearInterval(ticker.current); ticker.current = null }
        return
      }
      setMsgs((prev) =>
        prev.map((m) => {
          let changed = false
          const parts = m.parts.map((pt) => {
            if (pt.type !== 'text') return pt
            const full = texts.current.get(pt.id)
            if (full == null || pt.text === full) return pt
            const n0 = shown.current.get(pt.id) ?? 0
            const step = Math.max(2, Math.ceil((full.length - n0) / 6))
            const n = Math.min(full.length, n0 + step)
            shown.current.set(pt.id, n)
            changed = true
            return { ...pt, text: full.slice(0, n) }
          })
          return changed ? { ...m, parts } : m
        })
      )
    }, 24)
  }
  useEffect(() => () => { if (ticker.current != null) clearInterval(ticker.current) }, [])

  // 队列消费：本轮结束后自动发下一条；被"立即执行"插队的按下标优先
  useEffect(() => {
    if (busy || !queue.length) return
    let i = 0
    if (hijack.current != null) {
      i = Math.min(hijack.current, queue.length - 1)
      hijack.current = null
    }
    const item = queue[i]
    setQueue((q) => q.filter((_, k) => k !== i))
    void runPrompt(item.text, item.sid || undefined, busyDir.current[item.sid])
  }, [busy, queue])

  // 点新任务/点任务：光标自动落进输入框
  useEffect(() => {
    if (p.focusSignal > 0) taRef.current?.focus()
  }, [p.focusSignal])

  useEffect(() => {
    const el = scrollRef.current
    // 用户在往上翻时不打扰，贴底时才跟随
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [msgs, busy])

  function onMsgsScroll() {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = near
    setAtBottom(near)
  }

  function jumpBottom() {
    atBottomRef.current = true
    setAtBottom(true)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }

  // 执行中每秒累计用时
  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const t = setInterval(() => setElapsed((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  /**
   * 流式兜底轮询：内核对部分 provider 不向 /event 推 message.part.delta（实测只发 heartbeat），
   * 导致渲染层看不到中间过程、内容一次性涌出。busy 期间每 1.2s 拉一次该会话消息，
   * 增量登记进 texts 让打字机续吐——既有 delta 事件时轮询只是幂等补充，无 delta 时它是唯一实时源。
   * 会话空闲后自动停止。
   */
  useEffect(() => {
    if (!busy || !p.sessionId) return
    const sid = p.sessionId
    let alive = true
    const sync = async () => {
      if (!alive) return
      // 提问对账：question.v2.asked 事件可能漏收，busy 期间以内核待答列表为准
      try {
        const list = await oc.questions()
        const mine = (Array.isArray(list) ? list : []).filter((x) => x.sessionID === sid && !replyingRef.current.has(x.id))
        const cur = asksRef.current
        if (mine.length !== cur.length || mine.some((x) => !cur.some((k) => k.id === x.id))) setAsks(mine)
      } catch { /* 忽略 */ }
      try {
        const list = await oc.messages(sid, dirRef.current)
        if (!alive || sid !== sidRef.current || sid !== p.sessionId) return
        // 指纹：消息数 + 各 part 长度。内容无变化直接跳过，避免无谓渲染
        const fp = list.map((m) => m.info.id + ':' + m.parts.map((x) => x.type + (x.text?.length ?? 0)).join(',')).join('|')
        if (fp === pollFingerprint.current) return
        pollFingerprint.current = fp
        setMsgs((prev) => mergePoll(list, prev, texts.current, shown.current, startTicker))
      } catch {
        /* 内核瞬时不可达，下一轮再试 */
      }
    }
    const t = window.setInterval(sync, 1200)
    sync()
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [busy, p.sessionId])

  // 整轮文件差量：内核把差量算在「用户消息」的 summary 上、回合结束才产出，
  // 拉到空结果就隔 3 秒重试几次，保证写入/编辑行最终能显示 +N/-M
  function fetchTurnDiffs(sid: string, dir: string | undefined, uid: string) {
    if (diffs[uid] || diffsBusy.current.has(uid)) return
    diffsBusy.current.add(uid)
    const tryFetch = (n: number) => {
      oc.diff(sid, dir, uid)
        .then((list) => {
          if (Array.isArray(list) && list.length) {
            diffsBusy.current.delete(uid)
            setDiffs((prev) => ({ ...prev, [uid]: list }))
          } else if (n < 4) {
            setTimeout(() => tryFetch(n + 1), 3000)
          } else {
            diffsBusy.current.delete(uid)
          }
        })
        .catch(() => diffsBusy.current.delete(uid))
    }
    tryFetch(0)
  }

  // 出现已完成/出错的写入类工具时按需拉该轮差量（工具行据此显示增减行数与差量代码）
  useEffect(() => {
    if (!p.sessionId) return
    const owners = turnOwners(msgs)
    const todo = new Set<string>()
    for (const m of msgs) {
      const uid = owners.get(m.info.id)
      if (!uid) continue
      for (const part of m.parts) {
        if (part.type === 'tool' && isFileTool(part.tool ?? '')) {
          const st = part.state?.status
          if (st === 'completed' || st === 'error') todo.add(uid)
        }
      }
    }
    for (const uid of todo) fetchTurnDiffs(p.sessionId, dirRef.current, uid)
  }, [msgs, p.sessionId])

  /**
   * 断网自动暂停 / 恢复自动执行：
   * 内核是本地进程，断网只影响它到模型端点的链路。浏览器 offline 时把正在跑的
   * 本轮 prompt 记下并中止内核任务（自动暂停）；online 时自动重发同一句话（自动执行）。
   * 恢复后内核会话历史仍在，重发会接续上下文，不是重复。
   */
  useEffect(() => {
    const inflightRef = inflight
    const onOffline = () => {
      const cur = inflightRef.current
      if (!cur) return
      // 断网期间的中断不走自动重试（onLine=false 时不排期），恢复联网后由下面 onOnline 重发一遍
      cancelRetry(cur.sid)
      oc.abort(cur.sid, busyDir.current[cur.sid]).catch(() => { /* 内核已停/无此任务 */ })
      markBusy(cur.sid, false)
      setError('网络已断开，任务自动暂停，恢复后自动执行。')
    }
    const onOnline = () => {
      const cur = inflightRef.current
      if (!cur) return
      inflightRef.current = null
      setError('')
      void runPrompt(cur.text, cur.sid, busyDir.current[cur.sid])
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 内核管理的终端（pty）：pty.* 事件即时刷新 + 5 秒轮询兜底
  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const list = await oc.terminals()
        if (alive) setTerms(Array.isArray(list) ? list : [])
      } catch { /* 内核瞬时不可达 */ }
    }
    const t = window.setInterval(sync, 5000)
    const off = window.qingniao.onEvent((raw) => {
      const e = raw as { type: string }
      if (e.type === 'pty.created' || e.type === 'pty.updated' || e.type === 'pty.exited' || e.type === 'pty.deleted') sync()
    })
    sync()
    return () => {
      alive = false
      clearInterval(t)
      off()
    }
  }, [])

  /** 终止内核终端：乐观移除，实际结果由下轮轮询纠偏 */
  function killTerm(t: PtySession) {
    setTerms((prev) => prev.filter((x) => x.id !== t.id))
    oc.killTerminal(t.id, dirRef.current).catch(() => { /* 已退出 */ })
  }

  async function send() {
    const text = input.trim()
    if (!text) return
    setInput('')
    setError('')
    hist.current.push(text)
    histPos.current = hist.current.length
    // 用户自己发新消息 = 不用自动重试来续跑了
    if (p.sessionId) cancelRetry(p.sessionId)
    if (busy) {
      // 终端长跑卡住本轮：发送新消息 = 用户主动接管（中止当前轮后立即执行，不进队列）
      if (terminalBlocked && sidRef.current) {
        const sid = sidRef.current
        oc.abort(sid, busyDir.current[sid]).catch(() => { /* 已结束 */ })
        window.setTimeout(() => runPrompt(text, sid, busyDir.current[sid]), 900)
        return
      }
      setQueue((q) => [...q, { sid: sidRef.current, text }])
      return
    }
    await runPrompt(text)
  }

  async function runPrompt(text: string, sidOverride?: string, dirOverride?: string) {
    const dir = dirOverride ?? p.project?.path
    let sid = sidOverride ?? p.sessionId
    if (!sid) {
      // 草稿：首次发送才真正创建会话；标题直接用用户这句话，避免 "New session - 时间戳"
      const title = text.length > 30 ? text.slice(0, 30) + '…' : text
      try {
        const s = await oc.createSession(dir, title)
        s.title = title
        sid = s.id
        sidRef.current = s.id
        justCreated.current = s.id
        // 草稿首发即把项目目录下的记忆文件作为「仅上下文」注入：
        // <项目>/.qingniao/memory/MEMORY.md（长期）+ YYYY-MM-DD.md（当日），AI 自动带上项目背景，
        // 并被告知可用文件工具维护这两个文件——真正的「自动记忆」，无需 UI 手动编辑。
        const mem = dir ? await window.qingniao.readMemory(dir).catch(() => null) : null
        const longMem = mem?.long?.trim() ?? ''
        const dailyMem = mem?.daily?.trim() ?? ''
        let memText =
          MEMORY_PREFIX +
          '你正在协助的项目，记忆文件位于该工作目录下：\n' +
          '- 长期记忆：.qingniao/memory/MEMORY.md\n' +
          '- 每日工作：.qingniao/memory/YYYY-MM-DD.md\n' +
          '可用文件工具读取与更新它们；新对话会自动加载，无需用户重复说明项目背景。\n' +
          '遇到值得长期保留的项目知识（技术栈、约定、常见任务、关键路径、踩坑）请写入 MEMORY.md；\n' +
          '每轮完成的重要工作，请用一两句话追加到当日文件。'
        if (longMem) memText += '\n\n# 长期记忆\n' + longMem
        if (dailyMem) memText += '\n\n# 今日已做\n' + dailyMem
        oc.injectContext(sid, dir, memText).catch(() => { /* 记忆注入失败不影响正常对话 */ })
        p.onDraftCreated(s)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    markBusy(sid, true, dir)
    inflight.current = { sid, text }
    atBottomRef.current = true
    setAtBottom(true)
    const tmpId = 'tmp-' + Date.now()
    turnBase.current = new Set(msgs.map((m) => m.info.id))
    const optimistic: MessageView = {
      info: { id: tmpId, role: 'user', sessionID: sid },
      parts: [{ id: tmpId + '-p', sessionID: sid, messageID: tmpId, type: 'text', text }]
    }
    setMsgs((prev) => [...prev, optimistic])
    let transportLost = false
    try {
      await oc.prompt(sid, dir, text, parseModel(p.model))
    } catch (e) {
      const status = (e as Error & { status?: number }).status
      // 502/503 是主进程代抛的传输层故障（内核还在跑），不代表任务结束：
      // 任务继续执行任意时长都由事件流与轮询展示，session.idle / SSE 重连负责收尾。
      // 只有内核明确拒绝（如 4xx，请求未被接受）才当场报错收尾。
      if (status && status !== 502 && status !== 503) {
        setError(e instanceof Error ? e.message : String(e))
        markBusy(sid, false)
      } else {
        transportLost = true
      }
    } finally {
      inflight.current = null
      if (!transportLost) {
        // 本轮所属会话置空闲（若 session.idle 已清过则幂等无副作用；仅当前仍停在本轮会话时清——
        // 队列插队已在本会话开新轮时不能误清新轮）
        if (sidRef.current === sid && busySetRef.current[sid]) markBusy(sid, false)
        // 已切走（新任务草稿/别的会话）：界面缓冲归切走时加载的新会话所有，绝不清理，避免盖掉正在流式的新任务
        if (sidRef.current !== sid) return
        toolRaw.current.clear()
        setPreviews({})
        try {
          const list = await oc.messages(sid, dir)
          setMsgs(hydrate(list, shown.current, texts.current))
          startTicker()
        } catch { /* 保留已渲染内容 */ }
      }
    }
  }

  /** 队列项立即执行：中断当前任务，插队优先 */
  function queueSend(i: number) {
    if (busy && sidRef.current) {
      hijack.current = i
      oc.abort(sidRef.current, busyDir.current[sidRef.current]).catch(() => { /* 已结束 */ })
    } else {
      const item = queue[i]
      setQueue((q) => q.filter((_, k) => k !== i))
      // 队列里这条消息就是用户的新指令，优先于自动重试续跑
      cancelRetry(item.sid)
      void runPrompt(item.text, item.sid || undefined, busyDir.current[item.sid])
    }
  }

  function queueEdit(i: number) {
    const item = queue[i]
    setQueue((q) => q.filter((_, k) => k !== i))
    setInput(item.text)
  }

  /** 应答内核提问：提交后内核继续本轮任务；提交期间轮询对账跳过该请求，防止卡片闪回 */
  function replyAsk(req: QuestionAsk, answers: string[][]) {
    replyingRef.current.add(req.id)
    setAsks((prev) => prev.filter((x) => x.id !== req.id))
    oc.replyQuestion(req.id, answers, dirRef.current)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => replyingRef.current.delete(req.id))
  }

  function rejectAsk(req: QuestionAsk) {
    setAsks((prev) => prev.filter((x) => x.id !== req.id))
    oc.rejectQuestion(req.id, dirRef.current).catch(() => { /* 已应答/已失效 */ })
  }

  // 可见消息数：项目记忆是「仅上下文」注入（AI 可见、界面不渲染），不能算进「有内容」，
  // 否则注入记忆后 msgs 非空、空态引导就不显示了
  const visibleMsgCount = msgs.filter((m) => {
    if (m.info.role !== 'user') return true
    const txt = m.parts.filter((x) => x.type === 'text').map((x) => x.text).join('')
    return !txt.startsWith(MEMORY_PREFIX)
  }).length

  return (
    <main className="main">
      <div
        className="msgs"
        ref={scrollRef}
        onScroll={onMsgsScroll}
        onWheel={(e) => {
          // 上滚瞬间同步脱离吸底：流式期间 24ms 一帧的自动滚动会赶在 scroll 事件前把位置拉回底部，
          // 只有拖滚动条（持续触发 onScroll）能赢，滚轮就这么被"吸"回去了
          if (e.deltaY < 0) {
            atBottomRef.current = false
            setAtBottom(false)
          }
        }}
      >
        <div className="col">
          {error && (
            <div className="errbar">
              <AlertCircle size={14} /> <span>{error}</span>
              <button className="icon-btn" onClick={() => setError('')}>
                <X size={14} />
              </button>
            </div>
          )}
          {visibleMsgCount === 0 && !busy && (
            <div className="empty">
              <div className="empty-title">新对话</div>
              <div>在下方输入框描述任务，AI 会直接在这个项目里读取、修改代码并执行终端命令</div>
              <div>Enter 发送 · Shift+Enter 换行 · 处理中可随时停止，已发送的消息可编辑后重发</div>
            </div>
          )}
          {msgs.map((m) => {
            if (m.info.role === 'user') {
              const txt = m.parts.filter((x) => x.type === 'text').map((x) => x.text).join('')
              // 项目记忆是「仅上下文」注入，AI 可见但界面不渲染，保持对话顶部干净
              if (txt.startsWith(MEMORY_PREFIX)) return null
              return <UserBubble key={m.info.id} text={txt} editable={!busy} onSend={(t) => void resendMessage(m.info.id, t)} />
            }
            return (
              <div key={m.info.id} className="amsg">
                {m.parts.map((part) => (
                  <PartView key={part.id} part={part} projectPath={p.project?.path} preview={previews[part.id]} live={busy && m.info.id === lastAid} diffs={diffs[turnOwner.get(m.info.id) ?? '']} />
                ))}
              </div>
            )
          })}
          {asks.length > 0 && (
            <AskModal key={asks[0].id} req={asks[0]} onReply={(ans) => replyAsk(asks[0], ans)} onReject={() => rejectAsk(asks[0])} />
          )}
          {todos.length > 0 && <TodoCard todos={todos} live={busy} />}
          {busy && (
            <div className="amsg busyline">
              {terminalBlocked ? (
                '终端运行中 · 新消息发送将接管任务'
              ) : (
                <>
                  <LoaderCircle size={13} className="spin" />
                  {asks.length > 0
                    ? '等待你回答'
                    : msgs.some((m) => m.info.role === 'assistant' && !turnBase.current.has(m.info.id))
                      ? `处理中，已用时 ${fmtElapsed(elapsed)}`
                      : `正在思考，已用时 ${fmtElapsed(elapsed)}`}
                </>
              )}
            </div>
          )}
          {retryState?.pending && !busy && (
            <div className="amsg retrystatus">
              <LoaderCircle size={13} className="spin" />
              <span>任务已中断，{RETRY_INTERVAL_MS / 1000} 秒后自动重试（第 {retryState.count}/{RETRY_MAX} 次）</span>
              <button className="icon-btn" title="取消自动重试" onClick={() => cancelRetry(p.sessionId)}>
                <X size={13} />
              </button>
            </div>
          )}
          {retryState && !retryState.pending && !busy && (
            <div className="amsg retryfail">
              <AlertCircle size={13} />
              <span>已自动重试 {RETRY_MAX} 次仍未完成，点右侧按钮让 AI 继续处理</span>
              <button className="retrybtn" onClick={() => void retryNow()} title="让 AI 接着处理">
                <RotateCw size={13} /> 重试
              </button>
            </div>
          )}
        </div>
      </div>

      {!atBottom && (
        <div className="jumpwrap">
          <button className="jump" title="回到底部" onClick={jumpBottom}>
            <ArrowDown size={16} />
          </button>
        </div>
      )}

      {queue.length > 0 && (
        <div className="qbar">
          <div className="col">
            <button className="qhead" onClick={() => setQCollapsed((v) => !v)}>
              {qCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              任务队列 · {queue.length} 条
              <span className="q-sub">排队等当前任务完成</span>
            </button>
            {!qCollapsed &&
              queue.map((t, i) => (
                <div key={i} className="qitem" title={t.text}>
                  <span className="qi-no">{i + 1}</span>
                  <span className="qi-text">{t.text}</span>
                  <span className="qacts">
                    <button className="icon-btn" title="立即执行（中断当前任务）" onClick={() => queueSend(i)}>
                      <Send size={13} />
                    </button>
                    <button className="icon-btn" title="移回输入框编辑" onClick={() => queueEdit(i)}>
                      <Pencil size={13} />
                    </button>
                    <button className="icon-btn danger" title="删除" onClick={() => setQueue((q) => q.filter((_, k) => k !== i))}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {showTerms && (
        <Modal title="运行中的终端" onClose={() => setShowTerms(false)}>
          {terms.filter((x) => x.status === 'running').map((t) => (
            <div key={t.id} className="term-row">
              <Terminal size={13} />
              <span className="term-cmd" title={[t.command, ...(t.args ?? [])].filter(Boolean).join(' ')}>
                {t.title || t.command}
              </span>
              {t.pid ? <span className="term-pid">PID {t.pid}</span> : null}
              <button className="icon-btn danger" title="终止终端" onClick={() => killTerm(t)}>
                <X size={13} />
              </button>
            </div>
          ))}
          {terms.filter((x) => x.status === 'running').length === 0 && (
            <div className="mp-empty">当前没有运行中的终端</div>
          )}
        </Modal>
      )}

      <div className="cwrap">
        <div className="cbox col">
          <textarea
            ref={taRef}
            className="ctext"
            value={input}
            rows={2}
            placeholder={busy ? '当前任务执行中，输入新需求可加入队列' : 'Enter 发送 / Shift+Enter 换行'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+Z 回看已发送消息（草稿先存，前进时恢复）；Ctrl+Y / Ctrl+Shift+Z 前进
              if (e.ctrlKey && !e.altKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
                e.preventDefault()
                if (!hist.current.length) return
                if (histPos.current === hist.current.length) draftRef.current = input
                histPos.current = Math.max(0, histPos.current - 1)
                setInput(hist.current[histPos.current])
                return
              }
              if ((e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) || (e.ctrlKey && (e.key === 'y' || e.key === 'Y'))) {
                e.preventDefault()
                if (histPos.current >= hist.current.length) return
                histPos.current += 1
                setInput(histPos.current === hist.current.length ? draftRef.current : hist.current[histPos.current])
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="crow">
            <ProjectPicker
              projects={p.projects}
              value={p.project?.id}
              onChange={p.onSwitchProject}
              onPickDir={p.onPickDir}
            />
            {terms.some((x) => x.status === 'running') && (
              <button className="crow-term" title="运行中的终端" onClick={() => setShowTerms(true)}>
                <Terminal size={13} />
                {terms.filter((x) => x.status === 'running').length}
              </button>
            )}
            <span className="spacer" />
            <ModelPicker groups={groups} value={p.model} onChange={p.onModelChange} onOpenSettings={p.onOpenSettings} />
            {anyBusy ? (
              <button className="send-round stop" title="停止所有任务" onClick={() => void stopAll()}>
                <Square size={15} fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button className="send-round" disabled={!input.trim()} onClick={send} title="发送">
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

/**
 * 拉取的全量消息进入渲染前：登记全文进 texts，
 * 并把仍在打字的 part 截回当前已显示长度（其余直接显示）
 */
function hydrate(list: MessageView[], shown: Map<string, number>, texts: Map<string, string>): MessageView[] {
  for (const m of list) {
    for (const pt of m.parts) {
      if (pt.type === 'text' && pt.text) {
        texts.set(pt.id, pt.text)
        const n = shown.get(pt.id) ?? pt.text.length
        shown.set(pt.id, Math.min(n, pt.text.length))
      }
    }
  }
  return list.map((m) => ({
    ...m,
    parts: m.parts.map((pt) => {
      if (pt.type !== 'text' || !pt.text) return pt
      const n = shown.get(pt.id) ?? pt.text.length
      return n < pt.text.length ? { ...pt, text: pt.text.slice(0, n) } : pt
    })
  }))
}

/** message.part.delta：往对应 part 追加 token 增量（快照未到前先建占位） */
function appendDelta(
  list: MessageView[],
  pr: { sessionID: string; messageID: string; partID: string; field: string; delta: string },
  texts: Map<string, string>,
  roles: Map<string, 'user' | 'assistant'>,
  shown: Map<string, number>,
  ensureTicker: () => void
): MessageView[] {
  const full = (texts.get(pr.partID) ?? '') + pr.delta
  texts.set(pr.partID, full)
  ensureTicker()
  const n = shown.get(pr.partID) ?? 0
  // 类型判定：OpenCode 的 reasoning 增量 field 同样是 text，不能靠 field。
  // part.updated 快照（带权威 type）先于 delta 到达，命中已有 part 就沿用其类型；
  // 兜底 field 推断，避免快照未到时误把思维链打成正文。
  let type: string = pr.field === 'reasoning' ? 'reasoning' : 'text'
  for (const m of list) {
    const hit = m.parts.find((x) => x.id === pr.partID)
    if (hit) {
      type = hit.type
      break
    }
  }
  const part: Part = { id: pr.partID, sessionID: pr.sessionID, messageID: pr.messageID, type, text: full.slice(0, n) }
  return upsertPart(list, part, roles)
}

/**
 * 轮询兜底：把 /message 拉到的全量消息增量并入现有渲染列表。
 * 新 part 的 text 登记进 texts，打字机从「当前已显示长度」继续吐（不从头重播）；
 * 已有 part 只合并新字段，不覆盖事件流已推进的打字进度。
 */
function mergePoll(
  polled: MessageView[],
  prev: MessageView[],
  texts: Map<string, string>,
  shown: Map<string, number>,
  ensureTicker: () => void
): MessageView[] {
  const known = new Map<string, MessageView>(prev.map((m) => [m.info.id, m]))
  const out: MessageView[] = []
  let changed = false
  for (const m of polled) {
    const exist = known.get(m.info.id)
    if (!exist) {
      // 新消息（本轮的助手消息）：整体并入，text part 登记全文让打字机接着吐
      for (const pt of m.parts) {
        if ((pt.type === 'text' || pt.type === 'reasoning') && pt.text) {
          if (!texts.has(pt.id)) {
            texts.set(pt.id, pt.text)
            ensureTicker()
          }
        }
      }
      out.push(m)
      changed = true
      continue
    }
    // 已有消息：逐个 part 合并（只补新 part / 新字段，不碰已渲染文本）
    let merged = exist
    for (const pt of m.parts) {
      const have = merged.parts.find((x) => x.id === pt.id)
      if (!have) {
        merged = { ...merged, parts: [...merged.parts, pt] }
        changed = true
        if ((pt.type === 'text' || pt.type === 'reasoning') && pt.text && !texts.has(pt.id)) {
          texts.set(pt.id, pt.text)
          ensureTicker()
        }
      } else if (have.tool && pt.state?.status !== have.state?.status) {
        merged = { ...merged, parts: merged.parts.map((x) => (x.id === pt.id ? pt : x)) }
        changed = true
      }
    }
    out.push(merged)
    known.delete(m.info.id)
  }
  // 本地独有的保留；乐观插入的 tmp 用户消息在真实用户消息到达后按文本匹配丢弃，避免重复气泡
  const realUserTexts = new Set(
    polled
      .filter((m) => m.info.role === 'user')
      .map((m) => m.parts.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n'))
  )
  known.forEach((m) => {
    if (
      m.info.id.startsWith('tmp-') &&
      realUserTexts.has(m.parts.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n'))
    )
      return
    out.push(m)
  })
  return changed ? out : prev
}

/** message.part.updated：parts 全量快照（登记全文，打字进度由 ticker 追） */
function applySnapshot(
  list: MessageView[],
  part: Part,
  texts: Map<string, string>,
  roles: Map<string, 'user' | 'assistant'>,
  shown: Map<string, number>,
  ensureTicker: () => void
): MessageView[] {
  let patched = part
  if (part.type === 'text' || part.type === 'reasoning') {
    const full = part.text ?? ''
    texts.set(part.id, full)
    ensureTicker()
    // 还没进入流式状态的一部分（用户消息整段快照、或整段快照先于增量抵达）：
    // 直接显示整段，避免先蹦一个空的底色气泡再逐字补全
    if (shown.get(part.id) == null) shown.set(part.id, full.length)
    const n = shown.get(part.id) ?? full.length
    patched = n < full.length ? { ...part, text: full.slice(0, n) } : part
  }
  return upsertPart(list, patched, roles)
}

function upsertPart(
  list: MessageView[],
  part: Part,
  roles: Map<string, 'user' | 'assistant'>
): MessageView[] {
  let next = [...list]
  const mi = next.findIndex((m) => m.info.id === part.messageID)
  if (mi < 0) {
    // 真实用户消息出现时，顶掉乐观插入的同文本 tmp 气泡，避免瞬间冒出两个重复气泡
    if (roles.get(part.messageID) === 'user' && part.type === 'text') {
      const text = part.text ?? ''
      next = next.filter(
        (m) =>
          !(m.info.id.startsWith('tmp-') && m.parts.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n') === text)
      )
    }
    next.push({
      info: { id: part.messageID, role: roles.get(part.messageID) ?? 'assistant', sessionID: part.sessionID },
      parts: [part]
    })
    return next
  }
  const msg = next[mi]
  const pi = msg.parts.findIndex((x) => x.id === part.id)
  next[mi] = {
    ...msg,
    parts: pi < 0 ? [...msg.parts, part] : msg.parts.map((x, i) => (i === pi ? part : x))
  }
  return next
}

/**
 * 折叠容器：内容超过 maxPx 高时收起，露出渐隐的尾部 + 「展开全文」。
 * 用实测高度判定（比字数/行数更准），内容变化时自动复测。
 */
function Collapsible({
  children,
  maxPx,
  forceText
}: {
  children: ReactNode
  /** 折叠阈值（px） */
  maxPx: number
  /** 判定用纯文本；不传则只看高度 */
  forceText?: string
}) {
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // 文本变化即复测（流式输出时先不高，长到超阈值才出现按钮）
  useEffect(() => {
    const el = ref.current
    if (el) setOver(el.scrollHeight > maxPx + 8)
  }, [forceText, maxPx])
  const clipped = over && !open
  return (
    <div className="cbl">
      <div
        ref={ref}
        className={clipped ? 'cbl-body clipped' : 'cbl-body'}
        style={clipped ? { maxHeight: maxPx } : undefined}
      >
        {children}
      </div>
      {over && (
        <button className="cbl-toggle" onClick={() => setOpen((v) => !v)}>
          <ChevronDown size={12} className={open ? 'up' : undefined} />
          {open ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  )
}

/** 用户消息气泡：超过 6 行自动折叠；悬浮显示 编辑（放回输入框）/复制，操作列在气泡上方 */
/** 用户消息气泡：操作列（编辑/复制）在气泡下方；编辑时在该行展开聊天窗样式的输入框 + 取消/发送
 * 发送只更新这条消息并让 AI 重新回复（见 ChatView.resendMessage） */
function UserBubble({ text, editable, onSend }: { text: string; editable?: boolean; onSend: (t: string) => void }) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)

  function sendEdit() {
    setEditing(false)
    const v = draft.trim()
    // 内容与原文相同也允许发送：等价于「按原话重新生成」，由下游 revert + 重发完成
    if (!v) return
    onSend(v)
  }

  // 编辑态：该行展开一个聊天窗样式的输入框，下方是 取消/发送
  if (editing) {
    return (
      <div className="umsg editing">
        <div className="ubox uedit-wrap">
          <textarea
            className="uedit"
            value={draft}
            rows={2}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendEdit()
              }
            }}
          />
          <div className="uedit-acts">
            <span className="uedit-hint">更新这条消息，下方的 AI 回复会重新生成</span>
            <button className="ghost" onClick={() => setEditing(false)}>
              取消
            </button>
            <button className="primary" disabled={!draft.trim()} onClick={sendEdit}>
              发送
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="umsg">
      <div className="ubox">
        <Collapsible maxPx={150} forceText={text}>
          <div className="ubub">{text}</div>
        </Collapsible>
        {/* 操作列在气泡下方，hover 显示 */}
        <div className="uacts">
          {editable && (
            <button className="icon-btn" title="编辑消息" onClick={() => { setDraft(text); setEditing(true) }}>
              <Pencil size={12} />
            </button>
          )}
          <button
            className="icon-btn"
            title={copied ? '已复制' : '复制'}
            onClick={() => {
              navigator.clipboard?.writeText(text).catch(() => {})
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 开发任务清单卡：todo.updated 驱动，完成项打勾 + 中划线，进行项转圈，序号 + 优先级标签 */
function TodoCard({ todos, live, bare }: { todos: TodoItem[]; live?: boolean; bare?: boolean }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todo-card">
      {!bare && (
        <div className="todo-head">
          <ListChecks size={13} />
          任务清单
          <span className="todo-prog">{done}/{todos.length}</span>
        </div>
      )}
      {todos.map((t, i) => (
        <div key={i} className={'todo-item ' + t.status}>
          <span className="todo-idx">{i + 1}</span>
          <span className="todo-box">
            {t.status === 'completed' ? (
              <Check size={13} />
            ) : t.status === 'in_progress' ? (
              live ? <LoaderCircle size={13} className="spin" /> : <span className="todo-run" />
            ) : (
              <span className="todo-dot" />
            )}
          </span>
          <span className="todo-text">{t.content}</span>
        </div>
      ))}
    </div>
  )
}

/** OpenCode 工具名 → 中文标签与图标（按小写查找，兼容大小写变体） */
const TOOL_META: Record<string, { name: string; icon: ReactNode }> = {
  read: { name: '读取', icon: <FileText size={13} /> },
  write: { name: '写入', icon: <FilePlus size={13} /> },
  edit: { name: '编辑', icon: <Pencil size={13} /> },
  apply_patch: { name: '应用补丁', icon: <FileDiffIcon size={13} /> },
  patch: { name: '应用补丁', icon: <FileDiffIcon size={13} /> },
  bash: { name: '终端', icon: <Terminal size={13} /> },
  shell: { name: '终端', icon: <Terminal size={13} /> },
  execute: { name: '执行', icon: <Terminal size={13} /> },
  glob: { name: '查找文件', icon: <Search size={13} /> },
  grep: { name: '搜索内容', icon: <Search size={13} /> },
  codesearch: { name: '代码搜索', icon: <Search size={13} /> },
  webfetch: { name: '抓取网页', icon: <Globe size={13} /> },
  websearch: { name: '网络搜索', icon: <Globe size={13} /> },
  task: { name: '子任务', icon: <Bot size={13} /> },
  todowrite: { name: '待办清单', icon: <ListChecks size={13} /> },
  todo_write: { name: '待办清单', icon: <ListChecks size={13} /> },
  question: { name: '提问', icon: <HelpCircle size={13} /> },
  skill: { name: '技能', icon: <Sparkles size={13} /> },
  retry: { name: '重试', icon: <RotateCw size={13} /> },
  invalid: { name: '无效调用', icon: <AlertCircle size={13} /> }
}

/** 内核提问应答弹窗：一问一答逐步进行（上一步/下一步），最后一步提交全部答案 */
function AskModal({
  req,
  onReply,
  onReject
}: {
  req: QuestionAsk
  onReply: (answers: string[][]) => void
  onReject: () => void
}) {
  const [sel, setSel] = useState<string[][]>(() => req.questions.map(() => []))
  const [draft, setDraft] = useState<string[]>(() => req.questions.map(() => ''))
  const [step, setStep] = useState(0)
  const i = Math.min(step, req.questions.length - 1)
  const q = req.questions[i]
  const last = i >= req.questions.length - 1

  function toggle(label: string) {
    setSel((prev) =>
      prev.map((s, k) => {
        if (k !== i) return s
        if (s.includes(label)) return s.filter((x) => x !== label)
        return q.multiple ? [...s, label] : [label]
      })
    )
  }

  function addCustom() {
    const v = (draft[i] ?? '').trim()
    if (!v) return
    setSel((prev) => prev.map((s, k) => (k === i && !s.includes(v) ? [...s, v] : s)))
    setDraft((prev) => prev.map((d, k) => (k === i ? '' : d)))
  }

  return (
    <Modal title={`助手提问 ${i + 1}/${req.questions.length}`} onClose={onReject}>
      <div className="ask-q">
        <div className="ask-title">{q.question}</div>
        <div className="ask-opts">
          {(q.options ?? []).map((o) => (
            <button
              key={o.label}
              type="button"
              className={'ask-opt' + (sel[i].includes(o.label) ? ' on' : '')}
              title={o.description}
              onClick={() => toggle(o.label)}
            >
              {o.label}
            </button>
          ))}
        </div>
        {(q.custom ?? true) && (
          <div className="ask-custom">
            <input
              value={draft[i] ?? ''}
              placeholder="自定义回答，回车添加…"
              onChange={(e) => setDraft((prev) => prev.map((d, k) => (k === i ? e.target.value : d)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCustom()
                }
              }}
            />
            <button type="button" className="ghost" onClick={addCustom}>
              添加
            </button>
          </div>
        )}
      </div>
      <div className="ask-acts">
        {i > 0 && (
          <button className="ghost" onClick={() => setStep(i - 1)}>
            上一步
          </button>
        )}
        {!last && (
          <button className="primary" onClick={() => setStep(i + 1)}>
            下一步
          </button>
        )}
        {last && (
          <button className="primary" onClick={() => onReply(req.questions.map((_, k) => sel[k] ?? []))}>
            提交答案
          </button>
        )}
        <button className="ghost" onClick={onReject}>
          跳过
        </button>
      </div>
    </Modal>
  )
}

/** 内核工具的英文系统消息 → 中文；纯结果确认句（"写入成功"类）视为无信息量，返回空串让渲染层决定回退展示 */
const OUTPUT_CONFIRM_RE = /^(Edit applied successfully\.?|Wrote file successfully\.?|Update applied successfully\.?|Aborted\.?|The \w+ tool was called with invalid arguments:[\s\S]*$)/i

/** 内核工具的英文系统消息 → 中文；纯结果确认句（"写入成功"类）视为无信息量，返回空串让渲染层决定回退展示 */
function cnOutput(text: string): string {
  if (OUTPUT_CONFIRM_RE.test(text)) return ''
  const t = text
    .replace(/^Edit applied successfully\.?/i, '编辑已应用。')
    .replace(/^Wrote file successfully\.?/i, '文件写入成功。')
    .replace(/^Update applied successfully\.?/i, '修改已应用。')
    .replace(/^Aborted\.?/i, '已中止。')
    .replace(/^The (\w+) tool was called with invalid arguments:[\s\S]*$/i, (_m, n: string) => {
      const zh = TOOL_META[n.toLowerCase()]?.name ?? n
      return `「${zh}」工具的调用参数不完整，已让模型重写参数重试。`
    })
  return t
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 秒数 → 中文时长：1秒 / 45秒 / 1分20秒 */
function fmtElapsed(s: number): string {
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? `${m}分钟` : `${m}分${r}秒`
}

/** 从流式工具入参（JSON 片段，可能不完整）中抽出要展示的文本 */
function extractToolContent(raw: string): string {
  const m = /"(?:content|newString|new_string|command|text|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)
  if (!m) return ''
  let s = m[1]
  if (/(?:^|[^\\]\\{2\})*(\\{1,3}|\\u[0-9a-fA-F]{1,3})$/.test(s)) s = s.replace(/(\\{1,3}|\\u[0-9a-fA-F]{1,3})$/, '')
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
}

/** 文件扩展名 → highlight.js 语言 */
function extLang(file: string): string | undefined {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', php: 'php', rb: 'ruby', kt: 'kotlin', swift: 'swift',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sql: 'sql',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', env: 'properties', properties: 'properties',
    md: 'markdown', html: 'xml', xml: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less',
    sh: 'bash', bash: 'bash', bat: 'dos', cmd: 'dos', ps1: 'powershell', dockerfile: 'dockerfile',
    txt: 'plaintext', log: 'plaintext', proto: 'protobuf', graphql: 'graphql', lua: 'lua', r: 'r', dart: 'dart', scala: 'scala'
  }
  return map[ext]
}

/** 解析子任务（task）工具输出：剥掉 <task>/<task_result> XML 包装，只取正文 */
function parseTaskOutput(raw: string): string | null {
  const m = /<task_result>\n?([\s\S]*?)<\/task_result>/.exec(raw)
  return m ? m[1].trim() : null
}

/** 解析 read 工具输出：文件取 <content> 剥行号；目录取 <entries> 只列条目，剥掉 path/type 包装 */
function parseReadOutput(raw: string): { code: string; file?: string; list?: string[] } | null {
  const p = /<path>([^<]*)<\/path>/.exec(raw)
  const e = /<entries>\n?([\s\S]*?)\n?<[^\n]*entries>/i.exec(raw)
  if (e && !/<content>/i.test(raw)) {
    const lines = e[1].trim().split('\n').filter(Boolean)
    const list = lines.filter((l) => !/^\((\d+) entries?\)$/.test(l))
    return { code: '', file: p?.[1], list }
  }
  const c = /<content>\n?([\s\S]*?)<\/content>/.exec(raw)
  if (!c) return null
  const code = c[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\d{1,6}:(?=\s)\s?/, ''))
    .join('\n')
  return { code: code.trimEnd(), file: p?.[1] }
}

/** 目录条目视图：文件列表 + 数量 */
function DirList({ list, file }: { list: string[]; file?: string }) {
  return (
    <div className="step-list">
      <div className="step-list-head" title={file ?? ''}>{file ? relTarget(file) : '目录'} · {list.length} 项</div>
      {list.map((f) => (
        <div key={f} className="step-list-item" title={f}>{f}</div>
      ))}
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toolTarget(part: Part, projPath?: string): string {
  // 待办清单工具的输出是 JSON 数组（已渲染成任务卡），其标题「N todos」无信息量，不展示在工具行
  if ((part.tool ?? '').toLowerCase().includes('todo')) return ''
  const inp = part.state?.input ?? {}
  // 子任务用 description，其余工具用各自的目标字段
  let raw = str(inp.description) || str(inp.filePath) || str(inp.path) || str(inp.command) || str(inp.pattern) || str(inp.url)
  // 兜底内核生成的英文摘要 → 中文化（"4 todos"→"4条任务"、"Asked 2 questions"→"提问 2 个问题"）
  const t = str(part.state?.title)
  if (!raw) {
    const asked = /^Asked (\d+) questions?$/i.exec(t)
    if (asked) raw = `提问 ${asked[1]} 个问题`
    else if (/todos?/i.test(t)) raw = t.replace(/\s*todos?\.?/i, '条任务').trim()
    else raw = t
  }
  const cut = raw.length > 90 ? raw.slice(0, 90) + '…' : raw
  return relTarget(cut, projPath)
}

/** 展示用：绝对路径裁剪为项目相对路径 */
function relTarget(s: string, projPath?: string): string {
  if (!s || !projPath) return s
  const base = projPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const n = s.replace(/\\/g, '/')
  if (n.toLowerCase().startsWith(base.toLowerCase() + '/')) return n.slice(base.length + 1)
  return s
}

function PartView({ part, projectPath, preview, live, diffs }: { part: Part; projectPath?: string; preview?: string; live?: boolean; diffs?: FileDiff[] }) {
  // 正文过长（代码大段粘贴/长回答）自动收起，点「展开全文」看全
  if (part.type === 'text' && part.text) {
    return (
      <Collapsible maxPx={520} forceText={part.text}>
        <Markdown text={part.text} />
      </Collapsible>
    )
  }
  if (part.type === 'reasoning') {
    // 空 reasoning（被中断/未产出内容）不渲染：避免残留出多个空「正在思考」、展开无内容
    if (!part.text?.trim()) return null
    return <StepLine icon={<Brain size={13} />} name="思考" status="completed" body={<CodeBlock text={part.text} />} />
  }
  if (part.type === 'tool') {
    const meta = TOOL_META[(part.tool ?? '').toLowerCase()] ?? { name: part.tool ?? '工具', icon: <Wrench size={13} /> }
    let st = part.state?.status ?? 'pending'
    // 会话已不 busy（如内核重启后残留 running 的 tool part）：running 视为中断而非进行中，避免死转圈
    if (st === 'running' && !live) st = 'error'
    const tool = (part.tool ?? '').toLowerCase()
    // 写入类工具：优先展示内核持久化在 part.state.input 的完整入参（write 的 content、edit 的 old/newString、
    // patch 的 patchText）；若该字段为空（如 apply_patch 走 structuredOutput、input 未挂）则回退差量/输出。
    const toolIn = part.state?.input as Record<string, unknown> | undefined
    const inContent =
      (tool === 'write' && typeof toolIn?.content === 'string')
      || (tool === 'edit' && (typeof toolIn?.newString === 'string' || typeof toolIn?.new_string === 'string'))
      || (tool === 'apply_patch' && typeof (toolIn?.patchText ?? toolIn?.patch_text) === 'string')
      ? (tool === 'write' ? toolIn!.content : tool === 'edit' ? (toolIn!.newString ?? toolIn!.new_string) : (toolIn!.patchText ?? toolIn!.patch_text)) as string
      : ''
    const rawOut = cnOutput(st === 'error' ? str(part.state?.error) : str(part.state?.output))
    // 写入类工具：内核算好的整轮差量优先（带 +/- 行），工具自身输出仅作回退
    const fd = isFileTool(tool) ? (matchedDiff(metaDiffs(part), part) ?? matchedDiff(diffs, part)) : undefined
    let body: ReactNode
    if (rawOut && tool === 'read') {
      const parsed = parseReadOutput(rawOut)
      body = parsed?.list ? <DirList list={parsed.list} file={parsed.file} /> : parsed ? <CodeBlock text={parsed.code} file={parsed.file} /> : <CodeBlock text={rawOut} />
    } else if (isFileTool(tool)) {
      // 优先展示写入的代码内容（part 入参），其次内核差量，最后工具输出
      if (inContent) {
        const file = str(toolIn?.filePath) || str(toolIn?.path) || fd?.file || toolTarget(part, projectPath)
        body = tool === 'write'
          ? <CodeBlock text={inContent} file={file} />
          : tool === 'apply_patch'
            ? <CodeBlock text={inContent} diff file={file} />
            : <CodeBlock text={inContent} diff file={file} />
      } else if (fd?.patch) {
        body = <CodeBlock text={fd.patch} diff file={fd.file} />
      } else if (rawOut) {
        body = <CodeBlock text={rawOut} />
      }
    } else if (rawOut && (tool === 'todowrite' || tool === 'todo_write')) {
      // 待办清单输出是 JSON 数组：渲染成任务清单卡（历史快照不转圈），不甩原始 JSON 给用户
      try {
        const arr = JSON.parse(rawOut) as TodoItem[]
        body = Array.isArray(arr) ? <TodoCard todos={arr} live={live} bare /> : <CodeBlock text={rawOut} />
      } catch {
        body = <CodeBlock text={rawOut} />
      }
    } else if (rawOut && tool === 'task') {
      const inner = parseTaskOutput(rawOut)
      body = inner !== null ? <Markdown text={inner} /> : <CodeBlock text={rawOut} />
    } else if (rawOut) {
      body = <CodeBlock text={rawOut} />
    }
    return (
      <StepLine
        icon={meta.icon}
        name={meta.name}
        status={st}
        target={toolTarget(part, projectPath)}
        preview={preview}
        body={body}
        stats={fd && (fd.additions || fd.deletions) ? { additions: fd.additions, deletions: fd.deletions } : undefined}
        spin={st === 'running' && tool !== 'bash' && tool !== 'shell' && tool !== 'execute'}
      />
    )
  }
  return null
}

/** 一行式过程条目：图标 + 中文名 + 目标；running 时展示实时写入预览，详情默认折叠点击展开 */
/** 工具中文标签 → 进行时文案（running 状态下跟在名字后面的动词） */
function doingLabel(name: string): string {
  switch (name) {
    case '思考': return '正在思考'
    case '读取': return '正在读取'
    case '写入': case '编辑': case '应用补丁': return '正在写入'
    case '查找文件': case '搜索内容': case '代码搜索': return '正在搜索'
    case '终端': case '执行': return '正在执行'
    case '抓取网页': case '网络搜索': return '正在查询'
    case '子任务': return '正在执行子任务'
    case '待办清单': return '正在整理任务'
    case '提问': return '等待回答'
    default: return '进行中'
  }
}

function StepLine({
  icon,
  name,
  target,
  status,
  preview,
  body,
  stats,
  spin = true
}: {
  icon: ReactNode
  name: string
  target?: string
  status: string
  preview?: string
  body?: ReactNode
  /** 写入类工具的整轮增减行数（+ 绿 / - 红） */
  stats?: { additions: number; deletions: number }
  /** running 时图标位是否转圈：终端类长跑命令不转，避免看起来像一直加载 */
  spin?: boolean
}) {
  const [open, setOpen] = useState(false)
  const expandable = !!body
  const running = status === 'running'
  const previewRef = useRef<HTMLPreElement>(null)

  // 预览内容增长时自动滚到底
  useEffect(() => {
    const el = previewRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [preview])

  return (
    <div className={'step' + (open ? ' open' : '') + (running ? ' running' : '')}>
      <button
        type="button"
        className="step-sum"
        disabled={!expandable}
        onClick={() => expandable && setOpen((v) => !v)}
      >
                <span className="step-icon">{running && spin ? <LoaderCircle size={13} className="spin" /> : icon}</span>
        <span className="step-name">{name}</span>
        {running && <span className="step-doing">{doingLabel(name)}</span>}
        {target && (
          <span className="step-target" title={target}>
            <span className="step-target-text">{target}</span>
            {stats && (stats.additions > 0 || stats.deletions > 0) && (
              <span className="step-stat" title={`新增 ${stats.additions} 行 · 删除 ${stats.deletions} 行`}>
                {stats.additions > 0 && <span className="d-add">+{stats.additions}</span>}
                {stats.deletions > 0 && <span className="d-del">-{stats.deletions}</span>}
              </span>
            )}
          </span>
        )}
        {status === 'error' && <AlertCircle size={13} className="step-err" />}
        {expandable && <ChevronDown size={13} className={'step-chev' + (open ? ' up' : '')} />}
      </button>
      {running && preview && (
        <div className="step-preview">
          <pre ref={previewRef} className="step-preview-code">
            {preview}
          </pre>
          <span className="caret" />
        </div>
      )}
      {open && <div className="step-body">{body}</div>}
    </div>
  )
}

/** 展开详情代码块：diff 着色 / highlight.js 语法高亮 / 纯文本 */
function CodeBlock({ text, file, diff }: { text: string; file?: string; diff?: boolean }) {
  if (diff) {
    return (
      <pre className="step-code">
        {text.split('\n').map((l, i) => (
          <span key={i} className={l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : undefined}>
            {l}
            {'\n'}
          </span>
        ))}
      </pre>
    )
  }
  let html = escapeHtml(text)
  try {
    const lang = file ? extLang(file) : undefined
    if (text.length < 20000) {
      html = lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value
    }
  } catch {
    /* 高亮失败回退纯文本 */
  }
  return (
    <pre className="step-code">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}
