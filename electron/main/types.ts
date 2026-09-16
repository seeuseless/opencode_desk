/** 主进程与渲染层共享的设置类型（无 node 依赖，可在两侧 import） */

export interface ProviderCfg {
  id: string
  name: string
  baseURL: string
  apiKey: string
  enabled: boolean
  models: string[]
}

/** 自定义 MCP 服务器（local 用 command，remote 用 url） */
export interface McpCfg {
  name: string
  type: 'local' | 'remote'
  /** local：完整命令行（含参数），设置里按空格输入 */
  command: string
  /** remote：MCP 服务地址 */
  url: string
  enabled: boolean
}

export interface Settings {
  providers: ProviderCfg[]
  mcps: McpCfg[]
  /** 内置浏览器（Playwright MCP），依赖本机 npx */
  browser: boolean
}

export const DEFAULT_SETTINGS: Settings = { providers: [], mcps: [], browser: false }
