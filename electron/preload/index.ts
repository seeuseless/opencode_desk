import { contextBridge, ipcRenderer } from 'electron'
import type { Settings } from '../main/types'

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
