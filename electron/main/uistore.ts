import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { qingniaoHome } from './config.ts'

/**
 * 渲染层 UI 数据的唯一事实源：~/.qingniaoai/ui-store.json（一个扁平的 key → JSON 值表）。
 *
 * 早先这些数据（项目清单、排序、展开态、主题…）都存在 localStorage 里，而 localStorage
 * **按 origin 隔离**：`npm run dev` 走 http://localhost:5173，打包安装后走 file://，
 * 两边是两份互不可见的数据——于是「开发时加的项目，装完就没了」。挪到主进程文件后，
 * dev 与安装版读写的都是这一份，两边始终一致。
 *
 * 渲染层仍同步写一份 localStorage 当缓存（见 renderer/store.ts 的 hydrate），
 * 这样界面里的读法（同步 load）不用改成异步，首屏也不会等一次 IPC。
 */

export const uiStorePath = (): string => join(qingniaoHome(), 'ui-store.json')

function readAll(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(uiStorePath(), 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {} // 无文件 / 坏文件：当作空存档
  }
}

function writeAll(all: Record<string, unknown>): void {
  mkdirSync(qingniaoHome(), { recursive: true })
  writeFileSync(uiStorePath(), JSON.stringify(all, null, 2))
}

export function loadUiStore(): Record<string, unknown> {
  return readAll()
}

/** 写单个键（不存在则新增），返回落盘后的全量数据 */
export function setUiStore(key: string, value: unknown): Record<string, unknown> {
  const all = readAll()
  all[key] = value
  writeAll(all)
  return all
}

/** 删单个键 */
export function delUiStore(key: string): Record<string, unknown> {
  const all = readAll()
  delete all[key]
  writeAll(all)
  return all
}
