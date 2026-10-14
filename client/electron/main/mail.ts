// 邮件能力（Agent Mail / agently-cli）主进程侧：
// - CLI 定位：env QN_AGENTLY_CLI → dev（resources/mcp/node_modules）→ 打包态（resources/node_modules）→ PATH
//   与 mail-mcp.mjs 的解析保持同一套优先级（那边跑工具、这边管授权，谁先找到都一样）。
// - 状态查询：+me（真实验证，走网络）。
// - 设备授权：spawn `auth login`（CLI 自己会拉默认浏览器），从 stdout 抓授权 URL
//   兜底 openExternal，用户在浏览器完成授权后进程自动退出 → 广播渲染层刷新状态。
//
// 挂载：index.ts `ipcMain.handle('mail:status' | 'mail:login' | 'mail:logout')`。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { BrowserWindow } from 'electron'

export type MailStatus = { authorized: boolean; email?: string; error?: string }
export type MailEvent =
  | { type: 'login_started' }
  | { type: 'login_url'; url: string }
  | { type: 'login_done'; status: MailStatus }
  | { type: 'login_failed'; message: string }

const RUN_JS = join('@tencent-qqmail', 'agently-cli', 'scripts', 'run.js')

let mainWindow: BrowserWindow | null = null
export function setMailWindow(w: BrowserWindow | null): void {
  mainWindow = w
}

function pushEvent(e: MailEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('qingniao.mail', e)
}

/** 找到可执行的 CLI。返回 { command, shell } 或 null */
function resolveCli(): { command: string[]; shell?: boolean } | null {
  const env = process.env.QN_AGENTLY_CLI?.trim()
  if (env && existsSync(env)) return { command: [env] }
  const isPackaged = app.isPackaged
  // dev：resources/mcp/node_modules（mail-mcp.mjs 与依赖同目录）；打包：resources/node_modules
  const candidates = isPackaged
    ? [join(process.resourcesPath, 'node_modules', RUN_JS)]
    : [join(app.getAppPath(), 'resources', 'mcp', 'node_modules', RUN_JS)]
  for (const c of candidates) {
    if (existsSync(c)) return { command: [process.execPath, c] }
  }
  // PATH 兜底：Windows 的 npm shim 是 .cmd，必须开 shell 才能拉起
  const isWin = process.platform === 'win32'
  return { command: [isWin ? 'agently-cli.cmd' : 'agently-cli'], shell: isWin }
}

/** 跑一条 CLI 命令，返回 stdout（退出码非 0 且无 stdout 则抛错） */
function runCli(args: string[], timeoutMs = 20000): Promise<string> {
  const cli = resolveCli()
  if (!cli) return Promise.reject(new Error('未找到 agently-cli'))
  return new Promise((resolve, reject) => {
    const [exe, ...rest] = cli.command
    const p = spawn(exe, rest.concat(args), {
      shell: cli.shell === true,
      windowsHide: true,
      env: process.env
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('邮件命令超时'))
    }, timeoutMs)
    p.stdout?.on('data', (d: Buffer) => (out += d))
    p.stderr?.on('data', (d: Buffer) => (err += d))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || out.trim()) resolve(out)
      else reject(new Error(err.trim() || `agently-cli 退出码 ${code}`))
    })
  })
}

/** 查授权状态与邮箱地址（+me 是真实验证） */
export async function mailStatus(): Promise<MailStatus> {
  try {
    const out = await runCli(['+me'])
    const j = JSON.parse(out.trim())
    if (j?.ok && Array.isArray(j.data?.aliases) && j.data.aliases.length > 0) {
      const primary = j.data.aliases.find((a: { is_primary?: boolean }) => a.is_primary) ?? j.data.aliases[0]
      return { authorized: true, email: String(primary.email ?? '') }
    }
    return { authorized: false, error: '未授权' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // ENOENT（CLI 没找到）与未授权都归为「不可用」，界面统一展示 error
    return { authorized: false, error: msg }
  }
}

let loginProc: ChildProcess | null = null

/** 开始设备授权（同时只允许一个流程） */
export function mailLogin(): { error?: string } {
  if (loginProc) return { error: '授权流程已在进行中，请在浏览器里完成或稍候' }
  const cli = resolveCli()
  if (!cli) return { error: '未找到 agently-cli，请重新安装青鸟' }
  const [exe, ...rest] = cli.command
  try {
    const p = spawn(exe, rest.concat(['auth', 'login']), {
      shell: cli.shell === true,
      windowsHide: true,
      env: process.env
    })
    loginProc = p
    pushEvent({ type: 'login_started' })
    let sawUrl = false
    const onData = (raw: unknown) => {
      const text = String(raw)
      const m = text.match(/https?:\/\/\S+/)
      if (m && !sawUrl) {
        sawUrl = true
        const url = m[0].replace(/["'\s]+$/, '')
        pushEvent({ type: 'login_url', url })
        // CLI 在部分环境拉不起浏览器（无默认浏览器关联/无桌面会话），兜底开一次
        void shell.openExternal(url).catch(() => {})
      }
    }
    p.stdout?.on('data', onData)
    p.stderr?.on('data', onData)
    p.on('error', (e) => {
      loginProc = null
      pushEvent({ type: 'login_failed', message: e.message })
    })
    p.on('close', (code) => {
      loginProc = null
      if (code === 0) {
        void mailStatus().then((status) => pushEvent({ type: 'login_done', status }))
      } else {
        pushEvent({ type: 'login_failed', message: `授权未完成（退出码 ${code}）` })
      }
    })
    return {}
  } catch (e) {
    loginProc = null
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** 退出登录（清钥匙串凭据） */
export async function mailLogout(): Promise<MailStatus> {
  try {
    await runCli(['auth', 'logout'])
  } catch {
    /* logout 失败不挡状态刷新 */
  }
  return mailStatus()
}
