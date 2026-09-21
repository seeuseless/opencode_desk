import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WebviewTag } from 'electron'
import hljs from 'highlight.js/lib/common'
import {
  AlertCircle, ArrowDown, ArrowLeft, ArrowRight, Brain, Bot, Check, ChevronDown, ChevronRight, Copy, Cpu, FileDiff as FileDiffIcon, FilePlus, FileText,
  Film, Folder, Globe, HelpCircle, Info, ListChecks, LoaderCircle, MessageCircle, MessageCircleOff, Monitor, Music, Paperclip, Pencil, RotateCw, Search, Send, Sparkles,
  Square, Star, Terminal, Trash2, Wrench, X
} from 'lucide-react'
import { oc, ATTACH_CTX_PREFIX, BROWSER_CTX_PREFIX, DESKTOP_CTX_PREFIX, MEMORY_PREFIX, MODEL_DEFAULTS, MODEL_ROLE_LABEL, PLATFORM_PROVIDER_ID, defaultThinkingValue, genRoleOf, hasGenModel, hasVisionModel, visionModelName, isDesktopIntent, isGenIntent, modelSupportsImage, thinkingKindOf, type Attachment, type FileDiff, type MessageView, type ModelSel, type Part, type PermissionAsk, type PtySession, type QuestionAsk, type Session, type ThinkingMode } from '../oc'
import { load, save } from '../store'
import type { Modality, ModelAuthAsk, ModelAuthScope, ModelCfg, ModelUsed, ProviderCfg } from '../../../electron/main/types'
import { ModelPicker, type ModelGroup } from './ModelPicker'
import { ProjectPicker, AccessPicker } from './ProjectPicker'
import { ThinkingPicker } from './ThinkingPicker'
import { Modal } from './Modal'
import { Markdown } from './Markdown'
import type { AccessLevel, Project } from './Sidebar'

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
  /** 跳转到设置页并定位到「模型」那一页（模型选择器里的「配置模型」） */
  onOpenSettings?: () => void
  /** 点击左端项目文件夹：弹出系统选目录对话框 */
  onPickDir: () => void
  /** 切换当前激活项目（点击左侧项目下拉中的某项） */
  onSwitchProject: (id: string) => void
  /** 当前项目的访问权限档位（项目下拉右栏展示与切换） */
  access: AccessLevel
  /** 拨权限档位；切到「完全控制」的二次确认由 App 负责 */
  onAccess: (level: AccessLevel) => void
  /** 桌面控制（computer 工具）是否启用：桌面意图那一轮据此注入「别碰内置浏览器」的边界提示 */
  desktopControl: boolean
  /** 标题栏「内置浏览器」按钮的触发计数（App 转发，每点一次 +1） */
  browserToggleSignal: number
  /** 浏览器打开时标题栏最大化按钮的触发计数（App 转发，用于面板放大/还原） */
  browserMaxSignal: number
  /** 上报浏览器面板开合与放大状态（标题栏浏览器按钮与最大化按钮据此决定行为与图标） */
  onBrowserUi: (s: { open: boolean; max: boolean }) => void
}

/** 'pid/mid' → ModelSel；'' → 跟随内核默认 */
function parseModel(key: string): ModelSel | undefined {
  if (!key) return undefined
  const i = key.indexOf('/')
  return { providerID: key.slice(0, i), modelID: key.slice(i + 1) }
}

