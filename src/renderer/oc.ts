/** OpenCode 内核 REST API 的渲染层封装（经主进程代理，见 electron/main） */
import type { McpCfg, ProviderCfg, Settings } from '../../electron/main/types'
import { MODEL_DEFAULTS, isBuiltinModel } from '../../electron/main/types'

export type { McpCfg, Modality, ModelCfg, ProviderCfg, SkillDraft, SkillItem, SkillScope, DeskStatus } from '../../electron/main/types'
export type { PlatformStatus, UsageBucket, UsageRow, UsageSeries, UsageSummary, UsageLog, UsagePage, UsageRecord, PlatformAccount } from '../../electron/main/types'
export { MODEL_DEFAULTS } from '../../electron/main/types'
/** 设置聚合（避开与 lucide `Settings` 图标重名） */
export type SettingsCfg = Settings

/** 平台 provider 在内核里的 ID，与 electron/main/config.ts 的 PLATFORM_PROVIDER_ID 保持一致 */
export const PLATFORM_PROVIDER_ID = 'qingniao'

/**
 * 对话区的模型清单：平台「内置模型」永远排最前（二级列的就是后台启用的内置模型，跟随后台排序），
 * 用户自建的提供商接在后面。
 *
 * 两个过滤条件缺一不可：
 *   remote —— 全局关了远程服务时，平台这套（登录/内置模型）整个不该出现；
 *   builtin —— 后台为了适配各家上游会挂一批同名第三方模型（builtin=false），
 *              它们不属于「内置」，混进来会让人以为模型比实际多。
 *
 * 设置页绝不能吃这份列表——它保存时会把 providers 整体写回磁盘，
 * 而平台那条是登录态虚拟出来的，混进去会被落成一份假配置。
 */
export function chatProviders(s: SettingsCfg): ProviderCfg[] {
  const builtin = s.platform.models.filter(isBuiltinModel)
  const platform =
    s.remote && s.platform.token && builtin.length
      ? [
          {
            id: PLATFORM_PROVIDER_ID,
            name: '内置模型',
            baseURL: s.platform.baseUrl.replace(/\/+$/, '') + '/api/ide/v1',
            apiKey: '',
            enabled: true,
            models: builtin
          }
        ]
      : []

  return [...platform, ...s.providers]
}

/**
 * 所选模型是否支持图片输入（桌面控制 / 内置浏览器截图回传的硬依赖）。
 * key 为 'pid/mid'，'' = 跟随内核默认，无法判定，返回 true 不拦。
 */
export function modelSupportsImage(list: ProviderCfg[], key: string): boolean {
  if (!key) return true
  const i = key.indexOf('/')
  if (i <= 0) return true
  const m = list.find((x) => x.id === key.slice(0, i))?.models.find((x) => x.id === key.slice(i + 1))
  if (!m) return true
  return (m.input ?? MODEL_DEFAULTS.input).includes('image')
}

async function call<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const r = await window.qingniao.call(path, opts)
  if (r.status >= 400) {
    const err = new Error(typeof r.data === 'string' ? r.data : `${opts?.method ?? 'GET'} ${path} -> HTTP ${r.status}`) as Error & { status: number }
    err.status = r.status
    throw err
  }
  return r.data as T
}

export interface Session {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  /** 父会话 id：AI 用 task 工具（子 agent）派生出来的子会话都带这个字段；
   *  用户自己发起的会话没有。左侧任务列表只呈现用户的，故列表接口按它过滤 */
  parentID?: string
}

export interface ToolState {
  status?: string
  title?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  /** running 起跳时刻 / 起止时刻（内核 ToolState 携带，超时判定用） */
  time?: { start?: number; end?: number }
  /** 工具自身携带的结构化结果：edit 存 filediff，apply_patch/write 存 files[]
   *  （均为 {file, patch, additions, deletions}，直接用于 +N/-M 与差量展开） */
  metadata?: Record<string, unknown>
  /** MCP 工具返回的附件：browser_take_screenshot 的截图在这里（url 为 data:image/...;base64） */
  attachments?: { type?: string; mime?: string; url: string }[]
}

export interface Part {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  tool?: string
  state?: ToolState
  /** 内核某些版本把附件挂在 part 顶层而非 state 上，浏览面板提取时两处兼容 */
  attachments?: { type?: string; mime?: string; url: string }[]
}

export interface MessageInfo {
  id: string
  role: 'user' | 'assistant'
  sessionID: string
  modelID?: string
  providerID?: string
}

export interface MessageView {
  info: MessageInfo
  parts: Part[]
}

export interface ModelSel {
  providerID: string
  modelID: string
}

/**
 * 项目记忆注入标记：以该前缀开头的用户消息是「仅上下文」记忆（noReply 注入，AI 可见但界面不渲染），
 * 用于在新会话首发时把项目记忆喂给内核。ChatView 渲染时据此跳过，避免顶部出现多余提示。
 */
export const MEMORY_PREFIX = '␞␞项目记忆␞␞\n'

