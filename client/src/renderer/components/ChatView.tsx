import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { WebviewTag } from 'electron'
import hljs from 'highlight.js/lib/common'
import {
  AlertCircle, ArrowDown, ArrowLeft, ArrowRight, Brain, Bot, Check, ChevronDown, ChevronRight, Copy, Cpu, FileDiff as FileDiffIcon, FilePlus, FileText,
  Film, Folder, Globe, Braces, Regex, HelpCircle, Info, Keyboard, ListChecks, LoaderCircle, MessageCircle, MessageCircleOff, Minus, Monitor, MousePointerClick, Music, Paperclip, Pencil, RotateCw, Search, Send, Sparkles,
  Square, Star, Terminal, Trash2, Wrench, X
} from 'lucide-react'
import { oc, ATTACH_CTX_PREFIX, BROWSER_CTX_PREFIX, MEMORY_PREFIX, MODEL_DEFAULTS, MODEL_ROLE_LABEL, PLATFORM_PROVIDER_ID, SERVICE_CTX_PREFIX, SERVICE_RULES, hasFreeSource, isGoEndpoint, isKernelTransportError, isScheduleSession, defaultThinkingValue, fmtYmd, genRoleOf, hasGenModel, isGenIntent, thinkingKindOf, type Attachment, type FileDiff, type MessageView, type ModelSel, type Part, type PermissionAsk, type PtySession, type QnProc, type QuestionAsk, type Session, type SettingsCfg, type ThinkingMode } from '../oc'
import { load, save } from '../store'
import { t } from '../i18n'
import type { Modality, ModelAuthAsk, ModelAuthScope, ModelCfg, ModelUsed, ProviderCfg } from '../../../electron/main/types'
import { ModelPicker, type ModelGroup } from './ModelPicker'
import { AccessPicker, ProjectPicker } from './ProjectPicker'
import { ThinkingPicker } from './ThinkingPicker'
import { Modal } from './Modal'
import { Markdown } from './Markdown'
import type { TitleInfo } from './Titlebar'
import type { Project } from './Sidebar'

interface Props {
  project?: Project
  projects: Project[]
  sessionId: string
  /** 当前会话的列表条目（标题与创建时间）：顶部条靠它判断是不是计划会话并显示日期 */
  session?: Session
  model: string
  onModelChange: (key: string) => void
  settings: ProviderCfg[]
  /** 设置已加载完成（区分"提供商还没加载"与"真的没有提供商"，防止启动时清掉存档模型） */
  settingsReady: boolean
  /**
   * 主进程那边把设置改过了（同步了 opencode 限免清单），回读刷新模型列表。
   * 与「保存设置」不同：那边已经写过盘、必要时也重启过内核，这里只更新内存态。
   */
  onSettings?: (s: SettingsCfg) => void
  /** 草稿首发：内核会话此刻才创建 */
  onDraftCreated: (s: Session) => void
  onRefreshSessions: () => void
  /** 上报某会话的处理中状态（多任务并行互不覆盖），侧栏任务行据此显示/移除加载图标 */
  onBusy: (sid: string, running: boolean) => void
  /** 自增信号：点 + / 点任务时自动聚焦输入框 */
  focusSignal: number
  /** 跳转到设置页并定位到「模型」那一页（模型选择器里的「配置模型」） */
  onOpenSettings?: () => void
  /** 点击左端项目文件夹：弹出系统选目录对话框 */
  onPickDir: () => void
  /** 切换当前激活项目（点击左侧项目下拉中的某项） */
  onSwitchProject: (id: string) => void
  /** 全局访问权限档位（聊天「选择文件夹」下方选择，全局生效） */
  access: 'default' | 'full'
  onAccess: (level: 'default' | 'full') => void
  /** 标题栏「内置浏览器」按钮的触发计数（App 转发，每点一次 +1） */
  browserToggleSignal: number
  /** 浏览器打开时标题栏最大化按钮的触发计数（App 转发，用于面板放大/还原） */
  browserMaxSignal: number
  /** 上报代码审查面板开合（App 据此在代码模式放宽对话列最小宽） */
  onReviewUi?: (s: { open: boolean }) => void
  /** 纯写代码模式：关闭并隐藏内置浏览器、权限与思考入口 */
  codeMode: boolean
  /** 是否显示左侧「-」用户消息导航锚点条（设置 → 通用里开，默认关；上下文压缩由内核自动做） */
  showUserAnchors?: boolean
  /** 上报浏览器面板开合与放大状态（标题栏浏览器按钮与最大化按钮据此决定行为与图标） */
  onBrowserUi: (s: { open: boolean; max: boolean }) => void
  /** 上报会话标题（首条用户信息；计划会话带标记与日期），由 App 转发到标题栏绘制 */
  onHead: (t: TitleInfo | null) => void
}

/** 'pid/mid' → ModelSel；'' → 跟随内核默认 */
function parseModel(key: string): ModelSel | undefined {
  if (!key) return undefined
  const i = key.indexOf('/')
  return { providerID: key.slice(0, i), modelID: key.slice(i + 1) }
}

/** 「仅上下文」注入消息（项目记忆 / 浏览器页面上下文 / 附件说明 / 服务进程约定）：AI 可见、界面不渲染 */
function isCtxOnly(txt: string): boolean {
  return (
    txt.startsWith(MEMORY_PREFIX) ||
    txt.startsWith(BROWSER_CTX_PREFIX) ||
    txt.startsWith(ATTACH_CTX_PREFIX) ||
    txt.startsWith(SERVICE_CTX_PREFIX)
  )
}

/** 浏览器收藏条目：URL 去重；title 取页面标题，拿不到时用域名兜底 */
type Bookmark = { url: string; title: string }

/** 从 URL 提取主机名做收藏显示名兜底；解析失败退回原串 */
function hostOf(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return u
  }
}

