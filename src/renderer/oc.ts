/** OpenCode 内核 REST API 的渲染层封装（经主进程代理，见 electron/main） */
import type { McpCfg, ProviderCfg, Settings } from '../../electron/main/types'

export type { McpCfg, ProviderCfg }
/** 设置聚合（避开与 lucide `Settings` 图标重名） */
export type SettingsCfg = Settings

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
}

export interface ToolState {
  status?: string
  title?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
}

export interface Part {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  tool?: string
  state?: ToolState
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
  sessions: (directory?: string) => call<Session[]>(`/session${dirQ(directory)}`),
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
  abort: (id: string) => call(`/session/${id}/abort`, { method: 'POST' }),
  deleteSession: (id: string, directory?: string) =>
    call(`/session/${id}${dirQ(directory)}`, { method: 'DELETE' }),
  /** 内核全部待答问题（question 工具阻塞等待用户应答；事件可能漏收，轮询对账用） */
  questions: () => call<QuestionAsk[]>('/question'),
  /** 内核管理的终端列表（pty.created/updated/exited/deleted 事件可触发即时刷新） */
  terminals: () => call<PtySession[]>('/pty'),
  /** 终止终端（内核会杀掉该 pty 进程） */
  killTerminal: (ptyID: string, directory?: string) => call(`/pty/${ptyID}${dirQ(directory)}`, { method: 'DELETE' }),
  /** question 工具应答：answers 与 questions 一一对应，每项是选中的标签数组 */
  replyQuestion: (requestID: string, answers: string[][], directory?: string) =>
    call(`/question/${requestID}/reply${dirQ(directory)}`, { method: 'POST', body: { answers } }),
  rejectQuestion: (requestID: string, directory?: string) =>
    call(`/question/${requestID}/reject${dirQ(directory)}`, { method: 'POST' })
}