/**
 * 浏览器上下文注入标记：内置浏览器开着且有页面时，发消息前把「当前页面 URL + 对话聚焦浏览器」
 * 以 noReply 注入。与项目记忆同一机制——AI 可见、界面不渲染，ChatView 渲染时据此跳过。
 */
export const BROWSER_CTX_PREFIX = '␞␞浏览器上下文␞␞\n'

/** 内核 question 工具的提问请求（question.v2.asked 事件推送，阻塞等待用户应答） */
export interface QuestionAsk {
  id: string
  sessionID: string
  questions: {
    question: string
    options?: { label: string; description?: string }[]
    /** 允许一次选多个选项 */
    multiple?: boolean
    /** 允许自定义输入（默认 true） */
    custom?: boolean
  }[]
}

/**
 * 会话文件差量（内核 /session/{id}/diff 返回项）
 * messageID 必须是「用户消息」id：内核把整轮（该用户消息 + 其后续助手消息）的快照差量挂在它身上，
 * patch 是带 +/- 行的完整 unified diff，直接拿来着色即可
 */
export interface FileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

/** 内核管理的终端会话（PTY） */
export interface PtySession {
  id: string
  title?: string
  command: string
  args?: string[]
  cwd?: string
  status: 'running' | 'exited'
  pid?: number
  exitCode?: number
}

/** 多项目：所有会话类接口都带 directory 参数，同一内核实例按项目隔离 */
const dirQ = (directory?: string) => (directory ? `?directory=${encodeURIComponent(directory)}` : '')

export const oc = {
  /** 项目会话列表：**过滤掉 AI 派生的子会话**（task 工具 / 子 agent 创建，带 parentID）。
   *  左侧任务列表只显示用户自己创建的会话，AI 跑子任务不再往左栏冒条目。 */
  sessions: async (directory?: string) => {
    const list = await call<Session[]>(`/session${dirQ(directory)}`)
    return list.filter((s) => !s.parentID)
  },
  createSession: (directory?: string, title?: string) =>
    call<Session>(`/session${dirQ(directory)}`, { method: 'POST', body: { title } }),
  messages: (id: string, directory?: string) => call<MessageView[]>(`/session/${id}/message${dirQ(directory)}`),
  /** 同步等待本轮对话完成；期间流式内容走事件推送 */
  prompt: (id: string, directory: string | undefined, text: string, model?: ModelSel) =>
    call<MessageView>(`/session/${id}/message${dirQ(directory)}`, {
      method: 'POST',
      body: {
        parts: [{ type: 'text', text }],
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {})
      }
    }),
  abort: (id: string, directory?: string) => call(`/session/${id}/abort${dirQ(directory)}`, { method: 'POST' }),
  /** 注入「仅上下文」消息（noReply：不触发 AI 回复，但后续 prompt 自动带上它）——项目记忆用此机制自动喂给新会话 */
  injectContext: (id: string, directory: string | undefined, text: string) =>
    call(`/session/${id}/message${dirQ(directory)}`, {
      method: 'POST',
      body: { parts: [{ type: 'text', text }], noReply: true }
    }),
  /** 撤回会话到指定「用户消息」之前：回滚文件快照并移除该条及其后的历史（编辑消息重发用） */
  revert: (id: string, directory: string | undefined, messageID: string) =>
    call<unknown>(`/session/${id}/revert${dirQ(directory)}`, { method: 'POST', body: { messageID } }),
  deleteSession: (id: string, directory?: string) =>
    call(`/session/${id}${dirQ(directory)}`, { method: 'DELETE' }),
  /** 内核全部待答问题（question 工具阻塞等待用户应答；事件可能漏收，轮询对账用）。
   *  实测该端点按实例（directory）隔离：不带目录参数永远返回空数组，必须随项目传。 */
  questions: (directory?: string) => call<QuestionAsk[]>(`/question${dirQ(directory)}`),
  /** 会话文件差量：messageID 必填且必须是用户消息 id（不传或传助手消息 id 一律返回空数组） */
  diff: (id: string, directory: string | undefined, messageID: string) => {
    const q = dirQ(directory)
    return call<FileDiff[]>(`/session/${id}/diff${q}${q ? '&' : '?'}messageID=${encodeURIComponent(messageID)}`)
  },
  /** 内核管理的终端列表（pty.created/updated/exited/deleted 事件可触发即时刷新） */
  terminals: () => call<PtySession[]>('/pty'),
  /** 终止终端（内核会杀掉该 pty 进程） */
  killTerminal: (ptyID: string, directory?: string) => call(`/pty/${ptyID}${dirQ(directory)}`, { method: 'DELETE' }),
  /** 内核健康探测（主进程 isHealthy，不经内核 REST；停止按钮兜底用） */
  kernelHealth: (): Promise<boolean> => window.qingniao.kernelHealth(),
  /** question 工具应答：answers 与 questions 一一对应，每项是选中的标签数组 */
  replyQuestion: (requestID: string, answers: string[][], directory?: string) =>
    call(`/question/${requestID}/reply${dirQ(directory)}`, { method: 'POST', body: { answers } }),
  rejectQuestion: (requestID: string, directory?: string) =>
    call(`/question/${requestID}/reject${dirQ(directory)}`, { method: 'POST' })
}
