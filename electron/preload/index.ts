import { contextBridge, ipcRenderer } from 'electron'
import type { Settings, SkillDraft, SkillItem, SkillScope } from '../main/types'

/** 暴露给渲染进程的最小桥：REST 代理 + 事件订阅 + 应用级能力 */
const api = {
  call: (path: string, opts?: { method?: string; body?: unknown }): Promise<{ status: number; data: unknown }> =>
    ipcRenderer.invoke('opencode:api', path, opts),
  onEvent: (cb: (e: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => cb(data)
    ipcRenderer.on('opencode:event', handler)
    return () => ipcRenderer.removeListener('opencode:event', handler)
  },
  info: (): Promise<{ workspace: string }> => ipcRenderer.invoke('app:info'),
  pickDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  /** 内核健康探测（主进程 isHealthy；渲染层停止按钮的兜底判断用） */
  kernelHealth: (): Promise<boolean> => ipcRenderer.invoke('kernel:health'),
  saveSettings: (s: Settings): Promise<void> => ipcRenderer.invoke('settings:save', s),
  fetchModels: (
    baseURL: string,
    apiKey?: string
  ): Promise<{ models?: string[]; error?: string }> => ipcRenderer.invoke('models:fetch', { baseURL, apiKey }),
  /** 读取项目记忆：<项目>/.qingniao/memory/MEMORY.md（长期）+ YYYY-MM-DD.md（当日），目录不存在则建 */
  readMemory: (projectPath: string): Promise<{ long: string; daily: string }> =>
    ipcRenderer.invoke('memory:read', projectPath),
  /** 把一段内容追加到项目当日记忆文件（<项目>/.qingniao/memory/YYYY-MM-DD.md） */
  appendMemory: (projectPath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('memory:append', { projectPath, content }),
  /** 技能列表：全局（~/.qingniaoai/opencode/skills）+ 当前项目（<项目>/.opencode/skills），含 frontmatter 校验结果 */
  listSkills: (projectPath?: string | null): Promise<SkillItem[]> => ipcRenderer.invoke('skills:list', { projectPath }),
  /** 读单条技能，返回拆分后的 frontmatter 与正文（编辑弹窗回填用） */
  readSkill: (req: {
    scope: SkillScope
    projectPath?: string | null
    name: string
  }): Promise<{ name: string; description: string; body: string; hasFm: boolean }> => ipcRenderer.invoke('skills:read', req),
  /** 新建或保存技能（改名时自动清理旧目录），返回 { error } 表示校验未通过 */
  saveSkill: (draft: SkillDraft): Promise<{ error?: string }> => ipcRenderer.invoke('skills:save', draft),
  removeSkill: (req: { scope: SkillScope; projectPath?: string | null; name: string }): Promise<void> =>
    ipcRenderer.invoke('skills:remove', req),
  /** 在系统文件管理器里打开技能目录 */
  openSkillsDir: (req: { scope: SkillScope; projectPath?: string | null }): Promise<string> =>
    ipcRenderer.invoke('skills:openDir', req),
  winMin: () => ipcRenderer.send('win:min'),
  winMax: () => ipcRenderer.send('win:max'),
  winClose: () => ipcRenderer.send('win:close'),
  winIsMax: (): Promise<boolean> => ipcRenderer.invoke('win:isMax'),
  onWinMax: (cb: (v: boolean) => void): (() => void) => {
    const handler = (_: unknown, v: boolean): void => cb(v)
    ipcRenderer.on('win:maximized', handler)
    return () => ipcRenderer.removeListener('win:maximized', handler)
  }
}

export type QingniaoBridge = typeof api

contextBridge.exposeInMainWorld('qingniao', api)
