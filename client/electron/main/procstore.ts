import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { qingniaoHome } from './config.ts'

/**
 * 对话级服务进程登记：AI 在会话里启动的常驻服务（服务器/守护进程）按会话 id 落账到
 * ~/.qingniaoai/service-procs.json，对话内可查看与停止。
 *
 * 登记来源：渲染层从终端工具输出里解析约定的 `QN_SERVICE_PID=<pid>` 回显（启动约定
 * 由 ChatView 每会话注入一次），因此只有走了约定命令的服务才会出现在这里。
 * 存活探测每次 list 都做：进程在外部被关掉 / 重启应用后已死，都会被顺手清掉，
 * 界面轮询时自动消失。PID 理论上可能被系统复用造成误判，概率低、可接受。
 */

export interface ServiceProc {
  pid: number
  /** 启动命令摘要（展示 + 提示用户这是什么服务） */
  cmd: string
  /** 从命令里识别出的服务端口（展示用） */
  port?: number
  startedAt: number
}

const procPath = (): string => join(qingniaoHome(), 'service-procs.json')

function readAll(): Record<string, ServiceProc[]> {
  try {
    const raw = JSON.parse(readFileSync(procPath(), 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, ServiceProc[]>) : {}
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, ServiceProc[]>): void {
  mkdirSync(qingniaoHome(), { recursive: true })
  writeFileSync(procPath(), JSON.stringify(all, null, 2))
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // 无权探测 = 进程存在
  }
}

/** 探测全部登记项，清掉已死的进程与会话（外部关闭 / 重启后的自动对账），有变化就落盘 */
function prune(all: Record<string, ServiceProc[]>): Record<string, ServiceProc[]> {
  let changed = false
  for (const sid of Object.keys(all)) {
    const keep = all[sid].filter((p) => {
      const ok = alive(p.pid)
      if (!ok) changed = true
      return ok
    })
    if (!keep.length) {
      delete all[sid]
      changed = true
    } else if (keep.length !== all[sid].length) {
      all[sid] = keep
    }
  }
  if (changed) writeAll(all)
  return all
}

export function procList(sid: string): ServiceProc[] {
  return prune(readAll())[sid] ?? []
}

/** 全部会话当前存活的登记进程数（退出确认用）：探测一遍，顺手清掉死的 */
export function procAliveCount(): number {
  const all = prune(readAll())
  let n = 0
  for (const sid of Object.keys(all)) n += all[sid].length
  return n
}

/**
 * 退出确认状态：置位后窗口 close 拦截不再弹「服务在跑」确认。
 * 两个来源：用户在确认弹窗里点了「仍然退出」；更新器静默升级（用户已明确要退，不能再拦）。
 */
let quitConfirmedFlag = false

export function markQuitConfirmed(): void {
  quitConfirmedFlag = true
}

export function quitConfirmed(): boolean {
  return quitConfirmedFlag
}

export function procAdd(sid: string, proc: ServiceProc): ServiceProc[] {
  const all = prune(readAll())
  const list = (all[sid] ?? []).filter((x) => x.pid !== proc.pid)
  list.push(proc)
  all[sid] = list
  writeAll(all)
  return all[sid]
}

export function procKill(sid: string, pid: number): ServiceProc[] {
  // Windows 连子进程树一起杀（与内核 killTree 同款）；其他平台只杀本进程
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已死 */
    }
  }
  const all = readAll()
  const keep = (all[sid] ?? []).filter((x) => x.pid !== pid)
  if (keep.length) all[sid] = keep
  else delete all[sid]
  writeAll(all)
  return keep
}