/** 两个地址是否同一个页面（忽略末尾斜杠与 #hash），拿不到当前地址时按不同处理 */
function samePage(a: string | undefined, b: string): boolean {
  if (!a) return false
  const norm = (s: string) => s.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 会话中断的识别：助手消息自带错误（非用户主动中止），或回合结束时还残留 running/pending 的工具调用（半截截断）。
 *  running/pending 工具 = 任务没真正跑完（即便已有半截文本，工具还在排队/执行中，回合未结束）；
 *  用户主动中止（MessageAbortedError）不自动续跑，交给界面上的手动重试。 */
function isAbortedAssistant(m: MessageView): boolean {
  const err = (m.info as unknown as { error?: { name?: string } }).error
  if (err) return err.name !== 'MessageAbortedError'
  return m.parts.some((x) => x.type === 'tool' && (x.state?.status === 'running' || x.state?.status === 'pending'))
}

/**
 * 空壳助手消息：内核建了这一条，却**什么都没产出**（没有正文/思维链/工具，也没有 error，
 * 更没有 time.completed）。
 *
 * 实测形态：模型请求中途断掉（上游连接被切、响应没回来），内核留下一条空消息就收工。
 * 它既没有 error 字段（→ 错误条不显示），也没有残留 running 工具（→ isAbortedAssistant 判 false），
 * 界面于是**完全静默**：AI 那边「突然就结束了」，用户既看不到原因、也没有任何重试入口，
 * 只能自己手动发一句「继续」。这里把它并进「中断」判定，走同一套提示 + 重试。
 *
 * 只在**会话已经空闲**时判定才安全：正在跑的那一轮，助手消息本来就是先建空壳再填内容。
 */
function isEmptyTurn(m: MessageView): boolean {
  if (m.info.role !== 'assistant') return false
  const info = m.info as unknown as { error?: { name?: string }; time?: { completed?: number } }
  if (info.error) return false
  if (info.time?.completed) return false
  return !m.parts.some((x) => x.type !== 'step-start' && x.type !== 'step-finish')
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

/** 内核 todo 清单项（opencode todo.updated 事件） */
interface TodoItem {
  content: string
  status: string
  priority?: string
}

/**
 * 上游错误原文（错误条直接展示）。
 *
 * **不翻译、不改写**（2026-10-14 用户定版：「上游错误是什么就输出什么，有错误是结束。让用户看到就行了。」）。
 * 早先这里有一整套 humanizeError 关键词映射（限流/额度/TLS/中断… → 各一句中文建议），
 * 现在全部删掉：那些改写会**丢掉上游原文里的关键信息**（错误码、端点返回的细节、
 * request id），用户要复制给上游排查时只能复制到一句二手中文。
 * 上游返回什么就显示什么，够短就全显示，很长才截断（免得撑爆布局）。
 */
function humanizeError(raw: string): string {
  if (!raw) return ''
  return raw.length > 400 ? raw.slice(0, 400) + '…' : raw
}

/** 助手消息自带的失败原因：session.error 事件偶尔漏推，这是「这轮为什么空了」的唯一兜底展示 */
function msgErrorText(m: MessageView): string {
  const e = (m.info as unknown as { error?: { name?: string; data?: { message?: string }; message?: string } }).error
  if (!e) return ''
  return humanizeError(e.data?.message ?? e.message ?? e.name ?? '')
}

/**
 * 回合收尾对账：拉一次 /message，把「只写进内核日志、没走事件」的失败补到界面上。
 *
 * 背景（2026-09-27 实测）：内核把大量断流/上游错误只写进 opencode.log 的
 * `message=process error=`（unknown certificate verification / Rate limit exceeded /
 * Bad Request / Aborted 等），**session.error 事件经常不发**。于是界面表现为
 * 「AI 吐了半截就静默停住」——什么都没有，也没有重试入口。
 *
 * 这里做的两件事，都只在「错过了事件」时兜底，不重复事件已经处理过的路径：
 *  1. 末尾助手消息带 error（msgErrorText 非空）→ 补一条红色错误条；
 *  2. 末尾是中断风格（空壳 / 残留半截工具 / 非用户主动中止）→ 补一次中断重试提示。
 * dir 若传 undefined（非当前会话 / 手机会话）就交给调用方已经定位好的实例目录。
 */
function turnErrorOf(list: MessageView[]): { message?: string; aborted?: 'retry' } | null {
  const last = list[list.length - 1]
  if (!last || last.info.role !== 'assistant') return null
  const em = msgErrorText(last)
  if (em) return { message: em }
  if (isAbortedAssistant(last) || isEmptyTurn(last)) return { aborted: 'retry' }
  return null
}

export function ChatView(p: Props) {
  const [msgs, setMsgs] = useState<MessageView[]>([])
  const [input, setInput] = useState('')
  /** 待发送附件（回形针选的图片/视频）：随下一条消息一起发；处理中禁止上传与发送附件 */
  const [atts, setAtts] = useState<Attachment[]>([])
  /** 思考档位按模型记忆（跟随所选模型）：value = thinkMap[当前模型] ?? 默认；切模型读各自的记忆。
   *  **没有「不传思考参数」这种状态**：只有开关的模型默认「开」（on），固定档的默认「该档」，
   *  用户可随时自己切。
   *  档位集合由用户在配置里为该模型选的 `思考形态`（ModelCfg.thinking）决定：不支持 → 禁用；
   *  关/开 → 「关 / 开」（默认开）；低/中/高 → 「低 / 中 / 高」（默认配置档）。
   *  旧 localStorage 存档的档位名不属于当前集合时按**语义**回落（分档 ← 老「开」→ 配置档；← 老「关」→ 低）。 */
  const [thinkMap, setThinkMap] = useState<Record<string, string>>(() => load('qingniao.thinkMap', {}))
  // 当前模型的思考形态：取配置里为该模型选的 thinking，缺省按「关/开」
  const thinkMode: ThinkingMode = (() => {
    const i = p.model.indexOf('/')
    if (i <= 0) return 'toggle'
    const m = p.settings.find((x) => x.id === p.model.slice(0, i))?.models.find((x) => x.id === p.model.slice(i + 1))
    return m?.thinking ?? 'toggle'
  })()
  const thinkKind = thinkingKindOf(thinkMode)
  const thinkVal = (() => {
    const fallback = defaultThinkingValue(thinkMode)
    if (thinkKind === 'off') return ''
    const stored = thinkMap[p.model]
    if (thinkKind === 'toggle') return stored === 'none' ? 'none' : 'on'
    if (stored === 'low' || stored === 'medium' || stored === 'high' || stored === 'xhigh' || stored === 'max') return stored
    // 上一次记的是开关型的值：搬成语义等价档位（开→配置默认档，关→低）
    if (stored === 'none') {
      return fallback === 'low' || fallback === 'medium' || fallback === 'high' || fallback === 'xhigh' || fallback === 'max'
        ? 'low'
        : fallback
    }
    return fallback
  })()
  const thinkRef = useRef(thinkVal)
  thinkRef.current = thinkVal
  function setThinkSel(v: string) {
    setThinkMap((prev) => {
      const next = { ...prev, [p.model]: v }
      save('qingniao.thinkMap', next)
      return next
    })
  }
  /** 处理中的会话集合：可能多任务并行（A 在跑，切去 B 又发一轮），每个会话独立记账 */
  const [busySet, setBusySet] = useState<Record<string, boolean>>({})
  // 执行中每秒跳一次表（只当刷新信号用）：已用时按本轮真实开始时间算，见 busySince
  const [, tick] = useState(0)
  const [error, setError] = useState('')
  /**
   * 内核是否就绪。**false 时只禁用输入，不显示任何提示**（2026-10-14 用户定版）。
   *
   * 内核冷启动要几秒、保存设置/切权限档位后还要重启几秒，这些窗口里任何请求都必然失败。
   * 早先的做法是把 503「内核未启动」原样弹成红色错误条——用户原话「显示错误太垃圾了」：
   * 它既不是用户的错、也不能靠用户做什么解决，几秒后自动就好了。所以只禁用输入，其余什么都不说。
   */
  const [kernelReady, setKernelReady] = useState(true)
  /** 中性提示（非失败）：如「已切到能看图的模型」，同样落在对话流末尾，可手动关掉 */
  const [notice, setNotice] = useState('')
  /** 每个会话独立的任务队列：切走保留、切回还在，只消费当前视图会话的队列 */
  const [queues, setQueues] = useState<Record<string, string[]>>({})
  const curQueue = p.sessionId ? (queues[p.sessionId] ?? []) : []
  const [qCollapsed, setQCollapsed] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  // 滚轮上滑后这段时间内屏蔽「重新吸底」，防程序化滚动事件把用户位置抢回去
  const wheelUpMuteUntilRef = useRef(0)

  const dirRef = useRef<string | undefined>(p.project?.path)
  const sidRef = useRef(p.sessionId)
  const texts = useRef<Map<string, string>>(new Map())
  const toolRaw = useRef<Map<string, string>>(new Map())
  const roles = useRef<Map<string, 'user' | 'assistant'>>(new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const cwrapRef = useRef<HTMLDivElement>(null)
  // 本轮发送前已存在的消息 id：用于判断本轮是否已开始产出
  const turnBase = useRef<Set<string>>(new Set())
  // 正在执行的 prompt：断网时自动暂停，网络恢复后自动重发（sid + 原文 + 附件）
  const inflight = useRef<{ sid: string; text: string; atts?: Attachment[] } | null>(null)
  // 已发送消息的历史：Ctrl+Z 逐条回看、Ctrl+Y 前进；histPos == length 表示在草稿态
  const hist = useRef<string[]>([])
  const histPos = useRef(0)
  const draftRef = useRef('')
  // 打字机：partID → 已吐出的字符数；ticker 定时器；被插队的队列项下标
  const shown = useRef<Map<string, number>>(new Map())
  const ticker = useRef<number | null>(null)
  // 草稿首发创建的会话：跳过一次历史重载，避免闪掉乐观插入的用户消息
  const justCreated = useRef('')
  // 写入/编辑进行中的内容预览（partID → 已流出的文件内容）
  const [previews, setPreviews] = useState<Record<string, string>>({})
  // 本轮开发任务清单（todo.write / todo.updated 事件驱动，完成项中划线）
  const [todos, setTodos] = useState<TodoItem[]>([])
  // 内核 question 工具的待答问题（事件 + busy 轮询双通道，阻塞等待用户应答）
  const [asks, setAsks] = useState<QuestionAsk[]>([])
  /**
   * 内核的权限询问（`permission.asked`）：默认权限档位下，AI 要改文件/执行命令时
   * 内核会阻塞在这里等用户点允许。多条时只弹最前一条（一次问一件事，别堆叠弹窗）。
   *
   * 与 asks（助手提问）分开存：两者语义不同、回复端点也不同，混在一个队列里
   * 会出现「拿 question 的 id 去答 permission」这种错配。
   */
  const [perms, setPerms] = useState<PermissionAsk[]>([])
  /**
   * 「AI 要调用**其他**模型」的授权卡（识图 / 桌面代看 / 生图 / 生视频 / 配音 / 音乐 / 听写）。
   *
   * 与 perms、asks 三足鼎立、**互斥显示**：这类卡片背后是主进程挂着的那个 MCP 调用，
   * 用户在作答前那次识图/出图就一直等着，所以必须浮在最上层且不能被别的弹窗盖住。
   */
  const [modelAsks, setModelAsks] = useState<ModelAuthAsk[]>([])
  /**
   * 本轮（一次发送 → 回合结束）真正调用过的额外模型。
   * 回合结束时挂到本轮最后一条 AI 回复下方——用户要能一眼看到「这条回答背后动用了哪些模型」。
   * 用 ref 累计、回合结束再落盘：事件是流式来的，逐条 setState 会让整棵树每来一次就重渲。
   */
  const turnModels = useRef<ModelUsed[]>([])
  /** 已结束回合的模型用量：助手消息 id → 那一轮用过的额外模型 */
  const [usedByMsg, setUsedByMsg] = useState<Record<string, ModelUsed[]>>({})
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
  /** 用户点停止的时刻（会话 → 时间戳）：轮询兜底重认领只认「停止动作之后」的 running 工具。
   *  内核重启/中止遗留的 running part 是上一轮的残骸，没有这条基线会把它们误判成活轮 */
  const userStopMarks = useRef<Map<string, number>>(new Map())
  // 各 busy 会话所属项目路径：多项目并行时停止/重试都要带 directory，否则内核找不到该会话
  const busyDir = useRef<Record<string, string | undefined>>({})
  // 各 busy 会话本轮开始时间：「已用时」按它起算，切走再切回不会从头计
  const busySince = useRef<Record<string, number>>({})
  // 已拉到的整轮文件差量：用户消息 id → 差量列表（工具行据此显示 +N/-M，展开显示差量代码）
  const [diffs, setDiffs] = useState<Record<string, FileDiff[]>>({})
  const diffsBusy = useRef<Set<string>>(new Set())
  // 本会话由 AI 启动的常驻服务（底部工具行入口展示/停止；登记与对账在主进程 procstore）
  const [svcProcs, setSvcProcs] = useState<QnProc[]>([])
  // 底部工具行「服务进程」入口的展开面板：点图标开合，点外面收起
  const [svcOpen, setSvcOpen] = useState(false)
  const svcWrapRef = useRef<HTMLDivElement>(null)
  // 已解析登记过 QN_SERVICE_PID 的工具 part：part.updated 对同一 part 可能多次推送，防重复登记
  const svcParsed = useRef<Set<string>>(new Set())
  // 已注入过「服务进程约定」的会话：每会话只注一次（新会话/老会话首轮都会走到）
  const svcCtxSids = useRef<Set<string>>(new Set())

  // ---------- 浏览面板 ----------
  // 面板的**可见性只由用户点击决定**：AI 调浏览器工具不弹面板，但 webview 一直活着，
  // AI 照常能导航、读元素、点、输入。分开两件事：panelBorn 管 webview 挂没挂（挂上就不卸），
  // panelOpen 管用户看不看得见。
  /** webview 是否已挂载：用户点开过、或 AI 首次调浏览器工具时置 true，此后不再复位 */
  const [panelBorn, setPanelBorn] = useState(false)
  /** 面板是否可见：只有用户点标题栏按钮/点对话里的链接/进浏览模式才会置 true */
  const [panelOpen, setPanelOpen] = useState(false)
  const [browserMax, setBrowserMax] = useState(false)
  /** 右侧「代码审查」面板是否可见：列出本会话被 AI 改到的文件（+N/-M），点开可看差量/全文 */
  const [reviewOpen, setReviewOpen] = useState(false)
  /**
   * 窗口整体宽度是否够宽（≥1308）。窄于此值时输入行的模型名只显示 / 后的短名：
   * 全名（provider/model 长串）会把输入行右侧的思考、发送挤到窗口边缘外，
   * 短名与代码模式/浏览器面板同款规则（shortModelName）。
   */
  const [winWide, setWinWide] = useState(() => window.innerWidth >= 1308)
  useEffect(() => {
    const onResize = () => setWinWide(window.innerWidth >= 1308)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  /** 放大时右下角浮动聊天卡是否展开 */
  const [floatOpen, setFloatOpen] = useState(false)
  /** 全屏时彻底隐藏 AI 对话：浮动卡收起 + 右下角气泡一并消失（打游戏等完全不需要对话的场景） */
  const [chatHidden, setChatHidden] = useState(false)
  /** 面板当前页 URL（含用户手输导航，BrowserPanel 回传）：浏览器对话的上下文锚点 */
  const [panelUrl, setPanelUrl] = useState('')
  /** 浏览器收藏夹：地址栏星标收藏 / 取消，全屏时顶部收藏条展示（localStorage 持久化） */
  const [marks, setMarks] = useState<Bookmark[]>(() => load<Bookmark[]>('qingniao.bookmarks', []))
  /** 已注入的浏览器上下文（会话 + URL + 是否全屏）：没变过就不再重复注入，避免每条消息都塞一份 */
  const browserCtxRef = useRef<{ sid: string; url: string; max: boolean } | null>(null)
  /** 浮动聊天卡位置：距窗口右/下边缘的偏移（px），窗口缩放后仍保持相对位置；null = 默认右下角 */
  const [floatPos, setFloatPos] = useState<{ r: number; b: number } | null>(() => {
    const v = load<{ r: number; b: number } | null>('qingniao.floatPos', null)
    // 存档可能来自更大的窗口：夹回当前视口，保证拖拽条摸得着；旧版 x/y 坐标直接弃用走默认位
    if (!v || typeof v.r !== 'number' || typeof v.b !== 'number') return null
    return {
      r: Math.max(8, Math.min(v.r, window.innerWidth - 40)),
      b: Math.max(8, Math.min(v.b, window.innerHeight - 40))
    }
  })
  const mainRef = useRef<HTMLElement | null>(null)
  /** 右下角对话气泡位置：距窗口右/下边缘的偏移（px），窗口缩放后仍保持相对位置；null = 默认右下角 */
  const [fabPos, setFabPos] = useState<{ r: number; b: number } | null>(() => {
    const v = load<{ r: number; b: number } | null>('qingniao.fabPos', null)
    if (!v || typeof v.r !== 'number' || typeof v.b !== 'number') return null
    return {
      r: Math.max(8, Math.min(v.r, window.innerWidth - 52)),
      b: Math.max(8, Math.min(v.b, window.innerHeight - 52))
    }
  })
  const fabRef = useRef<HTMLButtonElement | null>(null)
  /** 气泡刚被拖过：松手后的 click 不再触发展开/收起 */
  const fabDragged = useRef(false)
  /** 拖拽护罩开关：拖动期间盖住 webview 等区域，把指针事件拦在主文档（OOPIF 不受主文档 pointer capture 约束） */
  const [dragShield, setDragShield] = useState(false)
  /** 标题栏中间的浏览器工具栏挂载点（Titlebar 渲染的槽位，DOM 提交后查一次） */
  const [tbSlot, setTbSlot] = useState<HTMLElement | null>(null)
  /** 用户点击要浏览器打开的链接（HTML/SVG 产物、网页地址）：面板优先导航到它，盖过 AI 的 aiBrowseUrl */
  const [pinnedUrl, setPinnedUrl] = useState('')
  /** 点击开链的计数：同一地址重复点击也强制重新导航 */
  const [pinSeq, setPinSeq] = useState(0)

  /** AI 浏览上下文里的当前地址：用户点开面板时拿它当首航目标（AI 已在 webview 里导航过则由 loadURL 同步） */
  const aiBrowseUrl = useMemo(() => {
    let url = ''
    for (const m of msgs) {
      for (const pt of m.parts) {
        if (pt.type !== 'tool') continue
        const t = (pt.tool ?? '').toLowerCase()
        // 地址栏数据源：面板浏览器（panel_*）与 playwright 工具的导航入参、输出里的当前页 URL
        if (!t.includes('browser_') && !t.includes('computer') && !t.includes('panel')) continue
        const inp = pt.state?.input as Record<string, unknown> | undefined
        if ((t.endsWith('browser_navigate') || t.endsWith('panel_navigate')) && typeof inp?.url === 'string' && inp.url) url = inp.url
        const pu = /Page URL:\s*(\S+)/.exec(pt.state?.output ?? '')
        if (pu) url = pu[1]
      }
    }
    // 桌面控制没有 URL 字段：从 AI 的回复文本里抓最后一个网址（用户让它「打开某页」的场景）。
    // 图/视频等生成媒体的直链除外：对话里已内嵌展示，不该惊动面板浏览器
    if (!url) {
      const mediaExtRe = /\.(png|jpe?g|gif|webp|bmp|avif|svg|mp4|webm|mov|m4v|avi)$/i
      for (const m of msgs) {
        if (m.info.role !== 'assistant') continue
        const text = m.parts.filter((x) => x.type === 'text').map((x) => x.text).join('')
        const ms = (text.match(/https?:\/\/[^\s"'<>\`()（），。；：、【】《》「」『』！？　一-龥]+/g) ?? []).filter((u) => !mediaExtRe.test(u.split(/[?#]/)[0]))
        if (ms.length) url = ms[ms.length - 1]
      }
    }
    return url
  }, [msgs])

  // 主进程「AI 要用面板浏览器」事件（panel_* 工具发现 webview 还没挂载时触发）：
  // 挂载 webview 并自动弹出面板——AI 首次打开网址就该让用户看到。
  useEffect(() => {
    return window.qingniao.onEvent((raw) => {
      if ((raw as { type?: string }).type !== 'qingniao.browser.wake') return
      setPanelBorn(true)
      // AI 首次打开网址自动弹面板；与右栏代码审查面板互斥，打开浏览器的同时收掉审查
      setReviewOpen(false)
      setPanelOpen(true)
    })
  }, [])

  // 对话里点击需浏览器打开的链接（Markdown 组件派发）：打开面板并导航到该地址
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const u = (e as CustomEvent).detail
      if (typeof u !== 'string' || !u) return
      setPinnedUrl(u)
      setPinSeq((n) => n + 1)
      setPanelBorn(true)
      setPanelOpen(true)
    }
    window.addEventListener('qingniao:open-in-browser', onOpen)
    return () => window.removeEventListener('qingniao:open-in-browser', onOpen)
  }, [])

  // 切会话时浏览器面板**按会话隔离**：
  //   - 给即将离开的会话拍快照（开合/放大/当前页）；
  //   - 新会话默认收起面板——浏览器属于「打开它的那个对话」，跟着会话走，
  //     否则 A 对话开的网页一直挂在 B 对话旁边，AI 的浏览上下文也会串台；
  //   - 切回开过面板的会话时原样恢复（含把 webview 导回那个会话在看的那一页）。
  // webview 本体仍全局唯一（panelBorn 不复位）：AI 随时能操作，只是可见性与导航上下文按会话切换。
  const browserBySess = useRef<Map<string, { open: boolean; max: boolean; url: string; pin: string }>>(new Map())
  const lastBrowserSess = useRef(p.sessionId)
  useEffect(() => {
    const prev = lastBrowserSess.current
    const next = p.sessionId
    if (prev === next) return
    lastBrowserSess.current = next
    browserBySess.current.set(prev, {
      open: panelOpen,
      max: browserMax,
      url: panelUrl,
      pin: pinnedUrl
    })
    // 收起 + 清上下文：新会话从「没有浏览器」开始，需要时由用户点开或 AI 的 browser.wake 弹出
    setPanelOpen(false)
    setBrowserMax(false)
    setChatHidden(false)
    setFloatOpen(false)
    setPinnedUrl('')
    setPanelUrl('')
    const saved = next ? browserBySess.current.get(next) : undefined
    if (saved?.open) {
      setPanelOpen(true)
      setBrowserMax(saved.max)
      // 恢复页面：pinSeq 自增强制 webview 导回该会话当时看的那一页（webview 可能已被别的会话导航走）
      const back = saved.pin || saved.url
      if (back) {
        setPinnedUrl(back)
        setPinSeq((n) => n + 1)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.sessionId])

  // 收藏夹落盘：状态即事实源，变化即写
  useEffect(() => {
    save('qingniao.bookmarks', marks)
  }, [marks])

  /** 审查面板数据：聚合本会话被改到的文件（同一文件跨轮合并 +N/-M，patch 取最近一轮）。
 *  与聊天工具行的徽标同源：优先工具 part 自带的 metadata（metaDiffs，写/编辑时内核随工具给出，
 *  最可靠），再并入按轮拉取的整轮 diffs 作兜底。 */
  const reviewFiles = useMemo(() => {
    const map = new Map<string, FileDiff>()
    const add = (d: FileDiff) => {
      const prev = map.get(normPath(d.file))
      if (prev) {
        prev.additions += d.additions
        prev.deletions += d.deletions
        if (d.patch) prev.patch = d.patch
        if (d.status) prev.status = d.status
      } else {
        map.set(normPath(d.file), { ...d })
      }
    }
    for (const m of msgs) {
      for (const pt of m.parts) {
        if (pt.type !== 'tool' || !isFileTool(pt.tool ?? '')) continue
        for (const d of metaDiffs(pt)) add(d)
      }
    }
    for (const uid of new Set(turnOwners(msgs).values())) {
      for (const d of diffs[uid] ?? []) add(d)
    }
    return [...map.values()].sort((a, b) => a.file.localeCompare(b.file))
  }, [diffs, msgs])

  /**
   * 「AI 调用其他模型」授权闸门的两条推送（主进程 gate.ts → IPC）：
   *   ask  —— 有 MCP 正挂着等用户点头（识图 / 桌面代看 / 生图 / 生视频 / 配音 / 音乐 / 听写）
   *   used —— 某个额外模型真的被调成功了一次，累计到本轮、回合结束时挂到那条回复下方
   *
   * 挂载即订阅、卸载即解：订阅里只碰 ref 与 setState，不带依赖，避免每次渲染重订。
   */
  useEffect(() => {
    const offAsk = window.qingniao.onModelAuth((a) => {
      setModelAsks((prev) => (prev.some((x) => x.reqId === a.reqId) ? prev : [...prev, a]))
    })
    const offUsed = window.qingniao.onModelUsed((u) => {
      turnModels.current = [...turnModels.current, u]
    })
    return () => {
      offAsk()
      offUsed()
    }
  }, [])

  /** 收藏 / 取消收藏当前页：按 URL 去重，title 为页面标题（拿不到时调用方传域名兜底） */
  function toggleMark(url: string, title: string) {
    if (!url) return
    setMarks((ms) => (ms.some((m) => m.url === url) ? ms.filter((m) => m.url !== url) : [...ms, { url, title }]))
  }

  /** 收起面板：webview 留着（AI 照常可操作），只是不再显示 */
  function closeBrowserPanel() {
    setPanelOpen(false)
    setBrowserMax(false)
    setPinnedUrl('')
    setChatHidden(false) // 面板都关了，隐藏态一起复位，别再带着回右栏布局
  }

  /**
   * 标题栏按钮：开/关内置浏览器面板（常规右栏不放大；开着就关）。
   *
   * 全屏浏览中一律不动尺寸——全屏时这一颗按钮直接不渲染（面板已占满，关它等于退出全屏），
   * 想退出全屏点标题栏的「还原」；「AI 对话」开关则挪到了地址栏右侧那颗电源图标。
   */
  function toggleBrowserFromHeader() {
    if (browserMax) return
    if (panelOpen) {
      closeBrowserPanel()
      return
    }
    setReviewOpen(false)
    setPanelBorn(true)
    setPanelOpen(true)
    setBrowserMax(false)
  }

  /** 对话右上角「代码审查」小卡片：开/关右侧审查面板；与浏览器面板互斥（都挤在右栏） */
  function toggleReview() {
    if (browserMax) return
    setReviewOpen((v) => {
      const next = !v
      if (next) closeBrowserPanel()
      return next
    })
  }

  /** 放大/还原：进入放大时自动展开右下角的浮动聊天卡 */
  function toggleBrowserMax() {
    const next = !browserMax
    setBrowserMax(next)
    if (next) setFloatOpen(true)
    // 退出全屏：连「彻底隐藏」也一并复位，回到右栏布局时对话必须可见
    else setChatHidden(false)
  }

  /**
   * 全屏时右下角那颗气泡的开关：收起/展开浮动对话卡。
   * 打游戏等不想看到对话的场景直接收起，气泡留在右下角随时唤回。
   * 与地址栏那颗电源图标是同一状态的两个入口（那个还能把气泡本身也藏掉）。
   */
  function toggleFloatFromHeader() {
    setFloatOpen((v) => !v)
    setChatHidden(false) // 手动唤回对话时，把「彻底隐藏」复位，否则气泡被藏住没法再唤回
  }

  /**
   * 全屏时地址栏右侧那颗「AI 对话」按钮：**两态开关**——
   *   隐藏：把右下角气泡 + 浮动对话卡一起收掉；再点一次：气泡 + 卡片整块复原。
   * 不做逐级收起（避免一次点一下只收一半、还要点第二下才能彻底藏干净）。
   */
  function toggleChatVisible() {
    if (chatHidden) {
      // 已整块藏掉 → 再点：把右下角的对话气泡唤回来（卡片先不展开，点气泡再展开）
      setChatHidden(false)
      setFloatOpen(false)
      return
    }
    // 有任何东西显示 → 点一下：气泡 + 浮动对话卡一起收掉
    setChatHidden(true)
    setFloatOpen(false)
  }

  /** 拖动浮动聊天卡（顶部拖拽条）：pointer capture 防止划过 webview 丢事件，松手记住位置 */
  function startFloatDrag(e: ReactPointerEvent) {
    // 点关闭按钮不启动拖拽：下面 setPointerCapture 会把松手后的 click 重定向到 header，按钮收不到
    if ((e.target as HTMLElement).closest('.float-close')) return
    const el = mainRef.current
    if (!el) return
    e.preventDefault()
    setDragShield(true)
    const rect = el.getBoundingClientRect()
    // 记指针到卡片右/下边缘的距离，拖动中反算 right/bottom——存相对窗口边缘的偏移，缩放不跑位
    const offR = rect.right - e.clientX
    const offB = rect.bottom - e.clientY
    let last = floatPos
    const move = (ev: PointerEvent) => {
      last = {
        r: Math.max(8, Math.min(window.innerWidth - ev.clientX - offR, window.innerWidth - rect.width - 8)),
        b: Math.max(8, Math.min(window.innerHeight - ev.clientY - offB, window.innerHeight - rect.height - 8))
      }
      setFloatPos(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragShield(false)
      if (last) save('qingniao.floatPos', last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  /** 拖动右下角对话气泡：挪一点位置也算拖动，松手后的 click 不触发开合 */
  function startFabDrag(e: ReactPointerEvent) {
    const el = fabRef.current
    if (!el) return
    e.preventDefault()
    setDragShield(true)
    const rect = el.getBoundingClientRect()
    const offR = rect.right - e.clientX
    const offB = rect.bottom - e.clientY
    let last = fabPos
    let moved = false
    const move = (ev: PointerEvent) => {
      moved = true
      last = {
        r: Math.max(8, Math.min(window.innerWidth - ev.clientX - offR, window.innerWidth - rect.width - 8)),
        b: Math.max(8, Math.min(window.innerHeight - ev.clientY - offB, window.innerHeight - rect.height - 8))
      }
      setFabPos(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragShield(false)
      fabDragged.current = moved
      if (moved && last) save('qingniao.fabPos', last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  dirRef.current = p.project?.path
  sidRef.current = p.sessionId

  /** 当前查看的会话是否在处理中——别的会话在跑时，这里必须是 false（不显示思考、不排队） */
  const busy = p.sessionId !== '' && !!busySet[p.sessionId]

  // 自动续跑发的「继续」不出用户气泡（历史机制，标记保留但当前无续跑入口会置 true）：
  // pending=本轮 runPrompt 是续跑发起的；ids=已确认属于续跑的真实用户消息 id（含别的会话，防止切会话漏隐藏）
  const autoContinuePending = useRef(false)
  const autoContinueIds = useRef<Set<string>>(new Set())
  /** 助手消息 → 所属用户消息 id（差量按用户消息拉，这里做渲染期的映射） */
  const turnOwner = turnOwners(msgs)
  // 最新一条助手消息：只有它身上的 running 工具是"真在跑"；更早轮次的残留 running 按中断展示，
  // 否则发新消息后旧轮还挂着加载动画、新轮又在思考，两轮状态混在一起
  const lastAid = [...msgs].reverse().find((m) => m.info.role === 'assistant')?.info.id
  const lastMsg = lastAid ? msgs.find((x) => x.info.id === lastAid) : undefined
  // 末条 AI 消息内联的错误文案：全局错误条与它相同就不再渲染（同一错误出现两遍很傻）
  const inlineErr = !busy && lastMsg ? msgErrorText(lastMsg) : ''
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
  /**
   * 不是本端发起的回合（手机扫码发来的消息、别的入口）。
   *
   * 这种回合同样要认领 busy，否则「处理中」不亮、session.idle 也会被当成无关事件跳过，
   * 整轮结束界面都不刷新。但**不能**让自动续跑去接管它：用户正在手机上驱动这条会话，
   * 电脑这边再自动重发一条就是凭空多出来的一轮。
   */
  const foreignSids = useRef<Set<string>>(new Set())
  function markBusy(sid: string, running: boolean, dir?: string, foreign = false) {
    if (!sid) return
    const next = { ...busySetRef.current }
    if (running) {
      next[sid] = true
      // 本轮开始时间：已用时的起算点（新一轮 prompt 覆盖旧值，同轮内切会话不受影响）
      busySince.current[sid] = Date.now()
      if (foreign) foreignSids.current.add(sid)
      else foreignSids.current.delete(sid)
      // 记录会话所属项目：多项目并行时停止/重试必须带同一 directory，否则内核找不到该会话。
      // 外部回合拿不到项目路径（可能是另一个项目里的会话），只有正好在本端打开时敢认，
      // 其余宁可不带路径——写错目录会让停止按钮打到别的会话上。
      const d = dir ?? (foreign ? (sid === sidRef.current ? dirRef.current : undefined) : dirRef.current)
      if (d) busyDir.current[sid] = d
    } else {
      delete next[sid]
      delete busySince.current[sid]
    }
    busySetRef.current = next
    setBusySet(next)
    onBusyRef.current(sid, running)
  }
  const busySids = () => Object.keys(busySetRef.current).filter((s) => busySetRef.current[s])

  /**
   * 工具失败熔断 —— 任务层面的**机械刹车**。
   *
   * 为什么必须有（2026-09-21 实测）：生视频被限流后，模型收到 `HTTP 429 您已达到…速率限制`
   * 并没有停，而是在 7 分钟里换提示词、换参数、换模型连续创建了 **100+ 次**，每一发都真打到服务端。
   * 工具回执写得再清楚也拦不住模型「再试一次」的惯性，所以这里在回合层面记账并直接中止本轮。
   *
   * 判据分两档（只针对「重试也没用」的失败，正常的调试循环不受影响）：
   *   配额 / 限流 / 鉴权类 —— 与请求内容无关，**第 1 次**即停；
   *   其他失败 —— 必须**同一工具 + 同一错误**连续到 3 次才停
   *   （避免误伤「命令报错 → 改代码 → 再跑」这种正常循环：报错内容一变，计数就归 1）。
   */
  const toolFails = useRef<Map<string, { n: number; sig: string }>>(new Map())
  /** 已被熔断停下的会话：抑制自动重试提示，直到用户重新发消息 */
  const halted = useRef<Set<string>>(new Set())
  /** 用户手动停止（点停止按钮）的会话：收尾对账不得自动续跑——他是亲手要停的 */
  const userStopped = useRef<Set<string>>(new Set())
  /**
   * 已收到内核流式失败（qingniao.stream.error）的会话。
   *
   * 存在的理由：这种失败**不写进助手消息**，所以轮询兜底的 `turnErrorOf` 在内核重试期间
   * 判不出失败，只能等内核收尾（最长 1 分 39 秒）。记下来让轮询知道「这轮已经废了，
   * 不用再等 session.idle」，超时直接收口。收口后即从集合移除。
   */
  const streamFailed = useRef<Set<string>>(new Set())
  /** onRefreshSessions 的最新引用（事件回调只注册一次，闭包里的 props 会过期） */
  const onRefreshRef = useRef(p.onRefreshSessions)
  onRefreshRef.current = p.onRefreshSessions

  /**
   * 硬失败特征：与请求内容无关、重试必然再失败的错误。
   *
   * 配额类写得具体（额度**不足**、配额**超出**…）而不是只匹配「额度 / 余额 / 配额」两个字：
   * 后者会把「命令输出里恰好提到额度」这种正常内容也判成硬失败，误伤面太大。
   */
  const HARD_FAIL_RE =
    /HTTP\s*429|HTTP\s*40[123]|速率限制|限流|rate ?limit|too many requests|额度不足|余额不足|配额不足|超出配额|额度已用完|insufficient_quota|quota exceeded|已自动熔断|已停止查询/

  /** 错误签名：抹掉数字与长 hex（request id / 时间戳每次都变，不归一就认不出「同一个错误」） */
  function failSignature(tool: string, text: string): string {
    const norm = text
      .replace(/\b[0-9a-f]{8,}\b/gi, '#')
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90)
    return tool + '｜' + norm
  }

  /** 中止本轮并让用户看见原因（幂等：同一会话只停一次） */
  function haltTurn(sid: string, tool: string, text: string, n: number) {
    if (!sid || halted.current.has(sid)) return
    // 手机端发起的回合不归本端管：用户在那边驱动，替他叫停反而莫名其妙
    if (foreignSids.current.has(sid)) return
    halted.current.add(sid)
    toolFails.current.delete(sid)
    markBusy(sid, false)
    oc.abort(sid, busyDir.current[sid] ?? dirRef.current).catch(() => { /* 已结束 */ })
    const why = text.replace(/\s+/g, ' ').trim().slice(0, 160)
    setError(
      t('已自动停止：工具「{tool}」连续失败 {n} 次', { tool: tool || t('未知'), n }) +
        (why ? t('（{why}）', { why }) : '') +
        t('。这类错误重试不会改变结果，所以替你叫停了——原因处理完后再发一句话即可继续。')
    )
    onRefreshRef.current()
  }

  /** 观察一次工具结果；判定卡死就中止本轮（返回 true = 已熔断） */
  function noteToolOutcome(sid: string, part: Part): boolean {
    if (!sid) return false
    const st = part.state ?? {}
    const text = String(st.error ?? st.output ?? '')
    const hard = HARD_FAIL_RE.test(text)
    if (st.status !== 'error' && !hard) {
      toolFails.current.delete(sid)
      return false
    }
    const tool = String(part.tool ?? '').toLowerCase()
    const sig = failSignature(tool, text)
    const prev = toolFails.current.get(sid)
    const n = prev && prev.sig === sig ? prev.n + 1 : 1
    toolFails.current.set(sid, { n, sig })
    if (n < (hard ? 1 : 3)) return false
    haltTurn(sid, tool, text, n)
    return true
  }

  /** 编辑用户消息后重发：把会话撤回该条之前（移除旧回复），再用新文本触发 AI 重新回复 */
  async function resendMessage(uid: string, newText: string) {
    const sid = p.sessionId
    if (!sid) return
    const dir = busyDir.current[sid] ?? p.project?.path
    setError('')
    try {
      await oc.revert(sid, dir, uid)
    } catch (e) {
      // 502/503 主进程代抛传输层故障（内核没起来或仍在跑），不报错：
      // 503 说明这轮根本不存在，直接把新文本退回输入框等内核就绪；502 则交给下面的重发兜底。
      if (isKernelTransportError(e)) {
   setKernelReady(false)
        setInput((prev) => (prev.trim() ? prev : newText))
        return
      }
    setError((t('撤回失败：') + (e instanceof Error ? e.message : String(e))).slice(0, 120))
      return
    }
    // 撤回后历史已不含被编辑的那条（若有残留本地也剔除，避免新旧重复），再重发新文本
    try {
      texts.current.clear()
      shown.current.clear()
      const list = await oc.messages(sid, dir)
      setMsgs(hydrate(list.filter((m) => m.info.id !== uid), shown.current, texts.current))
    } catch { /* 保留现状，由重发接续 */ }
    // 撤回可能带走了已注入的浏览器上下文消息：清掉记录，重发时按需重新注入
    browserCtxRef.current = null
    void runPrompt(newText, sid, dir)
  }

  /**
   * 停止**当前这一个**会话的任务：先清本地状态让界面立刻回落到可输入（不等内核回执），再向内核发中止。
   *
   * 只停当前——别的会话是用户另开的并行任务，停自己的不该顺手把别人的也掐了。
   * 队列里的消息保留：当前任务停止后队列消费 effect（本会话空闲）会自动发出队首任务，
   * 「停止」只对正在跑的这一轮生效，不打断用户排好的后续指令。
   */
  async function stopCurrent() {
    const sid = p.sessionId
    if (!sid) return
    const dir = busyDir.current[sid]
    userStopped.current.add(sid)
    // 记录停止时刻：之后到达的 running 工具快照若启动于停止之前，一律视为残骸不再续命
    userStopMarks.current.set(sid, Date.now())
    // 用户亲手停了，这一轮的流式失败标记也作废（否则下一轮会被兜底误判成"上轮废了"）
    streamFailed.current.delete(sid)
    markBusy(sid, false)
    delete busyDir.current[sid]
    // 只作废属于本会话的在途记录：别的会话那一条还活着，不能一起清
    if (inflight.current?.sid === sid) inflight.current = null
oc.abort(sid, dir).catch((e) => {
      // 502/503 是主进程代抛的传输层故障（内核仍在跑，或正在重启），不代表停止没送到，
      // 更不该弹成错误——用户点停止时看到「内核未启动」纯属倒垃圾（2026-10-14 用户定版）。
      if (isKernelTransportError(e)) return
      const msg = e instanceof Error ? e.message : String(e)
      setError(t('停止失败：') + msg.slice(0, 120))
    })
  }

  // 模型级联菜单：仅用户自建（启用）且配有模型的提供商，一级=提供商、二级=模型。
  // 平台「内置模型」的计价信息（限免/折扣/倍率）一并带过去，二级列表里要打标签、写倍率。
  //
  // 这里**只列能当对话用的模型**（生成角色为「对话」且输入含文本）：生图 / 生视频 / 语音
  // 三类模型不走对话接口，选了这轮必被端点拒绝，它们由工具在对话中按需触发——
  // 生图、生视频挂 media MCP，语音（音频）挂 tts MCP。放进候选只会让用户白选一次。
  const groups: ModelGroup[] = p.settings
    .filter((x) => x.enabled && x.id && x.models.length)
    .map((c) => ({
      id: c.id,
      label: c.name || c.id,
      // opencodeGo 是 $10/月订阅池，额度用完还能继续用它自己那几个免费模型——
      // 但那是订阅额度的一部分，不是「限免」，挂标签会让人以为是白嫖的（2026-10-13 用户定版）。
      hideFreeTag: isGoEndpoint(c.baseURL),
      models: c.models
        .filter((m) => genRoleOf(m) === 'none' && (m.input ?? MODEL_DEFAULTS.input).includes('text'))
        .map((m) => ({
          mid: m.id,
          name: m.name,
          free: m.free,
          zenFree: m.zenFree,
          discount: m.discount,
          ratio: m.ratio,
          effRatio: m.effRatio
        }))
    }))
    // 组内一个可对话模型都没有的提供商直接不显示，免得点进去是空列
    .filter((g) => g.models.length > 0)
  /**
   * **不再注入「自动」虚拟项**（2026-10-13 用户定版）：模型选择器里只列真实模型。
   *
   * 原先会在「内置模型」分组头部插一条 `{mid:'', name:'自动'}`（model 存空串 = 请求不带 model，
   * 由主进程 resolveModel 挑第一个能对话的模型）。移除的理由：
   *   1. 它不是模型，混在模型列表里容易被当成「某个模型」点中，用起来却对不上名字；
   *   2. 同一套「自动」逻辑在别处还有（见下方 useEffect：存档值失效时回落到空串），
   *      两条路径会让人搞不清当前到底是哪个在生效。
   *
   * 空串在数据层仍是合法的（**存量用户 localStorage 里存的就是空串**），但不再作为可选档位呈现，
   * 也不该长期停在这个状态——见下面那个 useEffect：现在它会立刻校正成一个真实模型。
   */

  // 文字聊天模型禁止自动切换（用户约定）：一旦选中，对话就用当前模型，端点拒绝时报错给用户手动处理，
  // 绝不在后台静默换成同提供的其他模型再自动重发「继续」。

  /**
   * 正在后台刷新计价的分组 id。
   *
   * 平台「内置模型」的限免/折扣随时会被后台改，登录那一刻的快照不足信——所以用户点开这个分组时
   * 顺手对一次。刷新是静默的：列表照旧显示旧值，回来的新值原地替换（不清空、不转整屏 loading）。
   */
  const [refreshingGroup, setRefreshingGroup] = useState('')
  async function refreshGroupPrices(id: string): Promise<void> {
    if (id !== PLATFORM_PROVIDER_ID) return
    setRefreshingGroup(id)
    try {
      // 计价刷新只改本地缓存并广播，模型增删才重启内核，这里等它一下不会打断对话
      await window.qingniao.platformRefreshModels()
    } catch {
      /* 平台不可达：继续用旧价格，不打断选择 */
    } finally {
      setRefreshingGroup('')
    }
  }

  /**
   * 用户点开模型选择器时，顺手把免费模型清单（Zen + 网关）同步一次。
   *
   * App 层已改为「每次窗口显示时自动同步」（见 App.tsx），这里是同一件事的按需补刀：
   * 窗口一直开着但清单在期间变了，点开选择器时也能拿到最新值。
   * 没同步到（网络不可达 / 上游没有免费模型）时不显示，符合「没有就不显示」。
   */
  const syncFree = useCallback(async () => {
    // 一家免费源都没配就不用发请求：各组里本来就不会有免费模型，白等一次往返
    if (!hasFreeSource(p.settings)) return
    try {
      const s = await window.qingniao.freeRefresh()
      // 主进程已落盘、并在清单有增删时重启过内核，这里只更新内存态
      p.onSettings?.(s)
    } catch {
      /* 同步失败：沿用上次快照，不打扰用户 */
    }
  }, [p.onSettings, p.settings])

  // 校正当前选中的模型，**任何情况下都不允许停在空值**。
  //
  // 背景（2026-10-13 用户定版）：模型选择器里不再提供「自动」档了，但空串在数据层仍是历史
  // 遗留——存量用户 localStorage 里存的就是空串（那是旧版「自动」档的值），新装用户也是空串。
  // 所以这里把空值**主动收敛**到第一个可用模型，而不是继续让它当隐形的「自动」用着：
  //   - 空值 → 落到 groups 里第一个能对话的模型（与主进程 resolveModel 的挑选口径一致，
  //     所以界面上看到的与实际发出去的是同一个模型）；
  //   - 非空但失效（提供商被停用/删除、模型改名）→ 同样回落到第一个可用模型。
  //
  // 关键：设置尚未加载完成时绝不能跑（此刻 groups 为空，会把用户的存档值误判失效清掉）。
  useEffect(() => {
    if (!p.settingsReady || !groups.length) return
    const valid = (() => {
      const i = p.model.indexOf('/')
      return i > 0 && groups.some((g) => g.id === p.model.slice(0, i) && g.models.some((m) => m.mid === p.model.slice(i + 1)))
    })()
    if (valid) return
    // 第一个分组的第一条即「默认」：分组顺序是 chatProviders 定的（平台内置在前、官方端点在后）
    const fallback = groups[0].models[0]
    if (fallback && fallback.mid) p.onModelChange(`${groups[0].id}/${fallback.mid}`)
  }, [p.model, p.settings, p.settingsReady, groups.length])  // 切换项目/会话：先清旧内容再拉历史（项目切换瞬间 sessionId 为空）
  useEffect(() => {
    if (justCreated.current && justCreated.current === p.sessionId) {
      justCreated.current = ''
      return
    }
    texts.current.clear()
    toolRaw.current.clear()
    shown.current.clear()
    // 切会话：未认领的续跑标记作废，避免把下个会话的用户消息误隐藏
    autoContinuePending.current = false
    // 切任务/切项目：上一条失败反馈与切换提示都属于旧对话，不能跟过来
    setError('')
    setNotice('')
    setPreviews({})
    setTodos([])
    setAsks([])
    if (!p.sessionId) {
      setMsgs([])
      setInput('')
      return
    }
    const sid = p.sessionId
    // 切进的会话可能有早已发出的待答问题（asked 事件不会再补发），只能拿内核待答列表对账，否则永远没卡片
    let askAlive = true
    oc.questions(p.project?.path)
      .then((list) => {
        if (!askAlive) return
        const mine = (Array.isArray(list) ? list : []).filter((x) => x.sessionID === sid && !replyingRef.current.has(x.id))
        if (mine.length) setAsks(mine)
      })
      .catch(() => {})
oc.messages(p.sessionId, p.project?.path)
      .then((list) => {
      if (!askAlive) return
      setMsgs(hydrate(list, shown.current, texts.current))
    })
      .catch((e) => {
        // 内核没起来（502/503）不报错：切会话恰好撞上内核重启是常事，
        // 弹一条「内核未启动」纯属噪音，输入框禁用着等它回来就行（kernelReady）。
        if (askAlive && !isKernelTransportError(e)) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      askAlive = false
    }
  }, [p.sessionId, p.project?.path])

  // 面板开着时点外面（面板与触发图标以外）收起：与 ProjectPicker/AccessPicker 同一套交互
  useEffect(() => {
    if (!svcOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!svcWrapRef.current?.contains(e.target as Node)) setSvcOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [svcOpen])

  // 本会话服务进程：切换会话即拉取；有进程时每 8 秒轮询——存活对账在主进程
  // procList 里做（外部关掉/重启后已死的会被清掉，这里拿到列表直接渲染即自动消失）
  useEffect(() => {
    const sid = p.sessionId
    if (!sid) {
      setSvcProcs([])
      return
    }
    let alive = true
    const pull = (): void => {
      window.qingniao.procList(sid)
        .then((l) => {
          if (alive) setSvcProcs(l)
        })
        .catch(() => {})
    }
    pull()
    const timer = window.setInterval(pull, 8000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [p.sessionId])

  /** 停止本会话的一个服务进程（含子进程树），主进程返回删除后的最新清单 */
  function stopProc(pid: number): void {
    const sid = sidRef.current
    if (!sid) return
    window.qingniao.procKill(sid, pid).then(setSvcProcs).catch(() => {})
  }

  // 订阅内核事件：token 级增量 + part 快照 + 会话空闲
  useEffect(() => {
    const off = window.qingniao.onEvent(async (raw) => {
      const e = raw as { type: string; properties: Record<string, unknown> }
      if (e.type === 'qingniao.kernel.state') {
        // 内核就绪状态变化（主进程 adapter 在 start/stop 时广播）。
        // 只切输入框的禁用态，**不弹任何提示**——内核重启是后台的常规动作，用户不需要被打扰。
        const pr = e.properties as { ready?: boolean }
        const ready = pr.ready !== false
        setKernelReady(ready)
        if (ready) {
          // 内核回来了：把「因为它不在」而作废的收尾状态清掉，
          // 否则上一轮留下的 streamFailed 标记会让轮询兜底误判（见 streamFailed 注释）。
          streamFailed.current.clear()
        }
        return
      }
if (e.type === 'qingniao.stream.error') {
        // 主进程 tail 内核日志转发的**流式失败**（见 electron/main/logtail.ts）。
        // 内核失败只写日志：既不推 session.error，也不会立刻把 error 写进助手消息，
        // 而是按退避策略继续重试（实测最多 6 次、间隔递增、累计 1 分 39 秒）。
        //
        // 用户定版（2026-10-14）：**上游错误原文直接显示，有错误就结束**——
        //   1. 原文写进对话流（setError → 红色错误条，落在 AI 回复末尾），不翻译不改写；
        //   2. 立刻 abort 收掉这个回合，不让内核把 6 次重试跑完、也不让用户对着转圈干等。
        //
        // 走对话流而不是右上角浮层：错误是这一轮回复的一部分，
        // 留在对话里能跟着会话一起被看到、复制、留存，浮层 9 秒就没了。
        const pr = e.properties as { sessionID?: string; message?: string; providerID?: string; modelID?: string }
        if (!pr.message) return
        // 用户自己刚点过停止的会话不再提示：停止按钮本身就是反馈，再报一次错只会让人困惑
        if (pr.sessionID && userStopped.current.has(pr.sessionID)) return
        const text = humanizeError(pr.message)
        const sid = pr.sessionID
        if (!sid) {
          // 拿不到会话（异常日志行）：没有可abort 的对象，只能显示
          setError(text)
          return
        }
        // **只要这一轮在跑就收口**，不区分是不是当前会话：
        // 「有错误是结束」意味着不再等内核把重试队列跑完。早先只收当前会话，
        // 切走的那些会话会在后台继续重试 1 分 39 秒（用户回来看见仍在转圈）。
        if (busySetRef.current[sid]) {
          markBusy(sid, false)
          const dir = busyDir.current[sid] ?? (sid === sidRef.current ? dirRef.current : undefined)
          delete busyDir.current[sid]
          if (inflight.current?.sid === sid) inflight.current = null
          // 记一笔：万一 abort 送不到、或 busy 被别的路径重置，轮询兜底还要能收口
          streamFailed.current.add(sid)
          oc.abort(sid, dir).catch(() => {
            /* 传输层失败无所谓：busy 已清，界面不会卡在处理中 */
          })
        }
        // 只往当前会话的错误条里写：切走的那条等用户切回去时由轮询兜底/收尾对账补上，
        // 不往这儿的对话流里塞别的会话的错。
        if (sid === sidRef.current) setError(text)
      } else if (e.type === 'session.busy') {
        // 手机发来的回合：busy 事实由 relay.markBusy 注入事件桥，这里立即认领/释放——
        // 不等内核出 delta（部分 provider 只发 heartbeat），让「处理中」/停止按钮即时亮起。
        const pr = e.properties as { sessionID?: string; busy?: boolean }
        const sid = pr.sessionID
        if (!sid) return
        markBusy(sid, pr.busy === true, undefined, true)
      } else if (e.type === 'message.updated') {
        const info = e.properties.info as MessageView['info'] | undefined
        if (!info) return
        roles.current.set(info.id, info.role)
        // 续跑的「继续」：真实用户消息到达即记为隐藏，并消费一次待认领标记
        if (info.role === 'user' && info.sessionID === sidRef.current && autoContinuePending.current) {
          autoContinuePending.current = false
          autoContinueIds.current.add(info.id)
        }
      } else if (e.type === 'message.part.delta') {
        const pr = e.properties as { sessionID: string; messageID: string; partID: string; field: string; delta: string }
        // 手机扫码发起的回合：本端不是发起者，busy 只能从事件里认领。
        // 认领了才会显示「处理中」、才会跑流式兜底轮询、session.idle 才不会被跳过。
        // delta 只属于助手消息（用户消息是整段快照），所以不会把「我刚发的话」误判成在跑。
        if (pr.sessionID && !busySetRef.current[pr.sessionID]) markBusy(pr.sessionID, true, undefined, true)
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
        // 失败熔断放在会话过滤**之前**：别的会话在跑（切走之后）同样要能被刹住
        if (part.type === 'tool' && part.state && part.state.status !== 'running' && part.state.status !== 'pending') {
          if (noteToolOutcome(part.sessionID, part)) return
        }
        // 轮次活性重认领：渲染层的同步 prompt 可能已经异常返回（代理故障 / 更早的自动停熔断清了 busy），
        // 但内核那轮还活着——只要 running 的工具 part 还在流进来，就证明「还在跑」：
        // 重新认领 busy，让「处理中」行与停止按钮回来。否则工具行永远转圈、用户却没有停止入口
        // （2026-09-29 实测：429 限流后 check_video 连着轮询了 5 分钟，busy 被清后停止按钮就没了）。
        // 只认「停止动作之后启动」的 running 工具：中止/内核重启残留的 running part 是上一轮残骸，
        // 没有这条时间基线会把它们误认成活轮，busy 永远清不掉、停止按钮常驻。
        if (part.type === 'tool' && part.state?.status === 'running' && part.sessionID && !busySetRef.current[part.sessionID]) {
          const s = part.sessionID
          const mark = userStopMarks.current.get(s)
          const startedAt = typeof part.state?.time?.start === 'number' ? part.state.time.start : Infinity
          if (mark != null && (startedAt === Infinity || startedAt <= mark)) return // 停止前的残骸（或无法判定启动时刻），不续命
          const foreign = s !== sidRef.current && !busyDir.current[s]
          markBusy(s, true, busyDir.current[s] ?? (s === sidRef.current ? dirRef.current : undefined), foreign)
        }
        // 服务进程登记：终端工具完成后从输出里解析约定的 QN_SERVICE_PID 回显（启动约定见
        // SERVICE_CTX 注入）。放在会话过滤**之前**：用户切走会话的瞬间，这个会话启动的服务也不能漏登记。
        if (part.type === 'tool' && part.state?.status === 'completed' && part.state.output && !svcParsed.current.has(part.id)) {
          const tname = (part.tool ?? '').toLowerCase()
          if (tname === 'bash' || tname === 'shell' || tname === 'execute') {
            svcParsed.current.add(part.id)
            const cmd = str((part.state.input as Record<string, unknown> | undefined)?.command)
            const port = cmdPortOf(cmd)
            let latest: QnProc[] | null = null
            for (const m of part.state.output.matchAll(/QN_SERVICE_PID=(\d+)/g)) {
              latest = await window.qingniao
                .procAdd(part.sessionID, { pid: Number(m[1]), cmd: cmd ? cmd.slice(0, 120) : '服务进程', port, startedAt: Date.now() })
                .catch(() => null)
            }
            if (latest && part.sessionID === sidRef.current) setSvcProcs(latest)
          }
        }
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
      } else if (e.type === 'question.v2.asked' || e.type === 'question.asked') {
        // 实测事件名有 v1/v2 两套（内核二进制里都存在），认全部，漏一个名字就再也不弹窗
        const q = e.properties as unknown as QuestionAsk
        if (q && q.id && q.sessionID === sidRef.current) setAsks((prev) => [...prev.filter((x) => x.id !== q.id), q])
      } else if (['question.v2.replied', 'question.v2.rejected', 'question.replied', 'question.rejected'].includes(e.type)) {
        const pr = e.properties as { requestID?: string }
        setAsks((prev) => prev.filter((x) => x.id !== pr.requestID))
      } else if (e.type === 'permission.asked' || e.type === 'permission.v2.asked') {
        // 默认权限档位下，AI 要动文件/执行命令，内核停在这里等用户点头。
        // 两套事件名（v1 带 permission/patterns/always，v2 带 action/resources）都认——
        // 漏一个名字的后果是「永远不弹确认」，AI 就卡在那里直到超时。
        const raw = e.properties as Record<string, unknown>
        const id = String(raw.id ?? '')
        if (!id) return
        setPerms((prev) => [
          ...prev.filter((x) => x.id !== id),
          {
            id,
            sessionID: String(raw.sessionID ?? ''),
            // v1 是 permission（工具名），v2 是 action
            kind: String(raw.permission ?? raw.action ?? ''),
            // v1 是 patterns，v2 是 resources
            targets: (Array.isArray(raw.patterns) ? raw.patterns : Array.isArray(raw.resources) ? raw.resources : []).map(String),
            always: (Array.isArray(raw.always) ? raw.always : Array.isArray(raw.save) ? raw.save : []).map(String),
            metadata: (raw.metadata ?? {}) as Record<string, unknown>
          }
        ])
      } else if (['permission.replied', 'permission.rejected', 'permission.v2.replied'].includes(e.type)) {
        const pr = e.properties as { requestID?: string; id?: string }
        const rid = pr.requestID ?? pr.id
        if (rid) setPerms((prev) => prev.filter((x) => x.id !== rid))
      } else if (e.type === 'session.idle') {
        const idleSid = (e.properties as { sessionID?: string }).sessionID
        if (!idleSid) return
        const owned = !!busySetRef.current[idleSid]
        // 手机发起的回合本端从没 busy 过，但这一轮的内容（用户消息 + AI 回复）必须落进界面，
        // 所以「本端正在看的会话」即使不是自己发起的，也要在 idle 时拉一次完整历史；
        // 与己无关的会话照旧直接跳过（不然每个任务跑完都要多拉一份历史）。
        if (!owned && idleSid !== sidRef.current) return
        // 处理中的会话空闲：无论用户是否切走都要清该会话的 busy（防切回时残留"正在思考"）
        markBusy(idleSid, false)
        // 回合正常收尾：流式失败标记作废（这一轮既然走完了，之前那次失败不影响下一轮判定）
        streamFailed.current.delete(idleSid)
        const isCurrent = idleSid === sidRef.current
        oc.messages(idleSid, isCurrent ? dirRef.current : undefined)
          .then((list) => {
            // 回合结束对账：把「只写日志、没走事件」的失败（certificate/限流/Aborted/空壳截断）补到界面。
            const turnErr = turnErrorOf(list)
            if (turnErr?.message) {
              // 有明确的失败原因（含 MessageAbortedError → 上/stream 断流）：当前会话显示红色错误条。
              // 用户手动停止的会话不再提示——停止按钮本身就是反馈。
              if (isCurrent && !userStopped.current.has(idleSid)) setError(turnErr.message)
            } else if (isCurrent && !turnErr?.aborted) {
              // 正常完成的助手回合，清一下可能残留的旧错误提示
              setError('')
            }
            if (!isCurrent) return
            setTodos([])
            setMsgs(hydrate(list, shown.current, texts.current))
            p.onRefreshSessions()
            // 本轮用过的额外模型（识图 / 生图 / 配音…）挂到本轮最后一条 AI 回复下方。
            // 一轮没额外调用过就不挂——每轮都挂一行「未使用其他模型」纯属噪音。
            const usedNow = turnModels.current
            turnModels.current = []
            if (usedNow.length) {
              const lastAsstOfTurn = [...list].reverse().find((m) => m.info.role === 'assistant')
              if (lastAsstOfTurn) setUsedByMsg((prev) => ({ ...prev, [lastAsstOfTurn.info.id]: usedNow }))
            }
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
              // 重连前任务被中断且带明确错误（certificate/限流/Aborted）→ 当前会话补一条红色错误条。
              const turnErr = turnErrorOf(list)
              if (turnErr?.message) {
                // 用户手动停止的会话不再提示
                if (s === sidRef.current && !userStopped.current.has(s)) setError(turnErr.message)
              }
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
        for (const s of busySids()) markBusy(s, false)
        inflight.current = null
        setTodos([])
        setAsks([])
        setError('')
        if (sidRef.current) {
          oc.messages(sidRef.current, dirRef.current)
            .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
            .catch(() => {})
        }
      } else if (e.type === 'qingniao.kernel.unhealthy') {
        // 主进程自动重启内核后，本地busy 状态全部失效，做一次整体重同步。
        // **不弹错误条**（2026-10-14 用户定版）：内核已在自动重启、几秒后就回来，
        // 「内核连接异常」这种红色错误条除了让人烦躁什么也没说；输入框会自己禁用（kernelReady）。
        setKernelReady(false)
        streamFailed.current.clear()
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
        if (busySetRef.current[sid]) markBusy(sid, false)
        const isCurrent = sid === sidRef.current
        // 用户手动停止：不再弹错误条，停止按钮本身就是反馈
        const stopped = userStopped.current.has(sid)
        oc.messages(sid, isCurrent ? dirRef.current : busyDir.current[sid])
          .then((list) => {
            if (!isCurrent) return
            setMsgs(hydrate(list, shown.current, texts.current))
            if (!stopped) setError(humanizeError(pr.error?.message ?? ''))
            p.onRefreshSessions()
          })
          .catch(() => { if (isCurrent && !stopped) setError(humanizeError(pr.error?.message ?? '')) })
      }
    })
    return off
  }, [])

  /**
   * 内核就绪状态的初值 + 兜底轮询。
   *
   * 初值走 IPC 问一次（此刻内核通常已就绪，因为主进程是`await adapter.start()` 之后才建窗口）。
   * 之后的变化全靠 `qingniao.kernel.state` 事件——但事件桥本身也可能丢（SSE 是另一条通道、
   * 窗口重建时序等），所以额外挂一个**低频兜底**：只有「已知未就绪」时才每2s 探一次，
   * 一就绪立刻停。已就绪时不轮询，零开销。
   */
  useEffect(() => {
    let alive = true
    void oc
      .kernelReady()
      .then((r) => { if (alive) setKernelReady(r) })
      .catch(() => { /* 主进程不可达：保持默认可用，不阻塞界面 */ })
    const t = window.setInterval(() => {
      if (!alive) return
      void oc
        .kernelReady()
        .then((r) => { if (alive) setKernelReady(r) })
        .catch(() => { /* 探不到就当没就绪，下轮再试 */ })
    }, 2000)
    return () => { alive = false; clearInterval(t) }
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

  /** 从某会话队列移除第 i 条 */
  function dropQueueItem(sid: string, i: number) {
    setQueues((m) => ({ ...m, [sid]: (m[sid] ?? []).filter((_, k) => k !== i) }))
  }

  // 队列消费：当前会话本轮跑完自动发下一条；被"立即执行"插队的按下标优先。
  // 每个会话的队列独立，只消费当前视图会话的；切回空闲且排了队的会话时自动续跑
  useEffect(() => {
    if (busy || !p.sessionId) return
    const q = queues[p.sessionId]
    if (!q?.length) return
    const sid = p.sessionId
    const text = q[0]
    dropQueueItem(sid, 0)
    void runPrompt(text, sid, busyDir.current[sid])
  }, [busy, p.sessionId, queues])

  // 点新任务/点任务：光标自动落进输入框
  useEffect(() => {
    if (p.focusSignal > 0) taRef.current?.focus()
  }, [p.focusSignal])

  // 标题栏「内置浏览器」按钮：每 +1 开/关一次右侧面板
  useEffect(() => {
    if (p.browserToggleSignal > 0) toggleBrowserFromHeader()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.browserToggleSignal])

  // 浏览器打开时标题栏最大化按钮接管面板放大/还原：每 +1 切换一次
  useEffect(() => {
    if (p.browserMaxSignal > 0) toggleBrowserMax()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.browserMaxSignal])

  // 向 App 上报浏览器面板开合与放大状态（标题栏按钮据此决定行为与图标）
  useEffect(() => {
    p.onBrowserUi({ open: panelOpen, max: browserMax })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, browserMax])

  // 向 App 上报代码审查面板开合（App 据此在代码模式放宽对话列最小宽）
  useEffect(() => {
    p.onReviewUi?.({ open: reviewOpen })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewOpen])

  // 每轮工作时长（持久化到 localStorage，刷新/重开会话后历史轮照常显示）：
  // 会话 id → 轮首用户消息 id → 秒数。读取时顺手清洗脏值（早先版本落表缺陷可能写入天量秒数）
  const [turnSpentAll, setTurnSpentAll] = useState<Record<string, Record<string, number>>>(() => {
    const clean: Record<string, Record<string, number>> = {}
    for (const [sid, table] of Object.entries(load<Record<string, Record<string, number>>>('qingniao.turnSpent', {}))) {
      const t: Record<string, number> = {}
      for (const [k, v] of Object.entries(table)) if (v > 0 && v <= 86400) t[k] = v
      if (Object.keys(t).length) clean[sid] = t
    }
    return clean
  })
  const turnSpent = turnSpentAll[p.sessionId] ?? {}
  useEffect(() => save('qingniao.turnSpent', turnSpentAll), [turnSpentAll])
  const turnStartRef = useRef(0)
  const prevBusyRef = useRef(false)
  useEffect(() => {
    if (busy && !prevBusyRef.current) turnStartRef.current = Date.now()
    if (!busy && prevBusyRef.current && turnStartRef.current) {
      const owner = [...msgs].reverse().find((m) => m.info.role === 'user')?.info.id
      const sec = Math.round((Date.now() - turnStartRef.current) / 1000)
      // 一轮工作不该超过一天：超限（起算点丢失等异常）宁可不记，别让「已工作」显示天文数字
      if (owner && sec > 0 && sec <= 86400)
        setTurnSpentAll((s) => ({
          ...s,
          [p.sessionId]: { ...(s[p.sessionId] ?? {}), [owner]: sec }
        }))
      turnStartRef.current = 0
    }
    prevBusyRef.current = busy
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  // 切会话时收起审查面板回到新会话的初始状态
  useEffect(() => {
    setReviewOpen(false)
  }, [p.sessionId])

  // 查标题栏槽位：DOM 提交后一定已存在（Titlebar 先于内容渲染）
  useEffect(() => {
    setTbSlot(document.querySelector<HTMLElement>('.tb-browser-slot'))
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    // 用户在往上翻时不打扰，贴底时才跟随
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [msgs, busy])

  function onMsgsScroll() {
    const el = scrollRef.current
    if (!el) return
    // 滚轮上滑后的短窗口内：流式吸底的程序化 scrollTop 也会触发 scroll 事件，
    // 若照常按「贴底」重新接管，用户的上滑会被拉回底部（回弹）。窗口内一律保持脱离吸底
    if (performance.now() < wheelUpMuteUntilRef.current) {
      atBottomRef.current = false
      setAtBottom(false)
      return
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = near
    setAtBottom(near)
  }

  function jumpBottom() {
    atBottomRef.current = true
    setAtBottom(true)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }

  /** 「用户消息锚点」竖排条数据：每条可见的用户消息对应一个跳转点（id + 首行预览，给悬停提示用） */
  const userAnchors = useMemo(() => {
    if (!msgs.length) return []
    const list: { id: string; label: string }[] = []
    for (const m of msgs) {
      if (m.info.role !== 'user') continue
      if (autoContinueIds.current.has(m.info.id)) continue
      const txt = m.parts
        .filter((x) => x.type === 'text' && !x.synthetic)
        .map((x) => x.text)
        .join('')
      if (isCtxOnly(txt)) continue
      const label = txt.trim().split('\n')[0] || ''
      // 只用于悬停提示，截到 60 字：再多原生提示会拉成一条横穿屏幕的长条
      list.push({ id: m.info.id, label: label.slice(0, 60) })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs])

  /** 点击左侧用户锚点：立即定位到对应用户消息（不用平滑滚动，点了就到位） */
  function jumpToUserMsg(id: string) {
    const el = scrollRef.current?.querySelector<HTMLElement>(`.umsg-anchor[data-uid="${id}"]`)
    if (!el) return
    const box = scrollRef.current
    if (!box) return
    // 消息定位到滚动容器中上方一点，露出锚点条与气泡
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 64
    atBottomRef.current = false
    setAtBottom(false)
    box.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
  }

  // 执行中每秒刷新一次（用时数值由 busySince 起算）
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => tick((v) => v + 1), 1000)
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
    /**
     * 卡死看门狗计数：连续 5 轮（≥6s）看到「内核真相 = 回合已结束」才收口。
     * 不能太紧：模型两步衔接（工具跑完 → 下一条 assistant 消息开始）实测有 3.7s+ 的空档，
     * 这个空档里「末条已 completed + 无 running 工具」全部成立，阈值 2 轮会误判收口，
     * 把还在跑的回合提前清成空闲（实测 thinkphp 查询轮就踩了）。
     */
    let finishedStreak = 0
    /** 流式失败后仍 busy 的连续轮数：≥3 轮（≥3.6s）判定这轮废了，见下方收口兜底 */
    let streamFailStreak = 0
    const sync = async () => {
      if (!alive) return
      // 提问对账：question.v2.asked 事件可能漏收，busy 期间以内核待答列表为准。
      // /question 端点按项目实例隔离，必须带上该会话的目录，否则永远返回空
      try {
        const list = await oc.questions(busyDir.current[sid] ?? dirRef.current)
        const mine = (Array.isArray(list) ? list : []).filter((x) => x.sessionID === sid && !replyingRef.current.has(x.id))
        const cur = asksRef.current
        if (mine.length !== cur.length || mine.some((x) => !cur.some((k) => k.id === x.id))) setAsks(mine)
      } catch { /* 忽略 */ }
      try {
        const list = await oc.messages(sid, dirRef.current)
        if (!alive || sid !== sidRef.current || sid !== p.sessionId) return
        // 指纹：消息数 + 各 part 长度。内容无变化直接跳过，避免无谓渲染
        const fp = list.map((m) => m.info.id + ':' + m.parts.map((x) => x.type + (x.text?.length ?? 0)).join(',')).join('|')
        if (fp !== pollFingerprint.current) {
          pollFingerprint.current = fp
          setMsgs((prev) => mergePoll(list, prev, texts.current, shown.current, startTicker))
        }
        // 收口兜底：轮次以**错误**结束且事件没送达（断流/限流只写进消息 info，不推 session.error）
        // 时，靠这里把 busy 清掉、错误条补上。没有错误文本的中断（用户手动停/半截截断）不动——
        // 那是「可重试」状态，留着处理中行与停止按钮交给用户处置，防「处理中」卡死。
        if (busySetRef.current[sid] && !userStopped.current.has(sid)) {
          const te = turnErrorOf(list)
          if (te?.message) {
            setError(te.message)
            markBusy(sid, false)
            streamFailed.current.delete(sid)
            streamFailStreak = 0
          } else if (streamFailed.current.has(sid)) {
            // **本轮已收到内核的流式失败，但消息里还没有 error**（这正是 stream error 的特征：
            // 失败只写日志，内核要重试到耗尽才写进消息）。此时绝不能继续等 session.idle——
            // 内核重试最多 6 次、累计 1 分 39 秒，而它在这期间**既不推事件也不写消息**，
            // 界面上就只剩一个永远转圈的「处理中」。
            //
            // 给 3 轮（≥3.6s）宽限让正常收尾先发生：万一内核其实恢复了呢（它有重试机制）。
            // 超过 3 轮还 busy → 判定这轮已经废了，收口 + 提示，不再让用户干等。
            streamFailStreak++
            if (streamFailStreak >= 3) {
              streamFailStreak = 0
              streamFailed.current.delete(sid)
              markBusy(sid, false)
            }
          } else {
            // 本轮没有流式失败（走上面 else 分支说明失败标记不在）——复位计数
            streamFailStreak = 0
            streamFailed.current.delete(sid)
          }
        }
        // 卡死看门狗：**正常结束**的回合如果 session.idle 事件漏收（SSE 断连），上面那个
        // 错误兜底救不了——「处理中」会永远挂着（实测：执行完命令后对话卡住转圈）。
        // 判据全部来自内核 /message 实拉数据，不是猜：
        //   ① 最后一条消息是 assistant 且 info.time.completed 已盖戳（内核只在消息结束时写）；
        //   ② 整个会话没有任何 running/pending 的工具 part；
        //   ③ 连续 5 轮轮询（≥6s）都满足——两步衔接空档实测 3.7s+，2 轮会被误判提前收口。
        // 三条同时成立说明内核那边回合已经落幕，本端补一次 markBusy(false) 对账。
        if (busySetRef.current[sid] && !userStopped.current.has(sid)) {
          const last = list[list.length - 1]
          const hasRunning = list.some((m) => m.parts.some((x) => x.state?.status === 'running' || x.state?.status === 'pending'))
          const finished =
            !!last &&
            last.info.role === 'assistant' &&
            typeof last.info.time?.completed === 'number' &&
            !hasRunning
          if (finished) {
            finishedStreak++
            if (finishedStreak >= 5) {
              finishedStreak = 0
              streamFailed.current.delete(sid)
              markBusy(sid, false)
            }
          } else {
            finishedStreak = 0
          }
        }
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
      oc.abort(cur.sid, busyDir.current[cur.sid]).catch(() => { /* 内核已停/无此任务 */ })
      markBusy(cur.sid, false)
      setError(t('网络已断开，任务自动暂停，恢复后自动执行。'))
    }
    const onOnline = () => {
      const cur = inflightRef.current
      if (!cur) return
      inflightRef.current = null
      setError('')
      void runPrompt(cur.text, cur.sid, busyDir.current[cur.sid], undefined, cur.atts)
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

  /** 回形针：弹系统对话框选图片/视频，追加进待发送附件条 */
  async function pickAtt() {
    try {
      const list = await window.qingniao.pickMedia()
      if (list?.length) setAtts((prev) => [...prev, ...list])
    } catch {
      /* 选择框取消/失败 */
    }
  }

  /** 发送前挑一个能胜任本轮的聊天模型，返回覆盖用的 ModelSel（不用换则 undefined）。
   *  两种情况会换，且都只在**同提供商**内挑（跨提供商静默跳会让用户莫名换到别家）：
   *  1. 当前是纯生成模型（生图 / 生视频 / 语音，端点只收 /images｜/videos｜音频接口）——换到能聊天的模型，
   *     图生图、配音由聊天模型 + 对应工具完成，本来就不需要选生成模型当对话模型；
   *  2. 带了图片/视频附件但当前模型不支持该输入模态——换到同提供商支持该模态的聊天模型。
   *     否则模型只看到 [Attached image/png: 路径] 一行文本、看不到画面，识图答不上、
   *     「把背景换成海边」这类改图意图也容易判成普通问答。
   *  换成功会在对话里留一句提示，不静默。
   *
   * **「操作本机桌面」这一种坚决不换**：computer 工具回的是截图，早先为了让模型看得见图，
   * 这里会把对话模型切成带视觉的那个，甚至在提供商之间跨家挑人——结果用户选的文本模型被顶掉
   * （界面显示「已切到 deepseek-flash」），对话风格、额度、上下文全变了。
   * 桌面控制本来就有代看方案：screen MCP 把截图交给**专门挑出来的视觉模型**读成文字附在工具回执里，
   * 对话模型一个字都不用改。这条路的成本是「每次截屏多一轮识图」，换来的却是用户选定的模型不被夺走。 */
  function resolveChatModel(files: Attachment[], text: string): ModelSel | undefined {
    const i = p.model.indexOf('/')
    /**
     * 空值（p.model 还没有 provider/model）遇图片/视频附件的兜底。
     *
     * 2026-10-13 起模型选择器不再提供「自动」档，正常流程下这个分支几乎走不到——
     * 校正 effect 会先把空值收敛成第一个可用模型。留着是因为存量用户 localStorage 里
     * 存的就是空串，而发消息可能抢在校正之前发生（切回会话即发）。
     *
     * 这时主进程挑默认模型不看模态，可能选中一个收不了图的，用户看到的就是
     * 「发了图，AI 只读到文件路径」。所以本轮临时借一个收得下附件的模型——
     * 只走 modelOverride，**不改**用户选中的模型。
     */
    if (i <= 0) {
      const want: Modality[] = []
      if (files.some((a) => a.mime.startsWith('image/'))) want.push('image')
      if (files.some((a) => a.mime.startsWith('video/'))) want.push('video')
      if (!want.length) return undefined
      const canTalk = (mm: ModelCfg) => genRoleOf(mm) === 'none' && (mm.input ?? MODEL_DEFAULTS.input).includes('text')
      for (const g of p.settings) {
        if (!g.enabled) continue
        const hit = g.models.find((mm) => canTalk(mm) && want.every((n) => (mm.input ?? MODEL_DEFAULTS.input).includes(n)))
        if (hit) return { providerID: g.id, modelID: hit.id }
      }
      return undefined // 一个都收不下：原样发，路径照样能交给识图工具处理
    }
    const pid = p.model.slice(0, i)
    const cur = p.settings.find((x) => x.enabled && x.id === pid)
    const curM = cur?.models.find((mm) => mm.id === p.model.slice(i + 1))
    const curInput = curM?.input ?? MODEL_DEFAULTS.input
    const inputs = (mm: { input?: readonly Modality[] }): readonly Modality[] => mm.input ?? MODEL_DEFAULTS.input
    /**
     * 能不能当对话模型：生成角色（生图 / 生视频 / 语音）一律不算，哪怕它勾了文本输入。
     * 语音模型尤其容易被漏判——MiMo 的 TTS 就是从 /chat/completions 出的，字段上看得到「文本进」，
     * 但它回的是音频不是话，选它当对话模型这一轮等于白发。
     */
    const chattable = (mm: ModelCfg): boolean => genRoleOf(mm) === 'none' && inputs(mm).includes('text')
    // 附件需要的输入模态（视频附件同理，看不了视频就换能看的）
    const need: Modality[] = []
    if (files.some((a) => a.mime.startsWith('image/'))) need.push('image')
    if (files.some((a) => a.mime.startsWith('video/'))) need.push('video')
    // 先保证能聊天：纯生成模型根本收不了对话
    if (curM && !chattable(curM)) {
      const cand = cur?.models.find(chattable)
      if (!cand) return undefined
      p.onModelChange(`${pid}/${cand.id}`)
      setNotice(t('当前模型只能生成、不能对话，已切到「{name}」；出图、出片、配音都由对应工具完成。', { name: cand.name || cand.id }))
      return { providerID: pid, modelID: cand.id }
    }
    // 再看缺不缺图片/视频输入（附件要的，或桌面控制要看截屏要的）
    const lack = need.filter((n) => !curInput.includes(n))
    if (!lack.length) return undefined
    const cand = cur?.models.find((mm) => chattable(mm) && lack.every((n) => inputs(mm).includes(n)))
    if (!cand) {
      if (lack.includes('video')) {
        // 图片收不到还有识图 MCP 代看，视频没有代看路径：换不到模型时只能提前讲明白
        setNotice(t('这条附件是视频，而当前提供商里没有支持视频输入的模型可换——AI 这轮只会看到文件路径，读不到画面。可在 设置 → 模型 给支持视频的模型勾上「输入 · 视频」再发。'))
      }
      return undefined // 原样发：路径照样能交给生图/识图工具处理
    }
    p.onModelChange(`${pid}/${cand.id}`)
    setNotice(
      t('当前模型不支持{what}输入，', { what: lack.includes('image') && lack.includes('video') ? t('图片/视频') : lack.includes('image') ? t('图片') : t('视频') }) +
        t('已切到「{name}」以便看懂附件内容。', { name: cand.name || cand.id })
    )
    return { providerID: pid, modelID: cand.id }
  }

  async function send() {
    const text = input.trim()
    if (!text && !atts.length) return
    // 内核没就绪：安静地不作为（输入框已禁用，这里只是防快捷键/粘贴等旁路）。
// **不弹错误**——内核几秒后就起来了，报错纯属倒垃圾（2026-10-14 用户定版）。
    if (!kernelReady) {
      setKernelReady(false)
      return
    }
    const files = atts
    setNotice('') // 新的一轮先清掉上次的切换提示，避免旧提示赖在对话末尾
    // 自动预警：用户用文字要「生图/生视频」，但当前没配生图模型（工具根本不存在，再提示也真出不了图）。
    // 提前说明，避免模型为了出图去写 Python 装库、用户看着一头雾水。
    if (text && isGenIntent(text) && !hasGenModel(p.settings)) {
      const needsModule = files.some((a) => a.mime.startsWith('image/') || a.mime.startsWith('video/'))
      setNotice(
        (needsModule ? t('这段附图要做成新图/新片，也') : '') +
          t('当前没有配置生图/生视频模型，AI 出不了真图。请在 设置 → 提供商 里加一个生图模型（如 flux / stable-diffusion / dall-e / *-image-*），否则 AI 只能靠代码画图、效果有限。')
      )
    }
    // 当前模型不能聊天，或看不懂本轮附件时，自动换成同提供商能胜任的模型（详见 resolveChatModel）
    const promptModel = resolveChatModel(files, text)
    if (busy && atts.length) {
      setError(t('处理中不能发送附件，请等当前任务结束后再发送'))
      return
    }
    setAtts([])
    setInput('')
    setError('')
    if (text) {
      hist.current.push(text)
      histPos.current = hist.current.length
    }
    if (busy) {
      // 终端长跑卡住本轮：发送新消息 = 用户主动接管（中止当前轮后立即执行，不进队列）
      if (terminalBlocked && sidRef.current) {
        const sid = sidRef.current
        oc.abort(sid, busyDir.current[sid]).catch(() => { /* 已结束 */ })
        window.setTimeout(() => runPrompt(text, sid, busyDir.current[sid]), 900)
        return
      }
      setQueues((m) => ({ ...m, [sidRef.current]: [...(m[sidRef.current] ?? []), text] }))
      return
    }
    await runPrompt(text, undefined, undefined, promptModel, files)
  }

  async function runPrompt(text: string, sidOverride?: string, dirOverride?: string, modelOverride?: ModelSel, attsOverride?: Attachment[]) {
    // 新执行一律先清上一条错误：否则换话题/换模型续跑时，旧错误气泡会赖在对话尾部
    setError('')
    const dir = dirOverride ?? p.project?.path
    let sid = sidOverride ?? p.sessionId
    // 用户重新发消息 = 从头再来：解除上一轮的熔断停止。
    // （服务端那边是否恢复不归我们判断——若仍不可用，下一次调用会被工具重新熔断。）
    if (sid) {
      halted.current.delete(sid)
      toolFails.current.delete(sid)
      userStopped.current.delete(sid)
      // 上一轮的流式失败标记同样作废：新回合不该继承上一轮的"已废"判定
      streamFailed.current.delete(sid)
    }
    if (!sid) {
      // 草稿：首次发送才真正创建会话；标题直接用用户这句话（纯附件发送时用占位标题）
      const title = (text.length > 30 ? text.slice(0, 30) + '…' : text) || t('发送了附件')
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
        // 必须 await：与正题 prompt 并发进内核队列时，loop 会在下一步捞到这条 noReply 消息
        // 并按内核默认模型生成一条答非所问的回复（历史事故：桌面控制中途冒出「我没有桌面工具」）
await oc.injectContext(sid, dir, memText).catch(() => { /* 记忆注入失败不影响正常对话 */ })
        p.onDraftCreated(s)
      } catch (e) {
        // 建会话撞上内核未启动（503）：不报错，把这句话退回输入框等内核就绪后重发。
        // 内核几秒后就起来了，报「内核未启动」对用户毫无意义（2026-10-14 用户定版）。
        if (isKernelTransportError(e)) {
          setKernelReady(false)
          setInput((prev) => (prev.trim() ? prev : text))
          return
        }
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    // 浏览器对话上下文：面板开着且有页面时，先把「当前页面」以仅上下文注入，
    // 让本轮对话默认针对这个 URL（网页浏览场景）而不是本地项目；URL 没变就不重复注入。
    // **全屏浏览（浏览模式 / 面板放大）时另外标一份**：这时面板占满整个窗口，
    // 操作面就是那个网页，本轮必须走 panel_*、禁用 computer（见下方桌面路由的互斥判定）。
    const browserFullscreen = browserMax && !!panelUrl
    if (panelOpen && panelUrl) {
      const bc = browserCtxRef.current
      if (!bc || bc.sid !== sid || bc.url !== panelUrl || bc.max !== browserFullscreen) {
        try {
          await oc.injectContext(
            sid,
            dir,
            BROWSER_CTX_PREFIX +
              '用户正在内置浏览器里看下面这个页面，本轮对话默认针对该页面（网页浏览场景，不是本地项目开发）：\n' +
              `- 当前页面：${panelUrl}\n` +
              (browserFullscreen
                ? '- 浏览器**全屏浏览中**（面板占满窗口，右下角是浮动对话卡）：操作面就是这个网页。\n' +
                  '- **本轮禁止调用 `computer`（桌面控制）**：不要截整个桌面、不要点桌面上的图标——' +
                  '网页的一切点击/输入/滚动都用 `panel_*`（ref 来自 `panel_snapshot`）。\n'
                : '') +
              '用户说「换个网址 / 换 URL / 换个页面」时，指的是**在这个浏览器里导航到新地址**' +
              '（用 panel_navigate 打开，或让用户自己在地址栏输入），不是重开面板、也不是调整浏览器窗口大小。\n' +
              '浏览器面板的尺寸（右栏 / 全屏 / 浮动对话卡）由用户自己控制：**不要主动关闭、缩小或放大面板**，' +
              '也不要建议用户这么做，除非用户明确要求。\n' +
              '读取或操作页面用 panel_* 浏览器工具（panel_navigate / panel_snapshot / panel_click / panel_type）：' +
              '看页面内容就再调一次 panel_snapshot（文本元素清单），**不要用桌面控制去截屏看网页**——截屏又慢又要求模型支持图片输入，而面板页面本来就能读到结构。\n' +
              // 用户实测过的事故：模型看不到「地址不存在」的反馈，连猜十几个 URL 把任务耗光。
              '**要进站点的某个页面时不要猜地址**：panel_snapshot 清单里 a 标签后 `→ /path` 就是真实地址，点它的 ref 进去；' +
              'panel_navigate 回执说「导航没有生效」「页面上没有任何可交互元素」= 这个地址不存在，**不要换个近似地址接着试**，' +
              '页面上确实找不到入口就**停下来如实告诉用户「没找到 XX 入口」**，并说明试过哪些地址。\n' +
              '不要读写项目文件或执行终端命令，除非用户明确要求；回答优先基于当前页面的实际内容。'
          )
          browserCtxRef.current = { sid, url: panelUrl, max: browserFullscreen }
        } catch {
          /* 注入失败不阻塞对话，AI 仍可自行用工具探页面 */
        }
      }
    }
    // 附件工具路由：只靠工具描述里的触发条件不够稳——模型看不到图片画面时往往直接回
    // 「我看不了图片」。这里点名本轮附件路径和该调的工具（noReply：AI 可见、界面不渲染）。
    const attFiles = attsOverride ?? []
    if (attFiles.length) {
      const hasImg = attFiles.some((a) => a.mime.startsWith('image/'))
      const hasVid = attFiles.some((a) => a.mime.startsWith('video/'))
      const hasAud = attFiles.some((a) => a.mime.startsWith('audio/'))
      const kindOf = (m: string) =>
        m.startsWith('image/') ? '图片' : m.startsWith('video/') ? '视频' : m.startsWith('audio/') ? '音频' : '文件'
      const lines = ['用户这一轮发来了附件，下面是本机绝对路径（填工具参数时原样照抄，不要改成文件名）：']
      for (const a of attFiles) lines.push(`- ${kindOf(a.mime)}：${a.path}`)
      // 音频最常见也最容易答错：模型常回「我听不了音频」或直接开始转述文件名，先把它按死
      if (hasAud)
        lines.push(
          '⚠️ 有音频时**严禁**回答「我听不了音频 / 无法处理音频」，也**严禁**反问用户要文字版——' +
            '你要做的就是调 transcribe_audio 把音频路径放进 audio（要指定语言传 language），拿到转写文本后再按用户意图处理。'
        )
      lines.push('按用户意图选工具，不要回答「我看不了图片」，也不要只描述附件：')
      if (hasAud) {
        lines.push('- 要**语音转文字 / 听写 / 转写 / 总结录音内容 / 把这段会议记下来**→ 调 transcribe_audio，audio 填上面的音频路径。')
        lines.push('- 音频要**改风格 / 变声 / 重新配音**→ 那是重新合成，调 generate_speech（transcribe_audio 只负责听，不改音频）。')
      }
      if (hasImg) {
        lines.push('- 要**看懂图片内容**（识别画面、读图里文字、回答关于图的问题）→ 调 describe_image，images 填上面的图片路径。')
        lines.push('- 要**改图 / 按图出图**（换背景、换风格、去掉某物、做成某风格）→ 调 generate_image，把上面的图片路径放进 image，文字要求写进 prompt。')
      }
      if (hasVid)
        lines.push('- 要**按视频出片**（续写、换风格、配音乐）→ 调 create_video，把上面的视频路径放进 videos（配音乐用 audios）。')
      lines.push(
        '- **生成类工具失败就停手**：generate_image / create_video / check_video 返回失败（429 限流、额度不足、' +
          '鉴权失败等）时不要换参数重试，把错误如实转告用户——重复调用会被熔断拒绝，连续失败还会自动中止本轮。'
      )
      try {
        await oc.injectContext(sid, dir, ATTACH_CTX_PREFIX + lines.join('\n'))
      } catch {
        /* 注入失败不阻塞发送 */
      }
    }

    // 服务进程约定：每会话首轮注入一次「启动常驻服务的标准姿势」（Windows 下用 PowerShell
    // Start-Process 后台化并回显 QN_SERVICE_PID）。失败回滚标记，下一轮重试。
    if (sid && !svcCtxSids.current.has(sid)) {
      try {
        await oc.injectContext(sid, dir, SERVICE_CTX_PREFIX + SERVICE_RULES)
        svcCtxSids.current.add(sid)
      } catch {
        /* 注入失败不阻塞对话 */
      }
    }

    markBusy(sid, true, dir)
    userStopMarks.current.delete(sid)
    const files = attsOverride ?? []
    inflight.current = { sid, text, atts: files.length ? files : undefined }
    atBottomRef.current = true
    setAtBottom(true)
    const tmpId = 'tmp-' + Date.now()
    // 续跑（点「重试」/ 中断自动接续）发的指令：不落用户气泡，尾部状态条已有「重试」提示，
    // 真实消息 id 由 message.updated 认领后补记。
    // 判据是 autoContinuePending 这个**发起方打的标记**，不是文本内容——
    // 用户手打「继续」走的是普通发送，气泡必须照常显示。
    if (autoContinuePending.current) {
      autoContinueIds.current.add(tmpId)
    }
    turnBase.current = new Set(msgs.map((m) => m.info.id))
    // 新一轮从零开始计「额外调用了哪些模型」；跨会话并行时手机那轮也会计进同一个桶，
    // 顶多多一行「另调用」，不值得为此把 sessionID 一路透传到 MCP 再带回来。
    turnModels.current = []
    const optimistic: MessageView = {
      info: { id: tmpId, role: 'user', sessionID: sid },
      parts: [
        { id: tmpId + '-p', sessionID: sid, messageID: tmpId, type: 'text', text },
        ...files.map((a, i) => ({
          id: `${tmpId}-f${i}`,
          sessionID: sid,
          messageID: tmpId,
          type: 'file',
          mime: a.mime,
          filename: a.name,
          url: a.url
        }))
      ]
    }
    setMsgs((prev) => [...prev, optimistic])
    let transportLost = false
    try {
      await oc.prompt(sid, dir, text, modelOverride ?? parseModel(p.model), files, thinkRef.current)
    } catch (e) {
      const status = (e as Error & { status?: number }).status
      if (status === 503) {
        // **内核确定没起来**（主进程发现进程为 null 直接代抛）——请求压根没被接受，
        // 这一轮不存在，所以必须把乐观气泡撤掉、清 busy、把原话退回输入框，
        // 否则界面会永远卡在「处理中」（内核起来后也不会有 session.idle 来收尾）。
        // 不弹错误条：用户原话「内核没启动不要在界面上显示错误，最多就是输入禁用」。
        setKernelReady(false)
        setMsgs((prev) => prev.filter((m) => m.info.id !== tmpId))
        markBusy(sid, false)
        delete busyDir.current[sid]
        if (inflight.current?.sid === sid) inflight.current = null
        setInput((prev) => (prev.trim() ? prev : text))
        return
      }
      // 502 是连接层断开，内核**可能还在跑**这一轮：任务继续执行任意时长都由事件流与
      // 轮询展示，session.idle / SSE 重连负责收尾，所以不当失败、也不清 busy。
      // 只有内核明确拒绝（如 4xx，请求未被接受）才当场报错收尾。
      if (status && status !== 502) {
        setError(e instanceof Error ? e.message : String(e))
        markBusy(sid, false)
      } else {
        transportLost = true
      }
    } finally {
      inflight.current = null
      if (!transportLost) {
        // 本轮结束置空闲（若 session.idle 已清过则幂等；用户切走会话后再回来也能清，消除 busy 残留）
        if (busySetRef.current[sid]) markBusy(sid, false)
        // 已切走（新任务草稿/别的会话）：界面缓冲归切走时加载的新会话所有，绝不清理，避免盖掉正在流式的新任务
        if (sidRef.current !== sid) return
        toolRaw.current.clear()
        setPreviews({})
        try {
          const list = await oc.messages(sid, dir)
          setMsgs(hydrate(list, shown.current, texts.current))
          startTicker()
          // 回合对账：把「请求返回了、但最后一轮实际失败/被截断而**没走事件**」的情况补到界面。
          // 例：内核把 unknown certificate verification / Rate limit exceeded 只落进 opencode.log，
          // 没有 session.error 事件 → 这里读到 info.error 就补红色错误条。
          const turnErr = turnErrorOf(list)
          if (turnErr?.message) setError(turnErr.message)
        } catch { /* 保留已渲染内容 */ }
      }
    }
  }

  /** 队列项立即执行：中断当前任务，插队优先 */
  function queueSend(i: number) {
    if (busy && sidRef.current) {
      // 中断当前回合后**延时主动执行**这条队列项，而不是依赖「busy 翻转 → 队列消费 effect」：
      // abort 只发 REST 请求，内核不一定回 session.idle（尤其终端 long-run），busy 可能一直 true，
      // 那样队列消费 effect（!busy 才触发）永不跑，点「立即执行」就毫无反应（实测）。见 send() 同款做法。
      const sid = sidRef.current
      const text = (queues[sid] ?? [])[i]
      dropQueueItem(sid, i)
      oc.abort(sid, busyDir.current[sid]).catch(() => { /* 已结束 */ })
      window.setTimeout(() => runPrompt(text, sid, busyDir.current[sid]), 900)
    } else {
      const sid = sidRef.current
      const text = (queues[sid] ?? [])[i]
      dropQueueItem(sid, i)
      void runPrompt(text, sid, busyDir.current[sid])
    }
  }

  function queueEdit(i: number) {
    const sid = sidRef.current
    setInput((queues[sid] ?? [])[i])
    dropQueueItem(sid, i)
  }

  /** 应答内核提问：提交后内核继续本轮任务；提交期间轮询对账跳过该请求，防止卡片闪回 */
  function replyAsk(req: QuestionAsk, answers: string[][]) {
    replyingRef.current.add(req.id)
    setAsks((prev) => prev.filter((x) => x.id !== req.id))
    oc.replyQuestion(req.id, answers, dirRef.current)
      .catch((e) => {
        // 内核没起来时不报错（它在重启/冷启动），只把输入禁用起来等它回来
     if (isKernelTransportError(e)) { setKernelReady(false); return }
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => replyingRef.current.delete(req.id))
  }

  function rejectAsk(req: QuestionAsk) {
    setAsks((prev) => prev.filter((x) => x.id !== req.id))
    oc.rejectQuestion(req.id, dirRef.current).catch(() => { /* 已应答/已失效 */ })
  }

  /**
   * 应答内核的权限询问。
   *
   * 先本地摘掉卡片再发请求：内核阻塞等这一下，用户点完就该立刻看到框消失；
   * 失败时补一条错误提示并把卡片放回来——否则「点了没反应、框也没了」，
   * 用户既不知道成没成，也没法重试，而内核那侧还卡着。
   */
  function replyPerm(req: PermissionAsk, reply: 'once' | 'always' | 'reject') {
    setPerms((prev) => prev.filter((x) => x.id !== req.id))
    void window.qingniao.replyPermission({ id: req.id, sessionID: req.sessionID, reply }).then((err) => {
      if (err) {
        setError(t('权限应答没能送达内核：{msg}', { msg: err }))
        setPerms((prev) => (prev.some((x) => x.id === req.id) ? prev : [...prev, req]))
      }
    })
  }

  /**
   * 应答「调用其他模型」的授权卡。与 replyPerm 同一套打法：先本地摘掉卡片（MCP 那侧正等着），
   * 回执说没人接（卡片已超时自动作废）再补一条提示——否则用户点了、卡片消失了、
   * 那次识图/出图却按拒绝走，界面上完全看不出来。
   */
  function replyModelAllow(req: ModelAuthAsk, scope: ModelAuthScope) {
    setModelAsks((prev) => prev.filter((x) => x.reqId !== req.reqId))
    void window.qingniao.replyModelAuth({ reqId: req.reqId, scope }).then((err) => {
      if (err) setNotice(t('授权未生效：{msg}', { msg: err }))
    })
  }

  // 可见消息数：项目记忆、浏览器页面上下文都是「仅上下文」注入（AI 可见、界面不渲染），
  // 不能算进「有内容」，否则注入记忆后 msgs 非空、空态引导就不显示了
  const visibleMsgCount = msgs.filter((m) => {
    if (m.info.role !== 'user') return true
    // 与气泡渲染同口径（滤掉 synthetic），否则只带内核过程文本的消息会被算成「有内容」
    const txt = m.parts.filter((x) => x.type === 'text' && !x.synthetic).map((x) => x.text).join('')
    return !isCtxOnly(txt)
  }).length

  // 本轮已用时：从本轮开始时间起算（busySince），显示靠 tick 每秒触发重渲染刷新
  const turnElapsed = fmtElapsed(Math.floor((Date.now() - (busySince.current[p.sessionId] ?? Date.now())) / 1000))

  // 每条 assistant 消息是否轮首（owner 变化处）：轮结束后「已工作」徽标只挂轮首一条
  let prevTurnOwner: string | undefined
  const turnStarts = new Map<string, boolean>()
  // 每个回合「最后一条」AI 消息：模型名 / 速率 / 耗时尾注只挂它。
  // 工具多的回合内核会拆出多条 assistant 消息，逐条挂尾注就会一回合重复好几行
  // （2026-10-13 用户明确要求：模型 token 耗时这些绝不能重复生成多行）。
  const turnTail = new Map<string, string>()
  for (const m of msgs) {
    const owner = turnOwner.get(m.info.id)
    turnStarts.set(m.info.id, m.info.role === 'assistant' && owner !== undefined && owner !== prevTurnOwner)
    if (m.info.role === 'assistant' && owner !== undefined) turnTail.set(owner, m.info.id)
    if (owner !== undefined) prevTurnOwner = owner
  }

  /**
   * 会话标题：用户发的第一条信息（过长在标题栏截断），计划会话再带上执行日期。
   *
   * 为什么不用会话标题：标题要么是内核自动生成的、要么是首条消息的前 30 个字，
   * 都不能一眼看出"这轮到底问了什么"；首条用户消息才是用户自己认得出的那个说法。
   * 「计划」会话另标日期——同一条计划每天产一个会话，光看标题分不出是哪天跑的。
   * 标题本体画在标题栏（放大按钮那一行），这里算好后上报给 App 转发。
   */
  const isSchedule = isScheduleSession(p.session?.title)
  const firstUserText = useMemo(() => {
    for (const m of msgs) {
      if (m.info.role !== 'user') continue
      const t = m.parts.filter((x) => x.type === 'text' && !x.synthetic).map((x) => x.text).join('')
      if (t && !isCtxOnly(t)) return t.trim()
    }
    return ''
  }, [msgs])
  const schedDate = isSchedule && p.session?.time?.created ? fmtYmd(p.session.time.created) : ''
  useEffect(() => {
    p.onHead(firstUserText ? { text: firstUserText, sched: isSchedule, date: schedDate } : null)
    // 卸载时清空：切到设置/计划任务页后标题栏不该还挂着上一轮的标题
    return () => p.onHead(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstUserText, isSchedule, schedDate])

  // 右上角审查卡片的统计：本会话累计 +N/-M（reviewFiles 已跨轮合并，行数直接求和）
  const revAdd = reviewFiles.reduce((s, f) => s + f.additions, 0)
  const revDel = reviewFiles.reduce((s, f) => s + f.deletions, 0)

  return (
    <div className="chat-row">
    {dragShield && <div className="drag-shield" />}
    <main
      ref={mainRef}
      className={'main' + (browserMax ? (floatOpen ? ' float' : ' hidden') : '')}
      style={browserMax && floatOpen && floatPos ? { right: floatPos.r, bottom: floatPos.b } : undefined}
    >
      {browserMax && floatOpen && (
        <>
          <div className="float-head" title={t('拖动移动位置 · 双击复位')}
            onPointerDown={startFloatDrag}
            onDoubleClick={() => { setFloatPos(null); save('qingniao.floatPos', null) }}>
            <span className="float-hint" title={panelUrl ? t('当前页面：{url}', { url: panelUrl }) : undefined}>
              <span className="float-hint-dot" />
              {t('AI 可对话操作此浏览器')}
            </span>
            <button className="float-close" title={t('收起对话')} onClick={() => setFloatOpen(false)}>
              <X size={16} />
            </button>
          </div>
        </>
      )}
      <div
        className="msgs"
        ref={scrollRef}
        onScroll={onMsgsScroll}
        onWheel={(e) => {
          // 上滚瞬间同步脱离吸底：流式期间 24ms 一帧的自动滚动会赶在 scroll 事件前把位置拉回底部；
          // 并开一个静音窗口，让随后程序化 scrollTop 触发的 scroll 事件也不得重新接管（见 onMsgsScroll）
          if (e.deltaY < 0) {
            wheelUpMuteUntilRef.current = performance.now() + 300
            atBottomRef.current = false
            setAtBottom(false)
          }
        }}
      >
        <div className="col">
          {visibleMsgCount === 0 && !busy && (
            <div className="empty">
              <div className="empty-title">{t('新对话')}</div>
              {panelOpen && panelUrl ? (
                <div>{t('在下方输入框提问，AI 会针对当前浏览器页面作答并直接操作这个浏览器')}</div>
              ) : (
                <div>{t('在下方输入框描述任务，AI 会直接在这个项目里读取、修改代码并执行终端命令')}</div>
              )}
              <div>{t('Enter 发送 · Shift+Enter 换行 · 处理中可随时停止，已发送的消息可编辑后重发')}</div>
            </div>
          )}
            {msgs.map((m) => {
              const owner = turnOwner.get(m.info.id)
              if (m.info.role === 'user') {
              // 自动续跑发的「继续」：隐藏气泡，重试进度走尾部状态条（第 x/10 次）
              if (autoContinueIds.current.has(m.info.id)) return null
              // 内核给用户消息挂的 synthetic 过程文本要排除掉：read 工具会在同一个用户
              // 消息里塞一条 `Called the Read tool with the following input: {...}`，
              // 不滤掉就会被拼进用户气泡，看着像用户自己输入了一串 JSON（实测 mp3 附件会这样）
              const txt = m.parts
                .filter((x) => x.type === 'text' && !x.synthetic)
                .map((x) => x.text)
                .join('')
              // 「仅上下文」注入（项目记忆 / 浏览器页面上下文），AI 可见但界面不渲染，保持对话顶部干净
              if (isCtxOnly(txt)) return null
              const fatts = m.parts
                .filter((x): x is Part & { mime: string; url: string } => x.type === 'file' && !!x.mime && !!x.url)
                .map((x) => ({ mime: x.mime, name: (x.filename || t('附件')).replace(/^.*[\\/]/, ''), url: x.url }))
              return (
                <div key={m.info.id} className="umsg-anchor" data-uid={m.info.id}>
                  <UserBubble key={m.info.id} text={txt} atts={fatts} editable={!busy} onSend={(t) => void resendMessage(m.info.id, t)} />
                </div>
              )
            }
            // 生成速率（见 genRateOf 注释）：拿不到就只显示模型名
            const rate = genRateOf(m)
            // 尾注（模型/速率/耗时）只挂回合**最后一条** AI 消息，其余一律不渲染——防重复多行。
            // 耗时与顶部「已工作」同口径（turnSpent，回合总时长）；老会话没有这份记录时
            // 退回消息自带的起止时间差（completed-created），再没有就不显示。
            const isTail = turnTail.get(owner ?? '') === m.info.id
            const spent = isTail
              ? (owner != null ? turnSpent[owner] : 0) ||
                (m.info.time?.completed && m.info.time?.created
                  ? Math.max(1, Math.round((m.info.time.completed - m.info.time.created) / 1000))
                  : 0)
              : 0
            return (
              <div key={m.info.id} className="amsg">
                {/* 轮首的「已工作」徽标：轮结束后固定显示该轮总耗时（处理中的实时时长看尾部状态条） */}
                {turnStarts.get(m.info.id) && owner != null && turnSpent[owner] ? (
                  <div className="turn-badge">{t('已工作 {v}', { v: fmtElapsed(turnSpent[owner]) })}</div>
                ) : null}
                {partRows(m.parts, p.project?.path).map((row) => {
                  if (row.kind === 'part') {
                    const part = row.part
                    return (
                      <PartView key={part.id} part={part} projectPath={p.project?.path} preview={previews[part.id]} live={busy && m.info.id === lastAid} diffs={diffs[turnOwner.get(m.info.id) ?? '']} />
                    )
                  }
                  // 相邻重复工具归组：组内最后一个 part 代表渲染，挂 ×N 角标
                  const last = row.last
                  const running = row.parts.find((x) => x.state?.status === 'running')
                  return (
                    <PartView key={last.id} part={last} projectPath={p.project?.path} preview={running ? previews[running.id] : previews[last.id]} previewParts={row.parts} live={busy && m.info.id === lastAid} diffs={diffs[turnOwner.get(m.info.id) ?? '']} count={row.parts.length} />
                  )
                })}
                {!busy && m.info.id === lastAid && msgErrorText(m) && (
                  <div className="msgerr">
                    <AlertCircle size={13} /> <span>{msgErrorText(m)}</span>
                  </div>
                )}
                {/* 本轮额外调用过的模型：只在真调过时出现，挂在回复末尾让用户对得上账。
                    与下面的模型尾注同规矩：busy 期间也要常驻，只藏正在流式的那条。 */}
                {(!busy || m.info.id !== lastAid) && !!usedByMsg[m.info.id]?.length && (
                  <div className="cu-models" title={usedByMsg[m.info.id].map((u) => `${u.label || u.id}（${u.provider || u.id}）`).join('\n')}>
                    <Cpu size={12} />
                    <span>{t('本轮另调用：')}{summarizeModels(usedByMsg[m.info.id])}</span>
                  </div>
                )}
                {/* 本次回复使用的模型：modelID/providerID 是内核持久化在消息里的，
                    重启后历史消息照样能显示。只挂回合最后一条（isTail）防多行重复；
                    后面依次追加生成速率与耗时。
                    **旧尾注要常驻**：不能整体被 !busy 门住——发新消息（busy）期间历史回合的
                    尾注必须还在，只藏正在流式生成的那条（lastAid），它落定后自然出现。 */}
                {(!busy || m.info.id !== lastAid) && m.info.modelID && isTail && (
                  <div
                    className="amsg-model"
                    title={
                      `${m.info.providerID || '?'}/${m.info.modelID}` +
                      (rate ? `\n${t('输出速率 = (输出+推理) tokens ÷ 纯生成时长，不含工具执行时间')}` : '')
                    }
                  >
                    <Cpu size={12} />
                    <span>{usedModelLabel(groups, m.info)}</span>
                    {rate && <span className="amsg-rate"> · {rate}</span>}
                    {!!spent && <span className="amsg-rate"> · {t('耗时 {v}', { v: fmtElapsed(spent) })}</span>}
                  </div>
                )}
              </div>
            )
          })}
          {/* 失败反馈走对话流：作为一条 AI 消息落在消息末尾，而非顶部弹条。
              末条 AI 消息已内联展示同一错误（msgErrorText）时不再重复——否则
              回合对账 setError 与消息自带 error 会一字不差地出现两遍（实测）。 */}
          {error && error !== inlineErr && (
            <div className="amsg">
              <div className="msgerr">
                <AlertCircle size={13} /> <span>{error}</span>
                <button className="icon-btn" title={t('关闭')} onClick={() => setError('')}>
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
          {/* 中性提示（自动换模型等）：同位置弱化版，不标红吓人 */}
          {notice && (
            <div className="amsg">
              <div className="msgnotice">
                <Info size={13} /> <span>{notice}</span>
                <button className="icon-btn" title={t('关闭')} onClick={() => setNotice('')}>
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
          {/*
            「调用其他模型」授权卡排在最前：它背后是一个**正在超时**的挂起调用（桌面代看只有 20s），
            排在最后会被别的弹窗挡住，用户还没看清就已经自动按拒绝处理了。
          */}
          {modelAsks.length > 0 && (
            <ModelAuthModal key={modelAsks[0].reqId} req={modelAsks[0]} onReply={(s) => replyModelAllow(modelAsks[0], s)} />
          )}
          {modelAsks.length === 0 && asks.length > 0 && (
            <AskModal key={asks[0].id} req={asks[0]} anchorRef={cwrapRef} onReply={(ans) => replyAsk(asks[0], ans)} onReject={() => rejectAsk(asks[0])} />
          )}
          {/* 权限询问：与助手提问互斥显示（同一时刻只弹一件事，避免两层弹窗叠在一起） */}
          {modelAsks.length === 0 && asks.length === 0 && perms.length > 0 && (
            <PermModal
              key={perms[0].id}
              req={perms[0]}
              dir={p.project?.path ?? ''}
              onReply={(r) => replyPerm(perms[0], r)}
            />
          )}
          {todos.length > 0 && <TodoCard todos={todos} live={busy} />}
          {/* 服务进程卡已移入底部工具行（完全控制后面的图标入口，带数量角标，点击展开清单） */}
          {busy && (
            <div className="amsg busyline">
              {terminalBlocked ? (
                t('终端运行中 · 新消息发送将接管任务')
              ) : (
                <>
                  <LoaderCircle size={13} className="spin" />
                  {asks.length > 0
                    ? t('等待你回答')
                    : msgs.some((m) => m.info.role === 'assistant' && !turnBase.current.has(m.info.id))
                      ? t('处理中，已用时 {v}', { v: turnElapsed })
                      : t('正在思考，已用时 {v}', { v: turnElapsed })}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 左侧用户消息锚点条：钉在对话区最左缘（侧栏菜单右侧），垂直居中、高度固定不随内容撑开。
          图标紧凑排列（间距小），点击立即定位到该条用户消息。设置 → 通用里开启才显示 */}
      {p.showUserAnchors && userAnchors.length > 1 && (
        <div className="msg-anchors" aria-label={t('用户消息跳转')}>
          <div className="ma-dots">
            {userAnchors.map((a, i) => (
              <button
                key={a.id}
                type="button"
                className="msg-anchor"
                // 悬停提示：光看一列小横条分不出对应哪条消息，把该条用户消息的首行摆出来
                // （userAnchors 里已经截好 24 字）。只有附件没有文字的退化成「第 n 条」。
                title={a.label ? t('第 {n} 条：{txt}', { n: i + 1, txt: a.label }) : t('第 {n} 条（无文字）', { n: i + 1 })}
                onClick={() => jumpToUserMsg(a.id)}
              >
                <Minus size={12} strokeWidth={3.2} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 右上角「代码审查」小卡片：本会话有文件改动才出现，图标 + 累计统计（+N/-M），点击开关右侧审查面板。
          全屏浏览时对话已变右下角浮动卡，卡片不渲染 */}
      {!browserMax && reviewFiles.length > 0 && (
        <button
          className="rev-card"
          title={reviewOpen ? t('关闭代码审查') : t('代码审查（本会话 AI 改动的文件）')}
          onClick={toggleReview}
        >
          <FileDiffIcon size={13} />
          {revAdd > 0 && <span className="rc-add">+{revAdd}</span>}
          {revDel > 0 && <span className="rc-del">-{revDel}</span>}
        </button>
      )}

      {!atBottom && (
        <div className="jumpwrap">
          <button className="jump" title={t('回到底部')} onClick={jumpBottom}>
            <ArrowDown size={16} />
          </button>
        </div>
      )}

      {/* 通知（中断重试）统一在输入窗上方的 .topnotify 里展示，这里只负责任务队列。 */}
      {curQueue.length > 0 && (
        <div className="qbar">
          <div className="col">
            <button className="qhead" onClick={() => setQCollapsed((v) => !v)}>
              {qCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              {t('任务队列 · {n} 条', { n: curQueue.length })}
              <span className="q-sub">{t('排队等当前任务完成')}</span>
            </button>
            {!qCollapsed &&
              curQueue.map((qt, i) => (
                <div key={i} className="qitem" title={qt}>
                  <span className="qi-no">{i + 1}</span>
                  <span className="qi-text">{qt}</span>
                  <span className="qacts">
                    <button className="icon-btn" title={t('立即执行（中断当前任务）')} onClick={() => queueSend(i)}>
                      <Send size={13} />
                    </button>
                    <button className="icon-btn" title={t('移回输入框编辑')} onClick={() => queueEdit(i)}>
                      <Pencil size={13} />
                    </button>
                    <button className="icon-btn danger" title={t('删除')} onClick={() => dropQueueItem(sidRef.current, i)}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {showTerms && (
        <Modal title={t('运行中的终端')} onClose={() => setShowTerms(false)}>
          {terms.filter((x) => x.status === 'running').map((tm) => (
            <div key={tm.id} className="term-row">
              <Terminal size={13} />
              <span className="term-cmd" title={[tm.command, ...(tm.args ?? [])].filter(Boolean).join(' ')}>
                {tm.title || tm.command}
              </span>
              {tm.pid ? <span className="term-pid">PID {tm.pid}</span> : null}
              <button className="icon-btn danger" title={t('终止终端')} onClick={() => killTerm(tm)}>
                <X size={13} />
              </button>
            </div>
          ))}
          {terms.filter((x) => x.status === 'running').length === 0 && (
            <div className="mp-empty">{t('当前没有运行中的终端')}</div>
          )}
        </Modal>
      )}

      {/* 通知区：所有状态通知贴在聊天输入窗（.cwrap）上方、水平居中。
          「聊天对话框上方」指的是输入框上头这条，不是界面/消息区最顶部。
          用流内嵌而非绝对定位浮层——浮层会横向盖住下方、可能压到任务队列；
          这里在任务队列之后、输入框之前，消息流滚动不影响它（.msgs 是独立滚动区）。 */}
      <div className="topnotify" />
<div className="cwrap" ref={cwrapRef}>
        <div className="cbox col">
          <textarea
            ref={taRef}
            className="ctext"
      value={input}
rows={2}
            // 内核没就绪时输入禁用（2026-10-14 用户定版：宁可禁用输入也不弹错误条、不加提示文案）。
            // readOnly 而不是 disabled：内容还能看见/选中复制，样式也不会整体变灰。
            readOnly={!kernelReady}
            placeholder={
              busy
        ? t('当前任务执行中，输入新需求可加入队列')
    : panelUrl && panelOpen
          ? t('针对当前浏览器页面提问，AI 会直接操作这个浏览器')
     : t('Enter 发送 / Shift+Enter 换行')
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {              // Ctrl+Z 回看已发送消息（草稿先存，前进时恢复）；Ctrl+Y / Ctrl+Shift+Z 前进
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
          {atts.length > 0 && (
            <div className="catts">
              {atts.map((a, i) => (
                <span key={a.path + i} className="catt">
                  {a.mime.startsWith('image/') ? (
                    <img src={a.url} alt={a.name} />
                  ) : (
                    <span className="catt-file" title={a.path}>
                      {/* 音频给个音符图标：与视频区分开，用户一眼看出这条是「要转文字的」 */}
                      {a.mime.startsWith('audio/') ? <Music size={12} /> : <Film size={12} />}
                      <span>{a.name}</span>
                    </span>
                  )}
                  <button className="catt-x" title={t('移除附件')} onClick={() => setAtts((prev) => prev.filter((_, j) => j !== i))}>
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="crow">
<button
  className="icon-btn"
      title={
   busy
          ? t('处理中不能上传附件')
          : t('上传图片、视频或音频（图片配合生图模型可图生图；音频可让 AI 转文字）')
      }
   disabled={busy || !kernelReady}
   onClick={() => void pickAtt()}
      >
   <Paperclip size={14} />
      </button>
            {!p.codeMode && (
              <>
                <ProjectPicker
                  projects={p.projects}
                  value={p.project?.id}
                  onChange={p.onSwitchProject}
                  onPickDir={p.onPickDir}
                />
                <AccessPicker access={p.access} onChange={p.onAccess} />
              </>
            )}
            {/* 本会话服务进程入口（2026-10-12 从对话流进程卡迁来）：排在「完全控制」后面，
                图标右上角数量角标，点击向上展开进程清单；无进程时整个入口不显示 */}
            {svcProcs.length > 0 && (
              <div className="menu-wrap svc" ref={svcWrapRef}>
                <button
                  type="button"
                  className={'crow-term svc-trigger' + (svcOpen ? ' on' : '')}
                  title={t('本会话服务进程')}
                  onClick={() => setSvcOpen((v) => !v)}
                >
                  <span className="svc-badge-wrap">
                    <Terminal size={13} />
                    <span className="svc-badge">{svcProcs.length}</span>
                  </span>
                </button>
                {svcOpen && (
                  <div className="menu-panel svc up">
                    <div className="svc-head">
                      <Terminal size={13} />
                      <span>{t('本会话服务进程')}</span>
                      <span className="svc-count">{svcProcs.length}</span>
                    </div>
                    {svcProcs.map((proc) => (
                      <div className="svc-item" key={proc.pid}>
                        <span className="svc-dot" />
                        <span className="svc-cmd" title={proc.cmd}>
                          {proc.cmd}
                        </span>
                        {proc.port != null && <span className="svc-port">:{proc.port}</span>}
                        <span className="svc-pid">PID {proc.pid}</span>
                        <button className="icon-btn" title={t('停止进程（含子进程）')} onClick={() => stopProc(proc.pid)}>
                          <Square size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {terms.some((x) => x.status === 'running') && (
              <button className="crow-term" title={t('运行中的终端')} onClick={() => setShowTerms(true)}>
                <Terminal size={13} />
                {terms.filter((x) => x.status === 'running').length}
              </button>
            )}
            {/* 本地服务面板已移除（2026-09-27 用户反馈：轮询拖慢界面，整个功能不要了） */}
            {/* 内置浏览器入口只在右上角标题栏（2026-09-27 用户要求：底部图标冗余） */}
            <span className="spacer" />
            <ModelPicker
              groups={groups}
              value={p.model}
              // 窄窗口（<1308）/内置浏览器面板打开/代码模式：都只显示 / 后面的模型短名
              codeMode={p.codeMode || panelOpen || !winWide}
              onChange={p.onModelChange}
              onOpenSettings={p.onOpenSettings}
              onExpandGroup={(id) => void refreshGroupPrices(id)}
              refreshingGroup={refreshingGroup}
              onOpen={() => void syncFree()}
            />
            {/* 全屏浏览时不显示思考档位：浏览器场景直接回答，不需调思考深度 */}
            {!p.codeMode && !browserMax && <ThinkingPicker value={thinkVal} onChange={setThinkSel} kind={thinkKind} />}
/* 只有本会话在跑才显示停止：别的会话是用户另开的并行任务，不该被这里的按钮掐掉 */
       {busy ? (
    <button className="send-round stop" title={t('停止当前任务，队列任务自动接续')} onClick={() => void stopCurrent()}>
            <Square size={15} fill="currentColor" strokeWidth={0} />
       </button>
       ) : (
<button
              className="send-round"
              disabled={!kernelReady || (!input.trim() && !atts.length)}
              onClick={send}
   title={t('发送')}
        >
              <Send size={15} />
    </button>
      )}
          </div>
        </div>
      </div>
    </main>
    {/* 右侧代码审查面板：列出本会话被 AI 改到的文件（+N/-M），点开可看差量或全文；与浏览器面板互斥 */}
    {reviewOpen && <ReviewPanel projectPath={p.project?.path} files={reviewFiles} onClose={() => setReviewOpen(false)} />}
    {/* webview 挂上就不再卸载（AI 要一直能操作它），显不显示只看 visible */}
    {(panelOpen || panelBorn) && (
      <BrowserPanel
        visible={panelOpen}
        url={pinnedUrl || aiBrowseUrl}
        navSeq={pinSeq}
        max={browserMax}
        slot={tbSlot}
        onUrl={setPanelUrl}
        marks={marks}
        onToggleMark={toggleMark}
        chatHidden={chatHidden}
        onToggleChat={toggleChatVisible}
      />
    )}
    {/* 全屏 + 对话未彻底隐藏时才留这颗气泡；藏掉后由标题栏「AI 对话」按钮负责唤回 */}
    {browserMax && !chatHidden && (
      <button
        ref={fabRef}
        className="chat-fab"
        title={floatOpen ? t('收起对话（可拖动换位置）') : t('打开对话（可拖动换位置）')}
        style={fabPos ? { right: fabPos.r, bottom: fabPos.b } : undefined}
        onPointerDown={startFabDrag}
        onClick={() => { if (!fabDragged.current) setFloatOpen((v) => !v) }}
      >
        {floatOpen ? <X size={18} /> : <MessageCircle size={18} />}
      </button>
    )}
    </div>
  )
}
/** 右侧「代码审查」面板：列出本会话被 AI 改到的文件（+N/-M），点开可看该文件的差量或全文。
 *  数据来自 ChatView 已按轮拉好的 diff 聚合；全文经主进程 workspaceRead 直接读磁盘。 */
function ReviewPanel({ projectPath, files, onClose }: {
  projectPath?: string
  files: FileDiff[]
  onClose: () => void
}) {
  const [sel, setSel] = useState<FileDiff | null>(null)
  const [mode, setMode] = useState<'diff' | 'full'>('diff')
  const [full, setFull] = useState('')
  const [fullErr, setFullErr] = useState('')
  const [loading, setLoading] = useState(false)
  /** 左缘拖出的面板宽度（px）；null = 默认 40%（与浏览面板同判据） */
  const [width, setWidth] = useState<number | null>(null)
  const [dragShield, setDragShield] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)

  /** 拖左缘调宽：指针 capture 全程留在主文档，对话列保底 320px（与浏览面板同判据） */
  function startResize(e: ReactPointerEvent) {
    e.preventDefault()
    setDragShield(true)
    const panel = panelRef.current
    const row = panel?.parentElement
    if (!panel || !row) return
    const x0 = e.clientX
    const w0 = panel.offsetWidth
    const move = (ev: PointerEvent) =>
      setWidth(Math.min(Math.max(240, w0 - (ev.clientX - x0)), Math.max(240, row.clientWidth - 320)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragShield(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  // 切文件/模式/项目时载入全文（仅「全文」模式需要）；file 可能是绝对路径，读盘必须用相对项目路径
  useEffect(() => {
    if (!sel || mode !== 'full' || !projectPath) return
    setLoading(true)
    setFullErr('')
    setFull('')
    window.qingniao
      .workspaceRead(projectPath, relPath(sel.file, projectPath))
      .then((r) => setFull(r.content))
      .catch((e: unknown) =>
        setFullErr(e instanceof Error && e.message ? e.message : t('读取失败（文件可能已删除或并非文本）')))
      .finally(() => setLoading(false))
  }, [sel, mode, projectPath])

  return (
    <aside
      ref={panelRef}
      className="review-panel"
      style={width != null ? { width, maxWidth: 'none' } : undefined}
    >
      {dragShield && <div className="drag-shield" />}
      <div className="rp-resizer" title={t('拖拽调整面板宽度')} onPointerDown={startResize} />
      <div className="rp-head">
        <span className="rp-title">
          {t('代码审查')}
          {files.length > 0 && <em className="rp-count" title={t('本会话改动的文件数')}>{files.length}</em>}
        </span>
        <button className="icon-btn" title={t('关闭')} onClick={onClose}><X size={14} /></button>
      </div>
      <div className="rp-list">
        {files.length === 0 ? (
          <div className="rp-empty">{t('本会话还没有文件改动')}</div>
        ) : (
          files.map((fd) => {
            // 显示与读取都用**相对当前项目**的路径（diff 里可能是绝对路径，拼绝对值会读不到也对不上更不美观）
            const rel = projectPath ? relPath(fd.file, projectPath) : fd.file
            const open = !!sel && normPath(relPath(sel.file, projectPath ?? '')) === normPath(rel)
            return (
              <div key={normPath(rel)} className={'rp-file' + (open ? ' open' : '')}>
                <button
                  className="rp-file-row"
                  title={rel}
                  onClick={() => setSel(open ? null : fd)}
                >
                  <span className="rp-file-name">{rel}</span>
                  <span className="rp-file-stat" title={t('新增 {a} 行 · 删除 {b} 行', { a: fd.additions, b: fd.deletions })}>
                    {fd.status === 'added' && <span className="rp-status rp-add">{t('新增')}</span>}
                    {fd.status === 'deleted' && <span className="rp-status rp-del">{t('删除')}</span>}
                    {fd.additions > 0 && <span className="d-add">+{fd.additions}</span>}
                    {fd.deletions > 0 && <span className="d-del">-{fd.deletions}</span>}
                  </span>
                </button>
                {open && (
                  <div className="rp-body">
                    <div className="rp-tabs">
                      <button className={mode === 'diff' ? 'on' : ''} onClick={() => setMode('diff')}>{t('差量')}</button>
                      <button className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')}>{t('全文')}</button>
                    </div>
                    <div className="rp-code">
                      {mode === 'diff' ? (
                        fd.patch
                          ? <CodeBlock text={fd.patch} diff file={rel} />
                          : <div className="rp-empty">{t('该文件没有可展示的差量，点「全文」查看')}</div>
                      ) : loading ? (
                        <div className="rp-empty">{t('读取中…')}</div>
                      ) : fullErr ? (
                        <div className="rp-empty">{fullErr}</div>
                      ) : (
                        <CodeBlock text={full} file={rel} force />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
/** 左侧浏览面板：内嵌浏览器（webview 直接渲染网址，可交互，左缘可拖宽）；导航工具栏经 portal 放到标题栏中间，分享/放大/关闭不再重复（用标题栏右上角原生功能） */
function BrowserPanel({ visible, url, navSeq, max, slot, onUrl, marks, onToggleMark, chatHidden, onToggleChat }: {
  /** 面板是否可见：false 时只隐藏 UI，webview 继续挂着，AI 照常能操作 */
  visible: boolean
  url: string
  /** 用户点链开面板的计数：变化时即使地址相同也强制重新导航 */
  navSeq: number
  max: boolean
  slot: HTMLElement | null
  /** 页面导航（AI / 手输 / 页内跳转）回传当前 URL：浏览器对话上下文与星标判断的数据源 */
  onUrl: (u: string) => void
  marks: Bookmark[]
  onToggleMark: (url: string, title: string) => void
  /**
   * AI 对话是否已被彻底隐藏（连右下角气泡一起藏掉）：决定地址栏那颗按钮的图标与提示，
   * 也决定标题栏的「AI 对话」按钮还留不留（留着才找得回来）。面包板只读它，不改。
   */
  chatHidden: boolean
  /** 地址栏那颗按钮：开关 AI 对话（收卡片 → 藏气泡 → 整块复原，见 toggleChatVisible） */
  onToggleChat: () => void
}) {
  // 地址栏可手输回车导航：AI 新导航（prop url 变化）会同步进来，用户手输不回写会话
  const [addr, setAddr] = useState(url)
  /** webview 的首航地址：只在挂载那一刻用，之后导航全走 loadURL，避免 React 改 src 造成二次加载 */
  const [src] = useState(url || 'about:blank')
  /** 当前页标题：收藏时作显示名（page-title-updated 事件跟踪） */
  const [title, setTitle] = useState('')
  /** 左缘拖出的面板宽度（px）；null = 默认 40% */
  const [width, setWidth] = useState<number | null>(null)
  /** webview 历史状态：驱动前进/后退按钮可用性 */
  const [nav, setNav] = useState({ back: false, fwd: false })
  /** 当前页是否已收藏：星标填充态 */
  const starred = marks.some((m) => m.url === addr)
  const wvRef = useRef<WebviewTag | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  /** 调宽拖拽护罩：拖动期间盖住 webview，指针事件留在主文档 */
  const [dragShield, setDragShield] = useState(false)
  /** Electron 的 webview ref 赋值不等于 guest 已挂载；只有 dom-ready 后才能调用其方法 */
  const [wvReady, setWvReady] = useState(false)
  /** webview 尚未就绪时，用户地址栏输入的地址先存这里，ready 后补导航 */
  const pendingUrlRef = useRef('')

  const syncNav = useCallback(() => {
    const wv = wvRef.current
    if (!wv) return
    setNav({ back: wv.canGoBack(), fwd: wv.canGoForward() })
  }, [])
  const onWvReady = useCallback(() => setWvReady(true), [])
  const onWvNav = useCallback((e: { url: string }): void => {
    setAddr(e.url)
    onUrl(e.url)
    syncNav()
  }, [onUrl, syncNav])
  const onWvTitle = useCallback((e: { title: string }): void => {
    setTitle(e.title)
  }, [])
  const bindWv = useCallback((wv: WebviewTag | null) => {
    const old = wvRef.current
    if (old === wv) return
    if (old) {
      old.removeEventListener('dom-ready', onWvReady)
      old.removeEventListener('did-navigate', onWvNav)
      old.removeEventListener('did-navigate-in-page', onWvNav)
      old.removeEventListener('page-title-updated', onWvTitle)
    }
    wvRef.current = wv
    setWvReady(false)
    if (wv) {
      wv.addEventListener('dom-ready', onWvReady)
      wv.addEventListener('did-navigate', onWvNav)
      wv.addEventListener('did-navigate-in-page', onWvNav)
      wv.addEventListener('page-title-updated', onWvTitle)
    }
  }, [onWvNav, onWvReady, onWvTitle])

  const lastNavSeq = useRef(navSeq)
  useEffect(() => {
    const force = navSeq !== lastNavSeq.current
    lastNavSeq.current = navSeq
    const wv = wvRef.current
    if (!wvReady || !wv) return
    const target = pendingUrlRef.current || url
    if (!target) return
    pendingUrlRef.current = ''
    // 比 webview 的真实地址，而不是 addr：AI 走主进程 loadURL 时消息更新可能早于
    // did-navigate 事件，只看 addr 会把同一个地址再导航一遍
    if (!force && samePage(wv.getURL(), target)) {
      setAddr(target)
      return
    }
    setAddr(target)
    wv.loadURL(target)
  }, [url, navSeq, wvReady])

  // webview 由 React 直接管理 src（addr 变化即导航）；这里挂内核事件把页内跳转同步回地址栏
  /** 每次导航后查一遍历史状态，驱动前进/后退按钮可用性 */
  function loadAddr(v: string) {
    const u = /^\w+:\/\//.test(v.trim()) ? v.trim() : 'https://' + v.trim()
    if (!u) return
    setAddr(u)
    if (!wvReady || !wvRef.current) {
      pendingUrlRef.current = u
      return
    }
    wvRef.current.loadURL(u)
  }

  /** 拖左缘调宽：pointer capture 让指针划过 webview 时事件不丢 */
  function startResize(e: ReactPointerEvent) {
    e.preventDefault()
    setDragShield(true)
    const panel = panelRef.current
    const row = panel?.parentElement
    if (!panel || !row) return
    const x0 = e.clientX
    const w0 = panel.offsetWidth
    const move = (ev: PointerEvent) =>
      setWidth(Math.min(Math.max(240, w0 - (ev.clientX - x0)), Math.max(240, row.clientWidth - 320)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragShield(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const head = (
    <div className="bp-head">
      <button className="icon-btn" disabled={!nav.back} title={t('后退')} onClick={() => wvRef.current?.goBack()}>
        <ArrowLeft size={15} />
      </button>
      <button className="icon-btn" disabled={!nav.fwd} title={t('前进')} onClick={() => wvRef.current?.goForward()}>
        <ArrowRight size={15} />
      </button>
      <input
        className="bp-url"
        value={addr}
        placeholder={t('输入网址回车打开')}
        spellCheck={false}
        onChange={(e) => setAddr(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') loadAddr((e.target as HTMLInputElement).value)
        }}
      />
      <button
        className={'icon-btn bp-star' + (starred ? ' starred' : '')}
        title={starred ? t('取消收藏') : t('收藏此页面（全屏时顶部显示收藏条）')}
        onClick={() => onToggleMark(addr, title || hostOf(addr))}
      >
        <Star size={14} fill={starred ? 'currentColor' : 'none'} />
      </button>
      {/* 全屏时才显示：紧跟地址栏，一颗按钮开关 AI 对话。
          用「电源」图标而不是「对话气泡 + 斜杠」——它是一个开关，不是"把某个东西删掉"；
          且**任何状态下都可点**（禁用态会让人以为按钮坏了，而这颗正是唯一的自救入口）。 */}
      {max && (
        <button
          className={'icon-btn bp-chat-switch' + (chatHidden ? ' off' : '')}
          title={
            chatHidden
              ? t('AI 对话已隐藏 · 点击显示右下角气泡')
              : t('AI 对话显示中 · 点击隐藏')
          }
          onClick={onToggleChat}
        >
          <MessageCircleOff size={15} />
        </button>
      )}
    </div>
  )

  return (
    <>
      {visible && slot && createPortal(head, slot)}
      {dragShield && <div className="drag-shield" />}
      <aside
        ref={panelRef}
        // 隐藏时连 max 都不挂：CSS 里 :has(.max) 会连带隐藏侧栏，那是「用户正看着」才该有的效果
        className={'browser-panel' + (visible ? (max ? ' max' : '') : ' hidden')}
        style={visible && width != null && !max ? { width, maxWidth: 'none' } : undefined}
      >
        {visible && !max && <div className="bp-resizer" onPointerDown={startResize} />}
        {/* 全屏时的收藏夹条：点击直达，hover 出现取消收藏；无网址的浏览模式入口也能一键开收藏页 */}
        {visible && max && marks.length > 0 && (
          <div className="bp-marks">
            {marks.map((m) => (
              <div
                key={m.url}
                className={'bp-mark' + (m.url === addr ? ' on' : '')}
                title={m.url}
                onClick={() => loadAddr(m.url)}
              >
                <span className="bp-mark-t">{m.title}</span>
                <button
                  className="bp-mark-x"
                  title={t('取消收藏')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleMark(m.url, '')
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* webview 常驻：AI 的 panel_* 要随时能操作它，面板收起也不能卸载 */}
        <webview
          ref={bindWv}
          className="bp-wv"
          src={src}
          partition="persist:webpanel"
          allowpopups={false}
        />
        {!addr && <div className="bp-nourl">{t('在顶部地址栏输入网址后回车打开')}</div>}
      </aside>
    </>
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
    polled.filter((m) => m.info.role === 'user').map((m) => userTextOf(m))
  )
  known.forEach((m) => {
    if (m.info.id.startsWith('tmp-') && realUserTexts.has(userTextOf(m))) return
    out.push(m)
  })
  return changed ? out : prev
}

/**
 * 用户消息的正文（仅用户真正写的字，已滤掉内核塞的 synthetic 过程文本）。
 *
 * **必须是「只取用户自己写的字」**，不能简单 join 全部 text part：
 * 内核会往同一条用户消息里追加 `Called the Read tool with the following input: {...}`，
 * 于是真实消息的拼串变成「转文字\nCalled the Read tool...」，与乐观气泡的「转文字」
 * 永远不相等 —— 文本去重失效、气泡顶不掉，界面上就冒出两个用户气泡
 * （AI 回复后被全量刷新覆盖才恢复正常）。发音频附件必触发，因为 AI 一定会去 read 它。
 */
function userTextOf(m: MessageView): string {
  return m.parts
    .filter((x) => x.type === 'text' && !x.synthetic)
    .map((x) => x.text ?? '')
    .join('\n')
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
    /*
     * 真实用户消息的 part 陆续抵达时要顶掉乐观插入的 tmp 气泡，否则会短暂并排两个气泡。
     *
     * part 到达顺序不保证，所以 **任意** 用户 part（text / file）都试着认领一次，
     * 命中条件看该 part 本身：
     *  - 有非 synthetic 正文 → 按正文比对（userTextOf 已滤 synthetic）；
     *  - 正文为空但带附件（纯附件发送）→ 认领「正文也为空且带附件」的 tmp。
     * 否则会漏：只发附件时 text part 是空串，先到的是它，按纯文本比对永远匹配不上。
     */
    if (roles.get(part.messageID) === 'user' && (part.type === 'text' || part.type === 'file')) {
      const own = part.type === 'text' && !part.synthetic ? (part.text ?? '') : ''
      next = next.filter((m) => {
        if (!m.info.id.startsWith('tmp-')) return true
        return own ? userTextOf(m) !== own : !(userTextOf(m).trim() === '' && m.parts.some((x) => x.type === 'file'))
      })
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
 * defaultOpen = 初始就展开（AI 回复正文用——自动展开全文，超长可手动收起）。
 */
function Collapsible({
  children,
  maxPx,
  forceText,
  live,
  defaultOpen
}: {
  children: ReactNode
  /** 折叠阈值（px） */
  maxPx: number
  /** 判定用纯文本；不传则只看高度 */
  forceText?: string
  /**
   * 这条正文正在流式输出。
   *
   * 流式中**一律不折叠**：文字一长过阈值就立刻塌成「展开全文」条，用户正读着的那段
   * 突然消失、接着新文字又冒出来，看起来就是"回复中间断出空白又继续输出"。
   * 等这轮结束（live 转 false）再按高度折叠，用户读的是连续的整段。
   */
  live?: boolean
  /** 初始展开（默认收起）；只在超长时出现「收起/展开全文」按钮 */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  const [over, setOver] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // 文本变化即复测（流式输出时先不高，长到超阈值才出现按钮）
  useEffect(() => {
    const el = ref.current
    if (el) setOver(el.scrollHeight > maxPx + 8)
  }, [forceText, maxPx, live])
  // 流式中不裁：over 照常算（结束后按钮立刻可用），但这一帧不套 maxHeight
  const clipped = over && !open && !live
  return (
    <div className="cbl">
      <div
        ref={ref}
        className={clipped ? 'cbl-body clipped' : 'cbl-body'}
        style={clipped ? { maxHeight: maxPx } : undefined}
      >
        {children}
      </div>
      {/* 「展开全文」按钮流式中也不显示：它一出现就说明正文被裁，而这时并没裁，
          摆一颗点了没反应的按钮只会让人困惑 */}
      {over && !live && (
        <button className="cbl-toggle" onClick={() => setOpen((v) => !v)}>
          <ChevronDown size={12} className={open ? 'up' : undefined} />
          {open ? t('收起') : t('展开全文')}
        </button>
      )}
    </div>
  )
}

/** 用户消息气泡：附件（上传的图片/视频）渲染在正文上方；超过 6 行自动折叠；悬浮显示 编辑/复制 */
/** 用户消息气泡：操作列（编辑/复制）在气泡下方；编辑时在该行展开聊天窗样式的输入框 + 取消/发送
 * 发送只更新这条消息并让 AI 重新回复（见 ChatView.resendMessage）；附件只作展示，编辑重发只带文字 */
function UserBubble({
  text,
  atts,
  editable,
  onSend
}: {
  text: string
  atts?: { mime: string; name: string; url: string }[]
  editable?: boolean
  onSend: (t: string) => void
}) {
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
            <span className="uedit-hint">{t('更新这条消息，下方的 AI 回复会重新生成')}</span>
            <button className="ghost" onClick={() => setEditing(false)}>
              {t('取消')}
            </button>
            <button className="primary" disabled={!draft.trim()} onClick={sendEdit}>
              {t('发送')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="umsg">
      <div className="ubox">
        {atts && atts.length > 0 && (
          <div className="uatts">
            {atts.map((a, i) =>
              a.mime.startsWith('video/') || a.mime.startsWith('audio/') ? (
                // 音频与视频都不是图片：file:// 在渲染层放不了，只显名称条。
                // （audio/ 必须单独判——漏了会掉进下面的 <img>，src 是 file:// 直接裂图）
                <span key={i} className="uatt-video" title={a.name}>
                  {a.mime.startsWith('audio/') ? <Music size={11} /> : <Film size={11} />}
                  <span className="uatt-name">{a.name}</span>
                </span>
              ) : (
                <img key={i} className="uatt-img" src={a.url} alt={a.name} title={a.name} />
              )
            )}
          </div>
        )}
        <Collapsible maxPx={150} forceText={text}>
          <div className="ubub">{text}</div>
        </Collapsible>
        {/* 操作列在气泡下方，hover 显示 */}
        <div className="uacts">
          {editable && (
            <button className="icon-btn" title={t('编辑消息')} onClick={() => { setDraft(text); setEditing(true) }}>
              <Pencil size={12} />
            </button>
          )}
          <button
            className="icon-btn"
            title={copied ? t('已复制') : t('复制')}
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
          {t('任务清单')}
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
  invalid: { name: '无效调用', icon: <AlertCircle size={13} /> },
  // 内置 MCP（resources/mcp/）：内核按 serverInfo.name 加前缀注册（qingniao-media → media_、
  // qingniao-music → music_、qingniao-tts → tts_、qingniao-asr → asr_、qingniao-vision → vision_、
  // panel-browser → panel_），渲染层拿到的就是前缀名
  media_generate_image: { name: '生成图片', icon: <Film size={13} /> },
  media_create_video: { name: '生成视频', icon: <Film size={13} /> },
  media_check_video: { name: '查视频任务', icon: <Film size={13} /> },
  music_generate_music: { name: '生成音乐', icon: <Music size={13} /> },
  music_check_music: { name: '查音乐任务', icon: <Music size={13} /> },
  tts_generate_speech: { name: '配音', icon: <Music size={13} /> },
  asr_transcribe_audio: { name: '听写', icon: <Music size={13} /> },
  vision_describe_image: { name: '识图', icon: <Search size={13} /> },
  data_json_query: { name: 'JSON 取值', icon: <Braces size={13} /> },
  data_regex_find: { name: '正则提取', icon: <Regex size={13} /> },
  panel_navigate: { name: '浏览器导航', icon: <Globe size={13} /> },
  panel_snapshot: { name: '页面快照', icon: <Globe size={13} /> },
  panel_click: { name: '点击元素', icon: <MousePointerClick size={13} /> },
  panel_type: { name: '元素输入', icon: <Keyboard size={13} /> }
}

/** 内核提问应答弹窗：一问一答逐步进行（上一步/下一步），最后一步提交全部答案 */
function AskModal({
  req,
  anchorRef,
  onReply,
  onReject
}: {
  req: QuestionAsk
  anchorRef: RefObject<HTMLElement | null>
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
    <Modal title={t('助手提问 {a}/{b}', { a: i + 1, b: req.questions.length })} anchor="above" anchorRef={anchorRef} onClose={onReject}>
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
              placeholder={t('自定义回答，回车添加…')}
              onChange={(e) => setDraft((prev) => prev.map((d, k) => (k === i ? e.target.value : d)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCustom()
                }
              }}
            />
            <button type="button" className="ghost" onClick={addCustom}>
              {t('添加')}
            </button>
          </div>
        )}
      </div>
      <div className="ask-acts">
        {i > 0 && (
          <button className="ghost" onClick={() => setStep(i - 1)}>
            {t('上一步')}
          </button>
        )}
        {!last && (
          <button className="primary" onClick={() => setStep(i + 1)}>
            {t('下一步')}
          </button>
        )}
        {last && (
          <button className="primary" onClick={() => onReply(req.questions.map((_, k) => sel[k] ?? []))}>
            {t('提交答案')}
          </button>
        )}
        <button className="ghost" onClick={onReject}>
          {t('跳过')}
        </button>
      </div>
    </Modal>
  )
}

/**
 * 权限确认弹窗：默认权限档位下，AI 要改文件 / 执行命令时内核停在这里等用户点头。
 *
 * 三个出口对应内核的三种应答：
 *   仅这一次（once）  —— 放行这一下，下次还问。**默认推荐**，卡在最左最显眼处
 *   总是允许（always）—— 本会话内同类操作不再问。内核只在给了 always 候选时才认，故按需显示
 *   拒绝（reject）    —— 拦下，AI 会收到拒绝并另想办法
 *
 * 展示上把「要动什么」放在最显眼处：用户判断该不该放行，靠的就是那几个路径/命令，
 * 而不是「edit」这个工具名。命令类内容用等宽字体，避免把 `rm -rf` 看成普通文本。
 */
function PermModal({
  req,
  dir,
  onReply
}: {
  req: PermissionAsk
  /** 当前项目目录：把绝对路径缩短成相对路径，长路径一眼能看出是项目里的哪个文件 */
  dir: string
  onReply: (r: 'once' | 'always' | 'reject') => void
}) {
  const { kind, targets } = req
  const rawLabel = PERM_LABEL[kind] ?? kind ?? t('操作')
  const label = t(rawLabel)
  /** 命令类：整行等宽显示；文件类：缩成相对项目路径 */
  const isCmd = /bash|shell|command|exec/i.test(kind)
  const shown = targets.map((tg) => (isCmd ? tg : relPath(tg, dir)))

  return (
    <Modal title={t('是否允许{what}？', { what: label })} anchor="top" onClose={() => onReply('reject')}>
      <div className="perm-q">
        <p className="perm-lead">
          {t('AI 想{what}，需要你确认：', { what: label })}
        </p>
        {shown.length > 0 && (
          <ul className="perm-list">
            {shown.map((tg, i) => (
              <li key={i} className={isCmd ? 'mono' : undefined} title={targets[i]}>
                {tg}
              </li>
            ))}
          </ul>
        )}
        <p className="perm-note">
          {t('选「仅这一次」只放行这一下，之后同类操作仍会问你；「总是允许」在本会话内不再询问。想彻底不再问，可把该项目的访问权限改为「完全控制」。')}
        </p>
      </div>
      <div className="perm-acts">
        <button className="primary" onClick={() => onReply('once')}>
          {t('仅这一次')}
        </button>
        {req.always.length > 0 && (
          <button className="ghost" onClick={() => onReply('always')}>
            {t('总是允许')}
          </button>
        )}
        <button className="ghost danger-text" onClick={() => onReply('reject')}>
          {t('拒绝')}
        </button>
      </div>
    </Modal>
  )
}

/** 权限动作名 → 中文（认不出就用原文，别吞掉信息） */
const PERM_LABEL: Record<string, string> = {
  edit: '修改文件',
  write: '写入文件',
  bash: '执行命令',
  read: '读取文件',
  glob: '搜索文件',
  grep: '搜索内容',
  list: '列出目录',
  webfetch: '访问网页',
  external_directory: '访问项目外目录'
}

/**
 * 把本轮用过的额外模型压成一行：`看图（视觉代看）「deepseek-flash」×3 · 生成图片「agnes-image-2」`。
 *
 * 为什么要带次数：用户真正关心的是「这一轮被扣了几次别的模型的钱」，
 * 只说「用了 deepseek-flash」看不出是读了一次屏还是读了十次。
 */
function summarizeModels(list: ModelUsed[]): string {
  const byRole = new Map<string, ModelUsed[]>()
  for (const u of list) {
    const arr = byRole.get(u.role) ?? []
    arr.push(u)
    byRole.set(u.role, arr)
  }
  return [...byRole.entries()]
    .map(([role, items]) => {
      const rl = MODEL_ROLE_LABEL[role]
      const names = [...new Set(items.map((x) => x.label || x.id))].join('、')
      return `${rl ? t(rl) : role}${t('「{name}」', { name: names })}${items.length > 1 ? `×${items.length}` : ''}`
    })
    .join(' · ')
}

/**
 * 一条 AI 消息「这次是谁答的」：内核把 providerID/modelID 持久化在消息 info 里，
 * 重启后历史照样读得到，所以这里只做展示名的翻译，不依赖任何本机状态。
 *
 * 展示优先级：模型在当前分组里的展示名 > modelID 短名（去厂商前缀）；
 * 提供商给了分组名就带上（用户常在多家之间切，只写模型名对不上账）。
 */
function usedModelLabel(groups: ModelGroup[], info: { providerID?: string; modelID?: string }): string {
  const mid = info.modelID || ''
  const g = info.providerID ? groups.find((x) => x.id === info.providerID) : undefined
  const short = (n: string): string => {
    const i = n.lastIndexOf('/')
    return i >= 0 ? n.slice(i + 1) : n
  }
  const name = short(g?.models.find((x) => x.mid === mid)?.name || mid) || mid
  const label = g?.label || info.providerID || ''
  return label ? `${label} · ${name}` : name
}

/**
 * 回复尾部的生成速率：`(输出 + 推理) tokens ÷ 纯生成时长`，如 `148 token/s`。
 *
 * 分母**不能用** `time.completed - created`：那是整个回合的墙钟时长，工具执行
 * （读文件、跑命令动辄几十秒）全算在内，速率会被拉到没法看。真正的生成窗口是
 * text / reasoning part 各自的 `time.start~end`（模型在出字的时间段），合并重叠后求和。
 * 分子把 reasoning 算上是因为分母里 reasoning part 的时长也算进去了——两边口径一致；
 * 内核库里 output 与 reasoning 是分开计的两项（total = 各项之和，实测验证过）。
 *
 * 全部数据来自内核持久化的消息，重启后历史消息照样能算。拿不到（中断消息、
 * 时长 < 400ms 的缓冲抖动）返回空串，尾部就只有模型名。
 */
function genRateOf(m: MessageView): string {
  const out = (m.info.tokens?.output ?? 0) + (m.info.tokens?.reasoning ?? 0)
  if (out <= 0) return ''
  const iv = m.parts
    .filter((x) => x.type === 'text' || x.type === 'reasoning')
    .map((x) => ({ s: x.time?.start ?? 0, e: x.time?.end ?? 0 }))
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s)
  let gen = 0
  let curS = 0
  let curE = 0
  for (const x of iv) {
    if (curE && x.s <= curE) {
      curE = Math.max(curE, x.e)
      continue
    }
    gen += curE - curS
    curS = x.s
    curE = x.e
  }
  gen += curE - curS
  if (gen < 400) return ''
  const r = out / (gen / 1000)
  return t('{n} token/s', { n: r >= 100 ? String(Math.round(r)) : r.toFixed(1) })
}

/**
 * 「要不要让 AI 调用另一个模型」的授权卡。
 *
 * 与权限卡（读文件/执行命令）是两回事：那个管「能不能动本机」，这个管「能不能再雇一个模型」。
 * 所以即使访问权限是「完全控制」，这张卡照样会弹——用户明确要求过。
 *
 * 四档粒度对应四种心智：
 *   仅这一次  = 就这一次，下一张截图还会问我
 *   本次会话  = 今天这个应用跑着期间别烦我（内存态，重启即失效）
 *   永久允许  = 以后都别问了（写进设置，设置页可撤销）
 *   拒绝      = 别调，让 AI 想别的办法
 */
function ModelAuthModal({
  req,
  onReply
}: {
  req: ModelAuthAsk
  onReply: (scope: ModelAuthScope) => void
}) {
  const rawLabel = MODEL_ROLE_LABEL[req.role] ?? req.role ?? t('调用模型')
  const label = t(rawLabel)
  const name = req.label || req.id

  return (
    <Modal title={t('是否允许调用其他模型？')} anchor="top" onClose={() => onReply('reject')}>
      <div className="perm-q">
        <p className="perm-lead">
          {t('AI 要用「{name}」来{what}，需要你确认：', { name, what: label })}
        </p>
        <ul className="perm-list">
          <li title={`${req.provider || req.id} / ${req.id}`}>
            {name}
            <span className="perm-sub">　{req.provider ? `${req.provider} · ` : ''}{req.id}</span>
          </li>
        </ul>
        <p className="perm-note">
          {t('这一步会调用')}
          <strong>{t('除当前对话模型之外')}</strong>
          {t('的模型，可能产生额外费用。「仅这一次」只放行这一下；「本次会话」在应用重启前不再问；「永久允许」写进设置，之后可随时撤销。')}
        </p>
      </div>
      <div className="perm-acts">
        <button className="primary" onClick={() => onReply('once')}>
          {t('仅这一次')}
        </button>
        <button className="ghost" onClick={() => onReply('session')}>
          {t('本次会话允许')}
        </button>
        <button className="ghost" onClick={() => onReply('always')}>
          {t('永久允许')}
        </button>
        <button className="ghost danger-text" onClick={() => onReply('reject')}>
          {t('拒绝')}
        </button>
      </div>
    </Modal>
  )
}

/**
 * 绝对路径 → 项目相对路径（不在项目内就原样返回）。
 * 只做展示：确认框里「src/renderer/App.tsx」比「D:\github\xxx\opencode_desk\src\renderer\App.tsx」好判得多。
 */
function relPath(p: string, dir: string): string {
  if (!dir) return p
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = norm(p)
  const b = norm(dir)
  if (a.toLowerCase().startsWith(b.toLowerCase() + '/')) return a.slice(b.length + 1)
  return p
}

/** 内核工具的英文系统消息 → 中文；纯结果确认句（"写入成功"类）视为无信息量，返回空串让渲染层决定回退展示 */
const OUTPUT_CONFIRM_RE = /^(Edit applied successfully\.?|Wrote file successfully\.?|Update applied successfully\.?|Aborted\.?|The \w+ tool was called with invalid arguments:[\s\S]*$)/i

/** 内核工具的英文系统消息 → 中文；纯结果确认句（"写入成功"类）视为无信息量，返回空串让渲染层决定回退展示 */
function cnOutput(text: string): string {
  if (OUTPUT_CONFIRM_RE.test(text)) return ''
  const out = text
    .replace(/^Edit applied successfully\.?/i, t('编辑已应用。'))
    .replace(/^Wrote file successfully\.?/i, t('文件写入成功。'))
    .replace(/^Update applied successfully\.?/i, t('修改已应用。'))
    .replace(/^Aborted\.?/i, t('已中止。'))
    .replace(/^The (\w+) tool was called with invalid arguments:[\s\S]*$/i, (_m, n: string) => {
      const zh = t(TOOL_META[n.toLowerCase()]?.name ?? n)
      return t('「{name}」工具的调用参数不完整，已让模型重写参数重试。', { name: zh })
    })
  return out
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 秒数 → 中文时长：1秒 / 45秒 / 1分20秒 */
function fmtElapsed(s: number): string {
  if (s < 60) return t('{n}秒', { n: s })
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? t('{n}分钟', { n: m }) : t('{m}分{r}秒', { m, r })
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

/** 模型把工具调用标记吐进正文（deepseek 等 provider 的无效调用）：识别这类文本，整段收进折叠行展示 */
function isInvalidCallText(text: string): boolean {
  const head = text.slice(0, 400)
  return /<\s*tool_call\b/i.test(head) || /<\s*function\s*=/i.test(head) || /<\s*(?:antml:)?parameter\s*=/i.test(head) || /<\|[\s\S]*call[\s\S]*begin\|>/i.test(head)
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

/** 从服务启动命令里识别端口：--port N / PORT=N / :NNNN（4-5 位数字，如 GOERP_ADDR=:9002） */
function cmdPortOf(cmd: string): number | undefined {
  const m = /--port[= ](\d{2,5})\b/i.exec(cmd) ?? /\bPORT[=:](\d{2,5})\b/i.exec(cmd) ?? /:(\d{4,5})\b/.exec(cmd)
  const n = m ? Number(m[1]) : NaN
  return n >= 1 && n <= 65535 ? n : undefined
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
      <div className="step-list-head" title={file ?? ''}>{file ? relTarget(file) : t('目录')} · {t('{n} 项', { n: list.length })}</div>
      {list.map((f) => (
        <div key={f} className="step-list-item" title={f}>{f}</div>
      ))}
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function rawToolTarget(part: Part, projPath?: string): string {
  // 待办清单工具的输出是 JSON 数组（已渲染成任务卡），其标题「N todos」无信息量，不展示在工具行
  if ((part.tool ?? '').toLowerCase().includes('todo')) return ''
  // 无效调用的内核标题是英文「Invalid Tool」，折叠行只留中文名+错误图标
  if ((part.tool ?? '').toLowerCase() === 'invalid') return ''
  const inp = part.state?.input ?? {}
  // 桌面控制类：折叠行直接亮出正在执行的命令（key: ctrl+f / 点击: (960,540) / 粘贴 → 「微信」…），不猜通用字段
  // 子任务用 description，其余工具用各自的目标字段
  let raw = str(inp.description) || str(inp.filePath) || str(inp.path) || str(inp.command) || str(inp.pattern) || str(inp.url)
  // 兜底内核生成的英文摘要 → 中文化（"4 todos"→"4条任务"、"Asked 2 questions"→"提问 2 个问题"）
  const ttl = str(part.state?.title)
  if (!raw) {
    const asked = /^Asked (\d+) questions?$/i.exec(ttl)
    if (asked) raw = t('提问 {n} 个问题', { n: asked[1] })
    else if (/todos?/i.test(ttl)) raw = t('{v}条任务', { v: ttl.replace(/\s*todos?\.?/i, '').trim() })
    else raw = ttl
  }
  return relTarget(raw, projPath)
}

/** 工具行的目标（展示用）：相对化后截断到 90 字符 */
function toolTarget(part: Part, projPath?: string): string {
  const s = rawToolTarget(part, projPath)
  return s.length > 90 ? s.slice(0, 90) + '…' : s
}

/** 相邻重复归组的签名：同工具 + 同目标（不截断全文，避免长路径误合并） */
function toolSig(part: Part, projPath?: string): string {
  return (part.tool ?? '').toLowerCase() + '｜' + rawToolTarget(part, projPath)
}

/** 一条消息的过程行：普通 part 原样出；反复调同一工具（轮询）的 tool 行归成一组，
 *  由组内最后一个 part 代表渲染，StepLine 挂 ×N 角标。
 *  组间**只被正文/其他工具**隔开才分行（中间插了别的操作再读回来通常有信号，保持可见）；
 *  两次同工具同目标调用之间的**思考块被吞进组**——轮询时模型「思考→查→思考→查」交替，
 *  思考块不吞的话组永远成不了，思考行也会跟着轮询一条条刷屏，只剩最后一行带 ×N。
 *  组尾失败的归组不合并：连续失败是模型打转的信号（toolFails 熔断兜底最多 3 次），
 *  逐行标红比藏进 ×N 更有用（该段的思考块也原样保留，供排障看模型当时在想什么）。 */
type PartRow =
  | { kind: 'part'; part: Part }
  | { kind: 'group'; parts: Part[]; last: Part }

function partRows(parts: Part[], projectPath?: string): PartRow[] {
  const rows: PartRow[] = []
  let i = 0
  while (i < parts.length) {
    const p = parts[i]
    if (p.type !== 'tool') {
      rows.push({ kind: 'part', part: p })
      i++
      continue
    }
    const sig = toolSig(p, projectPath)
    // 收一段「同工具同目标」的运行序列：其间允许夹思考块，正文/异工具/异目标终止
    const span: Part[] = [p]
    const tools: Part[] = [p]
    let j = i + 1
    for (;;) {
      const q = parts[j]
      if (!q) break
      if (q.type === 'reasoning') {
        span.push(q)
        j++
        continue
      }
      if (q.type === 'tool' && toolSig(q, projectPath) === sig) {
        span.push(q)
        tools.push(q)
        j++
        continue
      }
      break
    }
    const last = tools[tools.length - 1]
    if (tools.length >= 2 && (last.state?.status ?? 'pending') !== 'error') {
      // 归组：工具行合成一条（思考块被吞），last 代表渲染
      rows.push({ kind: 'group', parts: tools, last })
    } else {
      // 不归组：整段按原顺序逐行渲染
      for (const x of span) rows.push({ kind: 'part', part: x })
    }
    i = j
  }
  return rows
}

/** 展示用：绝对路径裁剪为项目相对路径 */
function relTarget(s: string, projPath?: string): string {
  if (!s || !projPath) return s
  const base = projPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const n = s.replace(/\\/g, '/')
  if (n.toLowerCase().startsWith(base.toLowerCase() + '/')) return n.slice(base.length + 1)
  return s
}

function PartView({ part, projectPath, preview, live, diffs, count, previewParts }: {
  part: Part
  projectPath?: string
  /** 该工具组正在流式写入的入参预览：普通行是自己；重复归组时组内最后一个正在写就显示它的 */
  preview?: string
  live?: boolean
  diffs?: FileDiff[]
  /** 重复调用归组的次数（≥2 时 StepLine 挂 ×N 角标） */
  count?: number
  /** 重复归组里整组正在运行的 part（多个并行跑时同时转圈） */
  previewParts?: Part[]
}) {
  // 内核自己塞的过程说明文本（synthetic）不渲染：read 工具会先吐一条
  //   Called the Read tool with the following input: {"filePath":"D:\...\xxx.mp3"}
  // 再跟着文件内容。工具行本身已经写了「读取 + 路径」，这条纯属重复，
  // 用户看到的就是一串不是自己输入的 JSON 糊在对话里。
  if (part.synthetic && part.type === 'text') return null
  // 正文过长（代码大段粘贴/长回答）自动收起，点「展开全文」看全
  if (part.type === 'text' && part.text) {
    // 模型把工具调用吐成了正文文本（无效调用）：整段收进「无效调用」折叠行，不混进对话正文
    if (isInvalidCallText(part.text)) {
      return (
        <StepLine
          icon={<AlertCircle size={13} />}
          name="无效调用"
          target="模型把工具调用写成了正文，已收起，不执行"
          status="error"
          body={<CodeBlock text={part.text} />}
        />
      )
    }    return (
      <Collapsible maxPx={520} forceText={part.text} live={live} defaultOpen>
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
    // 读取「文件不存在」是探索型正常结果（AI 常在写前探测路径），不当错误标红
    const readMiss = st === 'error' && tool === 'read' && /^File not found:/i.test(str(part.state?.error ?? ''))
    // 写入类工具：内核算好的整轮差量优先（带 +/- 行），工具自身输出仅作回退
    const fd = isFileTool(tool) ? (matchedDiff(metaDiffs(part), part) ?? matchedDiff(diffs, part)) : undefined
    let body: ReactNode
    if (tool === 'invalid') {
      // 无效调用：内核把整坨原始入参塞在 output 里（可达几十 KB），展开只给中文说明+截断原文
      const inner = str(toolIn?.tool)
      const zh = t(TOOL_META[inner.toLowerCase()]?.name ?? inner)
      const err = str(toolIn?.error)
      const cut = err.length > 2000 ? err.slice(0, 2000) + '\n…' : err
      body = <CodeBlock text={inner ? t('「{name}」工具的调用参数不完整，已让模型重写参数重试。', { name: zh }) + '\n' + cut : cut} />
    } else if (rawOut && tool === 'read') {
      const parsed = parseReadOutput(rawOut)
      body = parsed?.list ? <DirList list={parsed.list} file={parsed.file} /> : parsed ? <CodeBlock text={parsed.code} file={parsed.file} /> : <CodeBlock text={rawOut} />
    } else if (isFileTool(tool)) {
      // 优先展示写入的代码内容（part 入参），其次内核差量，最后工具输出
      if (inContent) {
        const file = str(toolIn?.filePath) || str(toolIn?.path) || fd?.file || toolTarget(part, projectPath)
        // edit 的 newString 是不含 +/- 标记的纯新代码，直接当 diff 渲染会缺失增删着色与标记；
        // 内核算好的整轮差量 fd.patch 带完整 +/- 行，展开应优先用它，才能看到红绿增减效果
        if (tool === 'edit' && fd?.patch) {
          body = <CodeBlock text={fd.patch} diff file={fd.file || file} />
        } else {
          body = tool === 'write'
            ? <CodeBlock text={inContent} file={file} />
            : <CodeBlock text={inContent} diff file={file} />
        }
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
    // 组内若有其他 part 在并行跑（罕见），整行也保持转圈而非「已完成」。
    // 只在 live（会话真在跑）时兜底：回合被中止/内核重启后，残留的 running part 按中断（error）
    // 展示，不能再强行画回「进行中」——那会留下一条永远转圈的假活行，而停止按钮（跟 busy 走）
    // 早没了，用户既看不到结束也停不掉。
    const anyRun = live && (previewParts ?? [part]).some((x) => x.type === 'tool' && x.state?.status === 'running')
    const stFinal = anyRun ? 'running' : st
    return (
      <StepLine
        icon={meta.icon}
        name={meta.name}
        status={stFinal}
        target={toolTarget(part, projectPath)}
        preview={preview}
        body={body}
        hideErr={readMiss}
        stats={fd && (fd.additions || fd.deletions) ? { additions: fd.additions, deletions: fd.deletions } : undefined}
        spin={stFinal === 'running' && tool !== 'bash' && tool !== 'shell' && tool !== 'execute'}
        count={count}
      />
    )
  }
  return null
}

/** 一行式过程条目：图标 + 中文名 + 目标；running 时展示实时写入预览，详情默认折叠点击展开 */
/** 工具中文标签 → 进行时文案（running 状态下跟在名字后面的动词） */
function doingLabel(name: string): string {
  switch (name) {
    case '思考': return t('正在思考')
    case '读取': return t('正在读取')
    case '写入': case '编辑': case '应用补丁': return t('正在写入')
    case '查找文件': case '搜索内容': case '代码搜索': return t('正在搜索')
    case '终端': case '执行': return t('正在执行')
    case '抓取网页': case '网络搜索': return t('正在查询')
    case '子任务': return t('正在执行子任务')
    case '待办清单': return t('正在整理任务')
    case '提问': return t('等待回答')
    // 桌面控制家族：running 时跟的操作动词
    case '写入剪贴板': return t('正在放剪贴板')
    case '查应用进程': return t('正在查进程')
    case '窗口列表': case '前台窗口': return t('正在查看窗口')
    case '控件树': return t('正在读取控件树')
    case '点击控件': return t('正在点击')
    case '写入控件文本': return t('正在写入')
    case '聚焦控件': case '聚焦窗口': return t('正在聚焦')
    case '发送按键': return t('正在按键')
    case '粘贴': return t('正在粘贴')
    case '读取输入框': return t('正在核对输入框')
    default: return t('进行中')
  }
}

function StepLine({
  icon,
  name,
  target,
  status,
  preview,
  body,
  hideErr,
  stats,
  spin = true,
  count
}: {
  icon: ReactNode
  name: string
  target?: string
  status: string
  preview?: string
  body?: ReactNode
  /** 该错误无需标红（如 read 文件不存在属正常探索），隐藏右侧错误图标 */
  hideErr?: boolean
  /** 写入类工具的整轮增减行数（+ 绿 / - 红） */
  stats?: { additions: number; deletions: number }
  /** running 时图标位是否转圈：终端类长跑命令不转，避免看起来像一直加载 */
  spin?: boolean
  /** 相邻重复调用的归组次数：显示 ×N 角标（组内最后一次的代表行） */
  count?: number
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
        <span className="step-name">{t(name)}</span>
        {running && <span className="step-doing">{doingLabel(name)}</span>}
        {target && (
          <span className="step-target" title={target}>
            <span className="step-target-text">{t(target)}</span>
            {stats && (stats.additions > 0 || stats.deletions > 0) && (
              <span className="step-stat" title={t('新增 {a} 行 · 删除 {b} 行', { a: stats.additions, b: stats.deletions })}>
                {stats.additions > 0 && <span className="d-add">+{stats.additions}</span>}
                {stats.deletions > 0 && <span className="d-del">-{stats.deletions}</span>}
              </span>
            )}
            {count && count > 1 && <span className="step-rep" title={t('同一操作连续重复 {n} 次', { n: count })}>×{count}</span>}
          </span>
        )}
        {status === 'error' && !hideErr && <AlertCircle size={13} className="step-err" />}
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

type DiffLine = { key: string; kind: 'add' | 'del' | 'ctx'; marker: string; content: string }

function renderDiffLines(text: string): DiffLine[] {
  const lines: DiffLine[] = []
  let hunkAdds = 0
  let hunkDels = 0
  let hunkSeen = false
  text.split('\n').forEach((l, i) => {
    // 文件头噪音：==== 分隔线与 ---/+++ 文件路径行——文件名已在工具行目标处显示，重复无意义。
    // 只在第一个 @@ hunk 出现前过滤：hunk 之后的 ---/+ 是正常 diff 内容（如删除 markdown 分隔线）
    if (!hunkSeen) {
      if (/^={10,}\s*$/.test(l)) return
      if (/^--- /.test(l) || /^\+\+\+ /.test(l)) return
    }
    const hunk = /^@@\s+(?:\d+,\d+\s+)?@@/.exec(l)
    if (hunk) {
      lines.push({ key: `hunk-${i}`, kind: 'ctx', marker: '', content: l })
      return
    }
    const add = /^\+/.exec(l)
    const del = /^-/.exec(l)
    if (add) {
      lines.push({ key: `add-${i}`, kind: 'add', marker: '+', content: l.slice(1) })
      hunkSeen = true
      hunkAdds += 1
      return
    }
    if (del) {
      lines.push({ key: `del-${i}`, kind: 'del', marker: '-', content: l.slice(1) })
      hunkSeen = true
      hunkDels += 1
      return
    }
    if (hunkSeen && hunkAdds > 0 && hunkDels > 0) {
      lines.push({ key: `ctx-${i}`, kind: 'ctx', marker: ' ', content: l.startsWith(' ') ? l.slice(1) : l })
      return
    }
    lines.push({ key: `raw-${i}`, kind: 'ctx', marker: '', content: l })
  })
  return lines
}

/** 展开详情代码块：diff 着色 / highlight.js 语法高亮 / 纯文本。
 *  默认超 2 万字符不再高亮（流式工具输出省性能）；force 跳过限制——审查面板「全文」要看完整源码高亮 */
function CodeBlock({ text, file, diff, force }: { text: string; file?: string; diff?: boolean; force?: boolean }) {
  if (diff) {
    const lines = renderDiffLines(text)
    const hasColor = lines.some((l) => l.kind !== 'ctx')
    if (!hasColor) {
      return (
        <pre className="step-code hljs">
          <code>{text}</code>
        </pre>
      )
    }
    return (
      <pre className={'step-code diff-view' + (file ? ' has-file' : '')}>
        {lines.map((l) => (
          <span key={l.key} className={'diff-line diff-' + l.kind}>
            <span className="diff-marker">{l.marker || ' '}</span>
            <span className="diff-content">{l.content || '\u00A0'}</span>
          </span>
        ))}
      </pre>
    )
  }
  let html = escapeHtml(text)
  try {
    const lang = file ? extLang(file) : undefined
    if (force || text.length < 20000) {
      html = lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value
    }
  } catch {
    /* 高亮失败回退纯文本 */
  }
  return (
    <pre className="step-code hljs">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}