/** 「仅上下文」注入消息（项目记忆 / 浏览器页面上下文 / 桌面控制边界）：AI 可见、界面不渲染 */
function isCtxOnly(txt: string): boolean {
  return (
    txt.startsWith(MEMORY_PREFIX) ||
    txt.startsWith(BROWSER_CTX_PREFIX) ||
    txt.startsWith(ATTACH_CTX_PREFIX) ||
    txt.startsWith(DESKTOP_CTX_PREFIX)
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

/** 任务中断后的提示条：不自动重发消息，交还用户点「重试」手动续跑 */
/** 自动重试提示文案：续跑上一轮的半截任务，不必重复原文 */
const RETRY_CONTINUE = '继续'
/**
 * 桌面控制「卡死」判定线：同一个 computer 调用 running 超过这么久就中止本轮。
 * 内核侧给 computer-use 配的超时是 30s（见 config.ts），这里留足一点余量做最后兜底。
 */
const DESKTOP_STUCK_MS = 45000

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

/** 重试时该发什么：上一轮没有任何产出就重发原文，有产出就发「继续」让模型从断点接着做 */
function continuationText(list: MessageView[]): string {
  const lastUser = [...list].reverse().find((m) => m.info.role === 'user')
  const lastAsst = [...list].reverse().find((m) => m.info.role === 'assistant')
  const text = lastUser
    ? lastUser.parts
        .filter((x) => x.type === 'text' && !x.synthetic)
        .map((x) => x.text ?? '')
        .join('\n')
        .trim()
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
/**
 * 把内核/端点抛的错误消息翻译成一眼能看懂的中文。
 * 已知模式 → 对应提示；**未知/空消息 → 返回空串**（调用方据此不显示错误条——
 * 宁可没提示，也不该用「未知错误」这种毫无信息量的占位糊弄人）。
 */
function humanizeError(raw: string): string {
  if (!raw) return ''
  if (/insufficient[_ ]credit|quota|balance|arrears|exceeded your current/i.test(raw)) return '账户额度不足或已欠费，请检查该提供商的余额。'
  if (/invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication/i.test(raw)) return 'API Key 无效或未通过认证，请到设置里检查该提供商的密钥。'
  if (/rate[_ ]?limit|too many requests|429/i.test(raw)) return '请求过于频繁，已被限流，请稍候片刻再试。'
  if (/model[_ ]not[_ ]found|does not exist|unknown model|unsupported model|provider.{0,20}not found/i.test(raw)) return '请求的模型在该端点不存在或不可用，请更换模型。'
  // 图生图/文生图模型被当成对话模型用：端点直接拒掉 chat 请求（如 agnes-image-* 提示走 /v1/images/generations）
  if (/images\/generations|是\s*image\s*模型|image (?:generation )?model/i.test(raw)) return '该模型是图像生成模型，只能收生图请求、不能对话，文字任务发给它都会失败。请到 设置 → 模型 换用对话模型。'
  if (/timeout|timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(raw)) return '无法连接模型端点，请检查 Base URL 与网络。'
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw
}

/** 助手消息自带的失败原因：session.error 事件偶尔漏推，这是「这轮为什么空了」的唯一兜底展示 */
function msgErrorText(m: MessageView): string {
  const e = (m.info as unknown as { error?: { name?: string; data?: { message?: string }; message?: string } }).error
  if (!e || e.name === 'MessageAbortedError') return ''
  return humanizeError(e.data?.message ?? e.message ?? e.name ?? '')
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
    if (stored === 'low' || stored === 'medium' || stored === 'high') return stored
    // 上一次记的是开关型的值：搬成语义等价档位（开→配置默认档，关→低）
    if (stored === 'none') return fallback === 'low' || fallback === 'medium' || fallback === 'high' ? 'low' : fallback
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
  const hijack = useRef<number | null>(null)
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
  // computer 类工具的起始计时：单次调用僵住这么久就判定卡死并中止本轮
  const computerStart = useRef<Record<string, number>>({})
  // 轮询兜底指纹：当前会话已渲染的消息+part 长度，无变化则跳过 setState，避免每轮无谓渲染
  const pollFingerprint = useRef('')
  // 各 busy 会话所属项目路径：多项目并行时停止/重试都要带 directory，否则内核找不到该会话
  const busyDir = useRef<Record<string, string | undefined>>({})
  // 各 busy 会话本轮开始时间：「已用时」按它起算，切走再切回不会从头计
  const busySince = useRef<Record<string, number>>({})
  // 已拉到的整轮文件差量：用户消息 id → 差量列表（工具行据此显示 +N/-M，展开显示差量代码）
  const [diffs, setDiffs] = useState<Record<string, FileDiff[]>>({})
  const diffsBusy = useRef<Set<string>>(new Set())

  // ---------- 浏览面板 ----------
  // AI 调用浏览器工具（playwright MCP，headless）时右侧滑出：内嵌 webview 直接渲染页面，地址栏跟随 AI 的导航。
  // 用户关掉后同一会话内不再自动弹出，切到其他会话恢复；会话无浏览器活动时面板收起。
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserMax, setBrowserMax] = useState(false)
  /** 放大时右下角浮动聊天卡是否展开 */
  const [floatOpen, setFloatOpen] = useState(false)
  /** 全屏时彻底隐藏 AI 对话：浮动卡收起 + 右下角气泡一并消失（打游戏等完全不需要对话的场景） */
  const [chatHidden, setChatHidden] = useState(false)
  /** 浏览模式：用户从输入框手动进入的全屏浏览器，不随会话浏览器活动自动开关 */
  const [manualBrowser, setManualBrowser] = useState(false)
  /** 面板当前页 URL（含用户手输导航，BrowserPanel 回传）：浏览器对话的上下文锚点 */
  const [panelUrl, setPanelUrl] = useState('')
  /** 浏览器收藏夹：地址栏星标收藏 / 取消，全屏时顶部收藏条展示（localStorage 持久化） */
  const [marks, setMarks] = useState<Bookmark[]>(() => load<Bookmark[]>('qingniao.bookmarks', []))
  /** 已注入的浏览器上下文（会话 + URL + 是否全屏）：没变过就不再重复注入，避免每条消息都塞一份 */
  const browserCtxRef = useRef<{ sid: string; url: string; max: boolean } | null>(null)
  /** 已注入的桌面控制上下文（会话 + 本轮原话）：同上，同一轮不重复注入 */
  const desktopCtxRef = useRef<{ sid: string; text: string } | null>(null)
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
  const browserDismissedIn = useRef('')
  /** 用户点击要浏览器打开的链接（HTML/SVG 产物、网页地址）：面板优先导航到它，盖过 AI 的 browserView.url */
  const [pinnedUrl, setPinnedUrl] = useState('')
  /** 点击开链的计数：同一地址重复点击也强制重新导航 */
  const [pinSeq, setPinSeq] = useState(0)

  const browserView = useMemo(() => {
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
        const ms = (text.match(/https?:\/\/[^\s)<>"'）】」。，；]+/g) ?? []).filter((u) => !mediaExtRe.test(u.split(/[?#]/)[0]))
        if (ms.length) url = ms[ms.length - 1]
      }
    }
    return { url, active: url !== '' }
  }, [msgs])

  useEffect(() => {
    if (manualBrowser) return
    if (browserView.active) {
      if (browserDismissedIn.current !== p.sessionId) setBrowserOpen(true)
    } else {
      setBrowserOpen(false)
    }
  }, [browserView.active, p.sessionId, manualBrowser])

  // 主进程「AI 要用面板浏览器」事件（panel_* 工具在面板关着时触发）：清掉本会话的关闭记录并打开
  useEffect(() => {
    return window.qingniao.onEvent((raw) => {
      if ((raw as { type?: string }).type === 'qingniao.browser.open') {
        browserDismissedIn.current = ''
        setBrowserOpen(true)
      }
    })
  }, [])

  // 对话里点击需浏览器打开的链接（Markdown 组件派发）：打开面板并导航到该地址
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const u = (e as CustomEvent).detail
      if (typeof u !== 'string' || !u) return
      setPinnedUrl(u)
      setPinSeq((n) => n + 1)
      browserDismissedIn.current = ''
      setBrowserOpen(false)
      setManualBrowser(true)
    }
    window.addEventListener('qingniao:open-in-browser', onOpen)
    return () => window.removeEventListener('qingniao:open-in-browser', onOpen)
  }, [])

  // 切会话时清掉用户点开的地址：面板若开着回到新会话的 AI 浏览上下文
  useEffect(() => {
    setPinnedUrl('')
  }, [p.sessionId])

  // 收藏夹落盘：状态即事实源，变化即写
  useEffect(() => {
    save('qingniao.bookmarks', marks)
  }, [marks])

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

  function closeBrowserPanel() {
    setBrowserOpen(false)
    setManualBrowser(false)
    setBrowserMax(false)
    setPinnedUrl('')
    setChatHidden(false) // 面板都关了，隐藏态一起复位，别再带着回右栏布局
    browserDismissedIn.current = p.sessionId
  }

  /** 浏览模式：面板放大全屏 + 右下角浮动对话卡，用户自己在地址栏输网址 */
  function openBrowseMode() {
    setBrowserOpen(false)
    setManualBrowser(true)
    setBrowserMax(true)
    setFloatOpen(true)
    setChatHidden(false)
  }

  /**
   * 标题栏按钮：开/关内置浏览器面板（常规右栏不放大；开着就关）。
   *
   * 全屏浏览中一律不动尺寸——全屏时这一颗按钮直接不渲染（面板已占满，关它等于退出全屏），
   * 想退出全屏点标题栏的「还原」；「AI 对话」开关则挪到了地址栏右侧那颗电源图标。
   */
  function toggleBrowserFromHeader() {
    if (browserMax) return
    if (browserOpen || manualBrowser) {
      closeBrowserPanel()
      return
    }
    setBrowserOpen(false)
    setManualBrowser(true)
    setBrowserMax(false)
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
  /** 当前会话的自动重试状态（pending=等待下一次重试；无定时器=次数耗尽等手动重试） */
  const retryState = p.sessionId ? retryView[p.sessionId] : undefined

  /**
   * 视觉代看人：当前对话模型看不到画面、但配置里有视觉模型 → 截图是由**另一个**模型看的。
   *
   * 提前算（桌面控制横幅要用）：它只依赖 props，与 msgs 无关，放前面没有副作用。
   * 名字跟内核挑人同序（visionModelName 与主进程 pickVision 同口径），
   * 顶部横幅点名的代看人就是同一个人。
   */
  const modelSeesImage = modelSupportsImage(p.settings, p.model)
  const visionWho = !modelSeesImage ? visionModelName(p.settings) : ''

  // 自动续跑发的「继续」不出用户气泡，统一由尾部「重试 x/10」状态条体现：
  // pending=本轮 runPrompt 是续跑发起的；ids=已确认属于续跑的真实用户消息 id（含别的会话，防止切会话漏隐藏）
  const autoContinuePending = useRef(false)
  const autoContinueIds = useRef<Set<string>>(new Set())
  /** 助手消息 → 所属用户消息 id（差量按用户消息拉，这里做渲染期的映射） */
  const turnOwner = turnOwners(msgs)
  // 最新一条助手消息：只有它身上的 running 工具是"真在跑"；更早轮次的残留 running 按中断展示，
  // 否则发新消息后旧轮还挂着加载动画、新轮又在思考，两轮状态混在一起
  const lastAid = [...msgs].reverse().find((m) => m.info.role === 'assistant')?.info.id
  /** 看门狗要读最新的消息与助手 id：渲染几乎每帧都在变，不好做 timer 依赖，这里留一份镜像供 effect 读取 */
  const watchdogRef = useRef<{ msgs: MessageView[]; lastAid?: string }>({ msgs: [], lastAid: undefined })
  watchdogRef.current = { msgs, lastAid }
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
  // 桌面控制进行中（computer-use 的 computer 工具在跑）：AI 的键鼠可能点进本应用，
  // 锁定聊天输入，防止它的按键落进对话
  const desktopCtl =
    busy &&
    !!msgs.find((x) => x.info.id === lastAid)?.parts.some(
      (x) => x.type === 'tool' && x.state?.status === 'running' && (x.tool ?? '').toLowerCase().includes('computer')
    )
  /**
   * 桌面控制真的被调用过、但当前对话模型收不了图 —— 这种情况下截图由视觉模型代看（screen MCP
   * 在 computer 的返回里附一段画面文字），所以不再报「发不出去」，只在界面明确告知正在代看。
   * 判定用「配置里没有任何视觉模型」：一个都没有才真的没眼睛。
   */
  const cuBlind =
    !modelSeesImage &&
    hasVisionModel(p.settings) === false &&
    !!msgs.find((x) => x.info.id === lastAid)?.parts.some(
      (x) => x.type === 'tool' && (x.tool ?? '').toLowerCase().includes('computer')
    )
  /** 当前对话模型看不到画面，但配了视觉模型 → 截图正由视觉模型代看（界面要给个明确交代） */
  const cuVisionAssist = !modelSeesImage && hasVisionModel(p.settings)
  /** 代看那个模型的名字（跟内核挑人同序），横幅里点名，用户才知道是谁在看 */
  const cuVisionWho = cuVisionAssist ? visionWho : ''
  /**
   * 桌面控制进行中、或本轮调用过 computer 工具 → 顶部横幅的显示窗口。
   * 进行中要显示（用户得知道键鼠在自己动），本轮用过也要留一会儿（刚操作完的收尾说明）。
   */
  const desktopBanner =
    desktopCtl ||
    !!msgs.find((x) => x.info.id === lastAid)?.parts.some(
      (x) => x.type === 'tool' && (x.tool ?? '').toLowerCase().includes('computer')
    )

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

  /** 取消某会话待执行的自动重试（用户自己发新消息/手动停止时，不再让旧任务续跑） */
  function cancelRetry(sid: string) {
    const r = retries.current.get(sid)
    if (!r) return
    if (r.timer != null) clearTimeout(r.timer)
    retries.current.delete(sid)
    syncRetryView()
  }

  /**
   * 任务被中断（回合报错 / 回合结束时残留半截工具调用 / 内核重启）后登记一个「中断」状态：
   * 顶部通知条显示「任务已中断」，**不自动重发消息**——续跑由用户点「重试」按钮触发。
   * 自动重试会替用户重复发一条消息（或追加「继续」），既可能打乱对话、又未必是用户想要的，
   * 所以中断后只提示、交还用户决定。
   */
  function scheduleRetry(sid: string) {
    if (!sid || navigator.onLine === false) return
    // 手机发起的回合：本端不是发起者，续跑只会重复发
    if (foreignSids.current.has(sid)) return
    if (retries.current.has(sid)) return
    retries.current.set(sid, { count: 1, timer: undefined })
    syncRetryView()
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
    // 点「重试」发出去的是**续跑指令**（多半就是「继续」），界面不该冒出一个用户气泡。
    // 这里显式打标记，而不是在 runPrompt 里按「文本等于继续」判断——用户手打「继续」是
    // 正常发言，必须看得见自己的话（曾经按文本判断，把用户手打的「继续」一起吞了）。
    autoContinuePending.current = true
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
    // 撤回可能带走了已注入的浏览器上下文消息：清掉记录，重发时按需重新注入
    browserCtxRef.current = null
    desktopCtxRef.current = null
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
    cancelRetry(sid)
    markBusy(sid, false)
    delete busyDir.current[sid]
    // 只作废属于本会话的在途记录：别的会话那一条还活着，不能一起清
    if (inflight.current?.sid === sid) inflight.current = null
    oc.abort(sid, dir).catch((e) => {
      const st = (e as Error & { status?: number }).status
      // 502/503 是主进程代抛的传输层故障（内核仍在跑），不代表停止没送到
      if (!st || st === 502 || st === 503) return
      const msg = e instanceof Error ? e.message : String(e)
      setError('停止失败：' + msg.slice(0, 120))
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
      models: c.models
        .filter((m) => genRoleOf(m) === 'none' && (m.input ?? MODEL_DEFAULTS.input).includes('text'))
        .map((m) => ({
          mid: m.id,
          name: m.name,
          free: m.free,
          discount: m.discount,
          ratio: m.ratio,
          effRatio: m.effRatio
        }))
    }))
    // 组内一个可对话模型都没有的提供商直接不显示，免得点进去是空列
    .filter((g) => g.models.length > 0)

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

  // 无选中或选中已失效（提供商被停用/删除/模型被改）时，自动落到第一个可用模型。
  // 关键：设置尚未加载完成时绝不能跑校验——此刻 groups 为空，会把用户的存档值误判失效清掉。
  useEffect(() => {
    if (!p.settingsReady) return
    const i = p.model.indexOf('/')
    const valid =
      i > 0 && groups.some((g) => g.id === p.model.slice(0, i) && g.models.some((m) => m.mid === p.model.slice(i + 1)))
    if (!valid) p.onModelChange(groups[0] ? `${groups[0].id}/${groups[0].models[0].mid}` : '')
  }, [p.model, p.settings, p.settingsReady])  // 切换项目/会话：先清旧内容再拉历史（项目切换瞬间 sessionId 为空）
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
      .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      askAlive = false
    }
  }, [p.sessionId, p.project?.path])

  /**
   * 桌面控制看门狗：单次 `computer` 调用僵住超过 45 秒就中止本轮、把键鼠还给用户。
   *
   * 正常链路上限是 30 秒——内核侧给 computer-use 这个 MCP 配了 timeout，
   * screen-mcp 内部还有更紧的预算（一次调用 25s、等回包 20s、识图 10s）。
   * 这里只防「工具状态流式更新漏了一拍」这种极端情况：没有它，界面会一直卡在
   * 「AI 正在控制你的电脑」那句话上，输入框也被 desktopCtl 锁着，用户只能杀进程。
   */
  useEffect(() => {
    if (!busy) {
      computerStart.current = {}
      return
    }
    const timer = window.setInterval(() => {
      const last = watchdogRef.current.msgs.find((m) => m.info.id === watchdogRef.current.lastAid)
      const running = (last?.parts ?? []).filter(
        (x) => x.type === 'tool' && x.state?.status === 'running' && (x.tool ?? '').toLowerCase().includes('computer')
      )
      const ids = new Set(running.map((x) => x.id))
      for (const k of Object.keys(computerStart.current)) if (!ids.has(k)) delete computerStart.current[k]
      for (const part of running) {
        const t0 = computerStart.current[part.id] ?? (computerStart.current[part.id] = part.state?.time?.start ?? Date.now())
        if (Date.now() - t0 < DESKTOP_STUCK_MS) continue
        const sid = sidRef.current
        if (sid) oc.abort(sid, busyDir.current[sid]).catch(() => { /* 已结束 */ })
        setNotice('这一步桌面控制超过 45 秒没有回结果，已中止本轮（键鼠已交还给你）。可以点「重试」再试一次。')
        computerStart.current = {}
        break
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [busy])

  // 订阅内核事件：token 级增量 + part 快照 + 会话空闲
  useEffect(() => {
    const off = window.qingniao.onEvent(async (raw) => {
      const e = raw as { type: string; properties: Record<string, unknown> }
      if (e.type === 'message.updated') {
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
        const isCurrent = idleSid === sidRef.current
        oc.messages(idleSid, isCurrent ? dirRef.current : undefined)
          .then((list) => {
            // 回合结束但还残留半截工具调用（写入空转、断流截断）= 中断，自动续跑；
            // 「最后一条是空的助手消息」= 模型请求中途断了，同样给中断提示（否则界面一片静默）
            const last = list[list.length - 1]
            if (last && (last.info.role === 'user' || isAbortedAssistant(last) || isEmptyTurn(last))) scheduleRetry(idleSid)
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
              // 重连前任务被中断（断流截断/残留半截工具调用）→ 自动续跑
              if (isAbortedAssistant(list[list.length - 1])) scheduleRetry(s)
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
            // session.error 到达 = 任务已失败；只要本轮仍在处理中就自动续跑（continuationText 无内容时会自行取消）
            if (owned) scheduleRetry(sid)
            if (!isCurrent) return
            setMsgs(hydrate(list, shown.current, texts.current))
            setError(humanizeError(pr.error?.message ?? ''))
            p.onRefreshSessions()
          })
          .catch(() => { if (isCurrent) setError(humanizeError(pr.error?.message ?? '')) })
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
    let i = 0
    if (hijack.current != null) {
      i = Math.min(hijack.current, q.length - 1)
      hijack.current = null
    }
    const sid = p.sessionId
    const text = q[i]
    dropQueueItem(sid, i)
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
    p.onBrowserUi({ open: browserOpen || manualBrowser, max: browserMax })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserOpen, manualBrowser, browserMax])

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
    if (i <= 0) return undefined // 跟随内核默认，无法判定，不干预
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
      setNotice(`当前模型只能生成、不能对话，已切到「${cand.name || cand.id}」；出图、出片、配音都由对应工具完成。`)
      return { providerID: pid, modelID: cand.id }
    }
    // 再看缺不缺图片/视频输入（附件要的，或桌面控制要看截屏要的）
    const lack = need.filter((n) => !curInput.includes(n))
    if (!lack.length) return undefined
    const cand = cur?.models.find((mm) => chattable(mm) && lack.every((n) => inputs(mm).includes(n)))
    if (!cand) {
      if (lack.includes('video')) {
        // 图片收不到还有识图 MCP 代看，视频没有代看路径：换不到模型时只能提前讲明白
        setNotice('这条附件是视频，而当前提供商里没有支持视频输入的模型可换——AI 这轮只会看到文件路径，读不到画面。可在 设置 → 模型 给支持视频的模型勾上「输入 · 视频」再发。')
      }
      return undefined // 原样发：路径照样能交给生图/识图工具处理
    }
    p.onModelChange(`${pid}/${cand.id}`)
    setNotice(
      `当前模型不支持${lack.includes('image') && lack.includes('video') ? '图片/视频' : lack.includes('image') ? '图片' : '视频'}输入，` +
        `已切到「${cand.name || cand.id}」以便看懂附件内容。`
    )
    return { providerID: pid, modelID: cand.id }
  }

  async function send() {
    const text = input.trim()
    if (!text && !atts.length) return
    const files = atts
    setNotice('') // 新的一轮先清掉上次的切换提示，避免旧提示赖在对话末尾
    // 自动预警：用户用文字要「生图/生视频」，但当前没配生图模型（工具根本不存在，再提示也真出不了图）。
    // 提前说明，避免模型为了出图去写 Python 装库、用户看着一头雾水。
    if (text && isGenIntent(text) && !hasGenModel(p.settings)) {
      const needsModule = files.some((a) => a.mime.startsWith('image/') || a.mime.startsWith('video/'))
      setNotice(
        (needsModule ? '这段附图要做成新图/新片，也' : '') +
          '当前没有配置生图/生视频模型，AI 出不了真图。请在 设置 → 提供商 里加一个生图模型（如 flux / stable-diffusion / dall-e / *-image-*），否则 AI 只能靠代码画图、效果有限。'
      )
    }
    // 当前模型不能聊天，或看不懂本轮附件时，自动换成同提供商能胜任的模型（详见 resolveChatModel）
    const promptModel = resolveChatModel(files, text)
    if (busy && atts.length) {
      setError('处理中不能发送附件，请等当前任务结束后再发送')
      return
    }
    setAtts([])
    setInput('')
    setError('')
    if (text) {
      hist.current.push(text)
      histPos.current = hist.current.length
    }
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
    if (!sid) {
      // 草稿：首次发送才真正创建会话；标题直接用用户这句话（纯附件发送时用占位标题）
      const title = (text.length > 30 ? text.slice(0, 30) + '…' : text) || '发送了附件'
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
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    // 浏览器对话上下文：面板开着且有页面时，先把「当前页面」以仅上下文注入，
    // 让本轮对话默认针对这个 URL（网页浏览场景）而不是本地项目；URL 没变就不重复注入。
    // **全屏浏览（浏览模式 / 面板放大）时另外标一份**：这时面板占满整个窗口，
    // 操作面就是那个网页，本轮必须走 panel_*、禁用 computer（见下方桌面路由的互斥判定）。
    const browserFullscreen = (browserMax || manualBrowser) && !!panelUrl
    if ((browserOpen || manualBrowser || browserMax) && panelUrl) {
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
              '不要读写项目文件或执行终端命令，除非用户明确要求；回答优先基于当前页面的实际内容。'
          )
          browserCtxRef.current = { sid, url: panelUrl, max: browserFullscreen }
        } catch {
          /* 注入失败不阻塞对话，AI 仍可自行用工具探页面 */
        }
      }
    }
    // 桌面控制场景：本轮要操作的是用户**真实的整个桌面**，与内置浏览器（应用内一块网页面板）
    // 是两套互不替代的操作面。不点名的话模型容易串台——拿 panel_* 去开桌面应用（开不动），
    // 或在控制桌面中途跑去开内置浏览器。这里把边界按死：只用 computer，不要碰 panel_*。
    //
    // **全屏浏览时反过来压制**：面板已占满窗口、用户正盯着一个网页，此时「打开微信发消息」
    // 这类命中桌面意图的词，若照旧注入「只用 computer」，就会与浏览器上下文互相打架，
    // 结果 AI 去截整个桌面（用户明确要求：全屏浏览时禁用 computer-use，只用 panel_）。
    if (isDesktopIntent(text) && p.desktopControl && !browserFullscreen) {
      const dc = desktopCtxRef.current
      if (!dc || dc.sid !== sid || dc.text !== text) {
        try {
          await oc.injectContext(
            sid,
            dir,
            DESKTOP_CTX_PREFIX +
              '这一轮的任务是**操作本机桌面 / 桌面应用**（不是浏览网页）。\n' +
              '- 优先走无障碍树（`uia_windows` 找窗口 → `uia_tree` 读元素 → `uia_click` / `uia_set_text` / `uia_focus`）：' +
              '原生控件应用（资源管理器、记事本、系统设置等）走这一档，纯文本、几十毫秒、不需要看图。\n' +
              '- 自绘界面（微信这类，`uia_tree` 会明确回「没有可操作元素」，实测只剩标题栏三个按钮）改用**键盘流程**：' +
              '`uia_tree` 一旦告诉你树是空的，**立刻转键盘，不要再试第二遍 `uia_windows` / `uia_tree`**。\n' +
              '  **按键一律用 `uia_keys` 并带上目标窗口**：`uia_keys {"keys":"ctrl+f","match":"微信"}`——' +
              '它会先把目标窗口切到前台、确认成功后才发键；切不过去就直接拒绝，**绝不会把键打进别的窗口**。\n' +
              '  **粘贴一律用 `uia_paste`**（内容先用 `computer-use_set_clipboard` 放好）：`uia_paste {"match":"微信"}`。' +
              '它粘贴前会先 Ctrl+A 全选，**是覆盖不是追加**——不管输入框里原本剩着什么，粘完里面就是你要发的这一份，重发不会叠成两份。\n' +
              '  **青鸟自己的窗口永远不会被输入**：当前最前面是青鸟（就是用户正在跟你对话的这个窗口）时，按键类调用会被' +
              '**直接拒绝**——这是保护用户输入框的一道闸，不是故障；照回执改用带 `match` 的 `uia_keys` / `uia_paste` 即可。\n' +
              '  **发给真人 / 群的消息，在按回车之前先用 `uia_read_input` 核对输入框里真实的内容**' +
              '（Ctrl+A + Ctrl+C 把输入框内容读回来，**不需要截图**）；内容不对就重新 set_clipboard 再 ' +
              '`uia_paste {"match":"微信","enter":false}` 粘一次，**别把明显不对的内容发出去**。\n' +
              '  键盘路线是**确定性流程，全程不需要看画面**。微信完整例子：' +
              '`uia_keys {"keys":"esc","match":"微信"}` → `uia_keys {"keys":"ctrl+f","match":"微信"}` → ' +
              '`computer-use_set_clipboard`（mode="text" 放好会话名）→ `uia_paste {"match":"微信"}`（打开会话）→ ' +
              '`computer-use_set_clipboard`（mode="text" 换成正文）→ `uia_paste {"match":"微信","enter":false}` → ' +
              '`uia_read_input {"match":"微信"}` 核对内容 → `uia_keys {"keys":"return","match":"微信"}`。\n' +
              '  **要发送本地文件 / 图片**（如「把这张图发给微信好友 X」）：`computer-use_set_clipboard` 的 ' +
              'mode="image"（发图片消息）或 mode="file"（发文件），files 填前面工具回执里「本地文件：」那一行的绝对路径，' +
              '再 `uia_paste {"match":"微信"}` 发出。' +
              '**不要为了「确认图片内容」去调识图工具**，也不要用 glob 满目录找图片——路径就在回执里。\n' +
              '- **截屏是最后的最后兜底，同一轮最多用一次**：只有「无障碍树和键盘都不适用」（游戏、纯 canvas）' +
              '才用 `{"action":"get_screenshot"}`，而且**只能用来决定「先点哪儿」这种开局判断**。\n' +
              '  **严禁用截屏去确认某一步成没成**——每一步都截一张就是用户看到的「反复截图死循环」：' +
              '每张截图都要额外调一次视觉模型（慢、消耗额度），而且它并不比键盘流程更可靠。\n' +
              '- **不要调用 `panel_*`**：内置浏览器是青鸟窗口里的网页面板，只能操作网页，' +
              '打不开也控制不了桌面上的应用（微信、资源管理器、外部浏览器窗口等），调它只会白跑一趟。'
          )
          desktopCtxRef.current = { sid, text }
        } catch {
          /* 注入失败不阻塞对话，路由约定里也写了同一条边界 */
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
      try {
        await oc.injectContext(sid, dir, ATTACH_CTX_PREFIX + lines.join('\n'))
      } catch {
        /* 注入失败不阻塞发送 */
      }
    }

    markBusy(sid, true, dir)
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
          // 请求回来了、但最后一轮是条空壳助手消息（模型响应中途断掉）：内核不会报错、
          // 也没有 idle 之外任何信号。这里补一次「中断」提示，给用户一个重试入口——
          // 否则界面上只会看到 AI「突然就结束了」，既没原因也没法接着跑。
          const last = list[list.length - 1]
          if (last && isEmptyTurn(last)) scheduleRetry(sid)
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
      const sid = sidRef.current
      const text = (queues[sid] ?? [])[i]
      dropQueueItem(sid, i)
      // 队列里这条消息就是用户的新指令，优先于自动重试续跑
      cancelRetry(sid)
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
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
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
        setError(`权限应答没能送达内核：${err}`)
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
      if (err) setNotice(`授权未生效：${err}`)
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
          <div className="float-head" title="拖动移动位置 · 双击复位"
            onPointerDown={startFloatDrag}
            onDoubleClick={() => { setFloatPos(null); save('qingniao.floatPos', null) }}>
            <span className="float-hint" title={panelUrl ? `当前页面：${panelUrl}` : undefined}>
              <span className="float-hint-dot" />
              AI 可对话操作此浏览器
            </span>
            <button className="float-close" title="收起对话" onClick={() => setFloatOpen(false)}>
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
              <div className="empty-title">新对话</div>
              {(manualBrowser || browserMax) && panelUrl ? (
                <div>在下方输入框提问，AI 会针对当前浏览器页面作答并直接操作这个浏览器</div>
              ) : (
                <div>在下方输入框描述任务，AI 会直接在这个项目里读取、修改代码并执行终端命令</div>
              )}
              <div>Enter 发送 · Shift+Enter 换行 · 处理中可随时停止，已发送的消息可编辑后重发</div>
            </div>
          )}
          {msgs.map((m) => {
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
                .map((x) => ({ mime: x.mime, name: (x.filename || '附件').replace(/^.*[\\/]/, ''), url: x.url }))
              return <UserBubble key={m.info.id} text={txt} atts={fatts} editable={!busy} onSend={(t) => void resendMessage(m.info.id, t)} />
            }
            return (
              <div key={m.info.id} className="amsg">
                {m.parts.map((part) => (
                  <PartView key={part.id} part={part} projectPath={p.project?.path} preview={previews[part.id]} live={busy && m.info.id === lastAid} diffs={diffs[turnOwner.get(m.info.id) ?? '']} />
                ))}
                {!busy && m.info.id === lastAid && msgErrorText(m) && (
                  <div className="msgerr">
                    <AlertCircle size={13} /> <span>{msgErrorText(m)}</span>
                  </div>
                )}
                {/* 本轮额外调用过的模型：只在真调过时出现，挂在回复末尾让用户对得上账 */}
                {!busy && !!usedByMsg[m.info.id]?.length && (
                  <div className="cu-models" title={usedByMsg[m.info.id].map((u) => `${u.label || u.id}（${u.provider || u.id}）`).join('\n')}>
                    <Cpu size={12} />
                    <span>本轮另调用：{summarizeModels(usedByMsg[m.info.id])}</span>
                  </div>
                )}
              </div>
            )
          })}
          {/* 失败反馈走对话流：作为一条 AI 消息落在消息末尾，而非顶部弹条 */}
          {error && (
            <div className="amsg">
              <div className="msgerr">
                <AlertCircle size={13} /> <span>{error}</span>
                <button className="icon-btn" title="关闭" onClick={() => setError('')}>
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
                <button className="icon-btn" title="关闭" onClick={() => setNotice('')}>
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
          {cuBlind && (
            <div className="amsg">
              <div className="msgnotice">
                <Info size={13} />{' '}
                <span>
                  桌面控制要看屏幕截图，但<strong>没有任何模型能做视觉代看</strong>，AI 这轮看不到屏幕。
                  请到 设置 → 模型，给有识图能力的模型勾上输入类型里的「视觉」（可与「图片」一起勾），
                  它就会在控制电脑时替对话模型看画面。
                </span>
              </div>
            </div>
          )}
          {/* 桌面控制醒目提示：AI 正在操作这台电脑，键鼠会自己动，用户要能一眼知道发生了什么 */}
          {desktopBanner && (
            <div className="amsg">
              <div className={'cu-banner' + (desktopCtl ? ' live' : '')}>
                {desktopCtl ? <LoaderCircle size={14} className="spin" /> : <Monitor size={14} />}
                <div className="cu-text">
                  <strong>{desktopCtl ? 'AI 正在控制你的电脑' : '桌面控制已启用'}</strong>
                  <span>
                    {desktopCtl
                      ? '鼠标和键盘由 AI 操作中，请不要碰键鼠，以免打断它。'
                      : '刚才的操作使用过鼠标和键盘。'}
                    {cuVisionAssist &&
                      ` 当前模型看不了画面，截图已交给视觉模型${cuVisionWho ? `「${cuVisionWho}」` : ''}代看。`}
                  </span>
                </div>
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
            <AskModal key={asks[0].id} req={asks[0]} onReply={(ans) => replyAsk(asks[0], ans)} onReject={() => rejectAsk(asks[0])} />
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
                      ? `处理中，已用时 ${turnElapsed}`
                      : `正在思考，已用时 ${turnElapsed}`}
                </>
              )}
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

      {/* 通知（中断重试）统一在输入窗上方的 .topnotify 里展示，这里只负责任务队列。 */}
      {curQueue.length > 0 && (
        <div className="qbar">
          <div className="col">
            <button className="qhead" onClick={() => setQCollapsed((v) => !v)}>
              {qCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              任务队列 · {curQueue.length} 条
              <span className="q-sub">排队等当前任务完成</span>
            </button>
            {!qCollapsed &&
              curQueue.map((t, i) => (
                <div key={i} className="qitem" title={t}>
                  <span className="qi-no">{i + 1}</span>
                  <span className="qi-text">{t}</span>
                  <span className="qacts">
                    <button className="icon-btn" title="立即执行（中断当前任务）" onClick={() => queueSend(i)}>
                      <Send size={13} />
                    </button>
                    <button className="icon-btn" title="移回输入框编辑" onClick={() => queueEdit(i)}>
                      <Pencil size={13} />
                    </button>
                    <button className="icon-btn danger" title="删除" onClick={() => dropQueueItem(sidRef.current, i)}>
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

      {/* 通知区：所有状态通知贴在聊天输入窗（.cwrap）上方、水平居中。
          「聊天对话框上方」指的是输入框上头这条，不是界面/消息区最顶部。
          用流内嵌而非绝对定位浮层——浮层会横向盖住下方、可能压到任务队列；
          这里在任务队列之后、输入框之前，消息流滚动不影响它（.msgs 是独立滚动区）。 */}
      <div className="topnotify">
        {retryState && (
          <div className="notify retry">
            <AlertCircle size={13} />
            <span>任务已中断</span>
            <button className="retrybtn" onClick={() => void retryNow()} title="让 AI 接着处理">
              <RotateCw size={13} /> 重试
            </button>
            <button className="icon-btn" title="关闭" onClick={() => cancelRetry(p.sessionId)}>
              <X size={13} />
            </button>
          </div>
        )}
      </div>
      <div className="cwrap">
        <div className="cbox col">
          <textarea
            ref={taRef}
            className="ctext"
            value={input}
            rows={2}
            readOnly={desktopCtl}
            placeholder={
              desktopCtl
                ? 'AI 正在控制桌面，输入已暂时锁定'
                : busy
                  ? '当前任务执行中，输入新需求可加入队列'
                  : panelUrl && (manualBrowser || browserMax)
                    ? '针对当前浏览器页面提问，AI 会直接操作这个浏览器'
                    : 'Enter 发送 / Shift+Enter 换行'
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
                if (!desktopCtl) send()
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
                  <button className="catt-x" title="移除附件" onClick={() => setAtts((prev) => prev.filter((_, j) => j !== i))}>
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
                  ? '处理中不能上传附件'
                  : '上传图片、视频或音频（图片配合生图模型可图生图；音频可让 AI 转文字）'
              }
              disabled={busy}
              onClick={() => void pickAtt()}
            >
              <Paperclip size={14} />
            </button>
            <ProjectPicker
              projects={p.projects}
              value={p.project?.id}
              onChange={p.onSwitchProject}
              onPickDir={p.onPickDir}
            />
            {/* 访问权限：独立一颗按钮，紧挨「选择文件夹」右侧。放这儿才能常显当前档位。
                它是**全局**一档（对所有文件夹生效），与左边选哪个项目无关。
                全屏浏览时不显示：浏览场景不需要切权限档位 */}
            {!browserMax && <AccessPicker access={p.access} onAccess={p.onAccess} />}
            {terms.some((x) => x.status === 'running') && (
              <button className="crow-term" title="运行中的终端" onClick={() => setShowTerms(true)}>
                <Terminal size={13} />
                {terms.filter((x) => x.status === 'running').length}
              </button>
            )}
            {!browserMax && (
              <button className="icon-btn" title="浏览模式（全屏浏览器，右下角对话）" onClick={openBrowseMode}>
                <Globe size={14} />
              </button>
            )}
            <span className="spacer" />
            <ModelPicker
              groups={groups}
              value={p.model}
              onChange={p.onModelChange}
              onOpenSettings={p.onOpenSettings}
              onExpandGroup={(id) => void refreshGroupPrices(id)}
              refreshingGroup={refreshingGroup}
            />
            {/* 全屏浏览时不显示思考档位：浏览器场景直接回答，不需调思考深度 */}
            {!browserMax && <ThinkingPicker value={thinkVal} onChange={setThinkSel} kind={thinkKind} />}
            {/* 只有本会话在跑才显示停止：别的会话是用户另开的并行任务，不该被这里的按钮掐掉 */}
            {busy ? (
              <button className="send-round stop" title="停止当前任务，队列任务自动接续" onClick={() => void stopCurrent()}>
                <Square size={15} fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button className="send-round" disabled={!input.trim() && !atts.length} onClick={send} title="发送">
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
    {(browserOpen || manualBrowser) && (
      <BrowserPanel
        url={pinnedUrl || browserView.url}
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
        title={floatOpen ? '收起对话（可拖动换位置）' : '打开对话（可拖动换位置）'}
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
/** 右侧浏览面板：内嵌浏览器（webview 直接渲染网址，可交互，左缘可拖宽）；导航工具栏经 portal 放到标题栏中间，分享/放大/关闭不再重复（用标题栏右上角原生功能） */
function BrowserPanel({ url, navSeq, max, slot, onUrl, marks, onToggleMark, chatHidden, onToggleChat }: {
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
  /** 面板打开时的目标地址：有值才挂载 webview（空地址挂 webview 行为不可控）；之后的导航全走 loadURL，避免 React 改 src 属性造成二次加载 */
  const [src, setSrc] = useState(url)
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

  const lastNavSeq = useRef(navSeq)
  useEffect(() => {
    const force = navSeq !== lastNavSeq.current
    lastNavSeq.current = navSeq
    if (url && (force || url !== addr)) {
      setAddr(url)
      if (wvRef.current) wvRef.current.loadURL(url)
      else setSrc(url) // webview 未挂载：带 src 挂载即完成首航
    }
    // 只跟随 AI 的新导航与用户点链（navSeq）；addr 是用户手输值，不作为依赖
  }, [url, navSeq])

  // webview 由 React 直接管理 src（addr 变化即导航）；这里挂内核事件把页内跳转同步回地址栏
  /** 每次导航后查一遍历史状态，驱动前进/后退按钮可用性 */
  const syncNav = () => {
    const wv = wvRef.current
    if (!wv) return
    setNav({ back: wv.canGoBack(), fwd: wv.canGoForward() })
  }
  const bindWv = (wv: WebviewTag | null) => {
    if (wvRef.current) {
      wvRef.current.removeEventListener('did-navigate', onWvNav)
      wvRef.current.removeEventListener('did-navigate-in-page', onWvNav)
      wvRef.current.removeEventListener('page-title-updated', onWvTitle)
    }
    wvRef.current = wv
    if (wv) {
      wv.addEventListener('did-navigate', onWvNav)
      wv.addEventListener('did-navigate-in-page', onWvNav)
      wv.addEventListener('page-title-updated', onWvTitle)
    }
  }
  const onWvNav = (e: { url: string }): void => {
    setAddr(e.url)
    onUrl(e.url)
    syncNav()
  }
  const onWvTitle = (e: { title: string }): void => {
    setTitle(e.title)
  }

  function loadAddr(v: string) {
    const u = /^\w+:\/\//.test(v.trim()) ? v.trim() : 'https://' + v.trim()
    if (!u) return
    setAddr(u)
    if (wvRef.current) wvRef.current.loadURL(u)
    else setSrc(u) // webview 未挂载：带 src 挂载即完成首航
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
      setWidth(Math.min(Math.max(280, w0 + (x0 - ev.clientX)), row.clientWidth - 320))
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
      <button className="icon-btn" disabled={!nav.back} title="后退" onClick={() => wvRef.current?.goBack()}>
        <ArrowLeft size={15} />
      </button>
      <button className="icon-btn" disabled={!nav.fwd} title="前进" onClick={() => wvRef.current?.goForward()}>
        <ArrowRight size={15} />
      </button>
      <input
        className="bp-url"
        value={addr}
        placeholder="输入网址回车打开"
        spellCheck={false}
        onChange={(e) => setAddr(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') loadAddr((e.target as HTMLInputElement).value)
        }}
      />
      <button
        className={'icon-btn bp-star' + (starred ? ' starred' : '')}
        title={starred ? '取消收藏' : '收藏此页面（全屏时顶部显示收藏条）'}
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
              ? 'AI 对话已隐藏 · 点击显示右下角气泡'
              : 'AI 对话显示中 · 点击隐藏'
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
      {slot && createPortal(head, slot)}
      {dragShield && <div className="drag-shield" />}
      <aside
        ref={panelRef}
        className={'browser-panel' + (max ? ' max' : '')}
        style={width != null && !max ? { width, maxWidth: 'none' } : undefined}
      >
        {!max && <div className="bp-resizer" onPointerDown={startResize} />}
        {/* 全屏时的收藏夹条：点击直达，hover 出现取消收藏；无网址的浏览模式入口也能一键开收藏页 */}
        {max && marks.length > 0 && (
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
                  title="取消收藏"
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
        {src ? (
          <webview
            ref={bindWv}
            className="bp-wv"
            src={src}
            partition="persist:webpanel"
            allowpopups={false}
          />
        ) : (
          <div className="bp-nourl">在顶部地址栏输入网址后回车打开</div>
        )}
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
 */
function Collapsible({
  children,
  maxPx,
  forceText,
  live
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
}) {
  const [open, setOpen] = useState(false)
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
          {open ? '收起' : '展开全文'}
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
  invalid: { name: '无效调用', icon: <AlertCircle size={13} /> },
  // MCP 工具：内核注册时会拼上「服务名_工具名」，桌面键鼠那条就变成 computer-use_computer
  // 这种重复到读不出来的名字。标签里只留服务名那一半（用户明确要求：就叫 computer-use）。
  'computer-use_computer': { name: 'computer-use', icon: <Monitor size={13} /> }
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
    <Modal title={`助手提问 ${i + 1}/${req.questions.length}`} anchor="top" onClose={onReject}>
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
  const label = PERM_LABEL[kind] ?? kind ?? '操作'
  /** 命令类：整行等宽显示；文件类：缩成相对项目路径 */
  const isCmd = /bash|shell|command|exec/i.test(kind)
  const shown = targets.map((t) => (isCmd ? t : relPath(t, dir)))

  return (
    <Modal title={`是否允许${label}？`} anchor="top" onClose={() => onReply('reject')}>
      <div className="perm-q">
        <p className="perm-lead">
          AI 想{label}，需要你确认：
        </p>
        {shown.length > 0 && (
          <ul className="perm-list">
            {shown.map((t, i) => (
              <li key={i} className={isCmd ? 'mono' : undefined} title={targets[i]}>
                {t}
              </li>
            ))}
          </ul>
        )}
        <p className="perm-note">
          选「仅这一次」只放行这一下，之后同类操作仍会问你；
          「总是允许」在本会话内不再询问。想彻底不再问，可把该项目的访问权限改为「完全控制」。
        </p>
      </div>
      <div className="perm-acts">
        <button className="primary" onClick={() => onReply('once')}>
          仅这一次
        </button>
        {req.always.length > 0 && (
          <button className="ghost" onClick={() => onReply('always')}>
            总是允许
          </button>
        )}
        <button className="ghost danger-text" onClick={() => onReply('reject')}>
          拒绝
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
      const names = [...new Set(items.map((x) => x.label || x.id))].join('、')
      return `${MODEL_ROLE_LABEL[role] ?? role}「${names}」${items.length > 1 ? `×${items.length}` : ''}`
    })
    .join(' · ')
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
  const label = MODEL_ROLE_LABEL[req.role] ?? req.role ?? '调用模型'
  const name = req.label || req.id

  return (
    <Modal title="是否允许调用其他模型？" anchor="top" onClose={() => onReply('reject')}>
      <div className="perm-q">
        <p className="perm-lead">
          AI 要用「{name}」来{label}，需要你确认：
        </p>
        <ul className="perm-list">
          <li title={`${req.provider || req.id} / ${req.id}`}>
            {name}
            <span className="perm-sub">　{req.provider ? `${req.provider} · ` : ''}{req.id}</span>
          </li>
        </ul>
        <p className="perm-note">
          这一步会调用<strong>除当前对话模型之外</strong>的模型，可能产生额外费用。
          「仅这一次」只放行这一下；「本次会话」在应用重启前不再问；「永久允许」写进设置，之后可随时撤销。
        </p>
      </div>
      <div className="perm-acts">
        <button className="primary" onClick={() => onReply('once')}>
          仅这一次
        </button>
        <button className="ghost" onClick={() => onReply('session')}>
          本次会话允许
        </button>
        <button className="ghost" onClick={() => onReply('always')}>
          永久允许
        </button>
        <button className="ghost danger-text" onClick={() => onReply('reject')}>
          拒绝
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
  // 无效调用的内核标题是英文「Invalid Tool」，折叠行只留中文名+错误图标
  if ((part.tool ?? '').toLowerCase() === 'invalid') return ''
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
    }
    return (
      <Collapsible maxPx={520} forceText={part.text} live={live}>
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
      const zh = TOOL_META[inner.toLowerCase()]?.name ?? inner
      const err = str(toolIn?.error)
      const cut = err.length > 2000 ? err.slice(0, 2000) + '\n…' : err
      body = <CodeBlock text={inner ? `「${zh}」工具的调用参数不完整，已让模型重写参数重试。\n${cut}` : cut} />
    } else if (rawOut && tool === 'read') {
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
        hideErr={readMiss}
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
  hideErr,
  stats,
  spin = true
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

/** 展开详情代码块：diff 着色 / highlight.js 语法高亮 / 纯文本 */
function CodeBlock({ text, file, diff }: { text: string; file?: string; diff?: boolean }) {
  if (diff) {
    const lines = renderDiffLines(text)
    const hasColor = lines.some((l) => l.kind !== 'ctx')
    if (!hasColor) {
      return (
        <pre className="step-code">
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
