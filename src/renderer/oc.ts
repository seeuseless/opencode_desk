/** OpenCode 内核 REST API 的渲染层封装（经主进程代理，见 electron/main） */
import type { McpCfg, ProviderCfg, Settings } from '../../electron/main/types'

export type { McpCfg, ProviderCfg }
/** 设置聚合（避开与 lucide `Settings` 图标重名） */
export type SettingsCfg = Settings

async function call<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const r = await window.qingniao.call(path, opts)
  if (r.status >= 400) {
    throw new Error(typeof r.data === 'string' ? r.data : `${opts?.method ?? 'GET'} ${path} -> HTTP ${r.status}`)
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
    call(`/session/${id}${dirQ(directory)}`, { method: 'DELETE' })
}
