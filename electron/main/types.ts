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

/** 技能作用域：全局（~/.qingniaoai/opencode/skills）或当前项目（<项目>/.opencode/skills） */
export type SkillScope = 'global' | 'project'

/** 一条技能 = 一个含 SKILL.md 的目录（内核按目录名识别技能名） */
export interface SkillItem {
  /** 目录名，也是内核识别的技能名 */
  name: string
  scope: SkillScope
  /** SKILL.md 的绝对路径 */
  path: string
  /** 模型据此判断何时加载该技能 */
  description: string
  /** frontmatter 校验失败的原因；合法时为 undefined */
  error?: string
}

export interface SkillDraft {
  scope: SkillScope
  /** project 作用域必填：技能所属项目的绝对路径 */
  projectPath?: string | null
  /** 编辑已有技能时的原目录名；新建时留空（用于重命名时清理旧目录） */
  originalName?: string
  name: string
  description: string
  /** frontmatter 之后的正文 */
  body: string
}
