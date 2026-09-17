import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import {
  loadSettings,
  opencodeConfigDir,
  opencodeDataDir,
  opencodeStateDir,
  providerEnv,
  qingniaoHome,
  resolveModel,
  settingsPath,
  writeOpencodeConfig
} from './config.ts'

/** 事件桥遥测：记录 SSE 断连/重连次数，暴露给渲染层排障 */
const TELEMETRY = 'qn-event-telemetry.json'

function telemetryPath(): string {
  return join(qingniaoHome(), TELEMETRY)
}

export interface Telemetry {
  sseReconnects: number
  lastReconnectAt: string
}

export function loadTelemetry(): Telemetry {
  try {
    if (existsSync(telemetryPath())) {
      return JSON.parse(readFileSync(telemetryPath(), 'utf8')) as Telemetry
    }
  } catch {
    /* 损坏文件走默认 */
  }
  return { sseReconnects: 0, lastReconnectAt: '' }
}

export function bumpTelemetryReconnect(): void {
  const t = loadTelemetry()
  t.sseReconnects += 1
  t.lastReconnectAt = new Date().toISOString()
  try {
    writeFileSync(telemetryPath(), JSON.stringify(t, null, 2))
  } catch {
    /* 写失败不阻塞 */
  }
}

/**
 * OpenCode serve 的透传门面：
 * 渲染层走的就是 OpenCode 原生 REST（/session、/session/{id}/message、message.part.delta 事件），
 * 主进程只做四件事——拉起内核、生成配置、SSE 事件桥、模型选择校正。不再有任何协议翻译。
 */

export interface ApiResult {
  status: number
  data: unknown
}

const HOST = '127.0.0.1'
const PORT_START = 39421
const PORT_TRY = 20

class Adapter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private base = ''
  private sseAbort: AbortController | null = null
  private stopping = false
  /** 重启串行化：正在进行 + 待补一次（连续拨开关时合并，绝不并发 kill/spawn） */
  private restarting = false
  private restartAgain = false
  private restartWaiters: Array<() => void> = []
  pushEvent: (e: { type: string; properties: Record<string, unknown> }) => void = () => {}
  /** 事件桥内用：pushEvent 抛错（如窗口已销毁）不能中断 SSE 循环 */
  private safePush(e: { type: string; properties: Record<string, unknown> }): void {
    try {
      this.pushEvent(e)
    } catch {
      /* 窗口已销毁等场景，忽略 */
    }
  }
  bin = ''
  workspace = ''

  /** 内核退出/健康探测失败时回调（index.ts 注入：推送渲染层提示 + 自动重启） */
  onUnhealthy: (() => void) | null = null

  /** 主动探活（渲染层可轮询）：进程在 + /global/health 通，才算健康 */
  async isHealthy(): Promise<boolean> {
    if (!this.proc) return false
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 3000)
      const r = await fetch(this.base + '/global/health', { signal: ctrl.signal })
      clearTimeout(t)
      return r.ok
    } catch {
      return false
    }
  }

  // ---------- 生命周期 ----------

  async start(): Promise<void> {
    this.stopping = false
    mkdirSync(qingniaoHome(), { recursive: true })
    mkdirSync(opencodeDataDir(), { recursive: true })
    mkdirSync(opencodeStateDir(), { recursive: true })
    mkdirSync(opencodeConfigDir(), { recursive: true })
    const s = loadSettings()
    writeOpencodeConfig(s)
    const port = await findFreePort()
    this.base = `http://${HOST}:${port}`
    // 内核配置/数据全部隔离进 ~/.qingniaoai（opencode 在 XDG 目录下再套一层 opencode/）
    const child = spawn(this.bin, ['serve', '--port', String(port), '--hostname', HOST], {
      cwd: this.workspace,
      windowsHide: true,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: qingniaoHome(),
        XDG_DATA_HOME: opencodeDataDir(),
        XDG_STATE_HOME: opencodeStateDir(),
        ...providerEnv(s)
      }
    })
    this.proc = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) console.log('[opencode]', line.trim())
    })
    child.on('exit', (code) => {
      // 重启时旧进程的退出事件可能晚于新一轮 start 到达：若 this.proc 已被替换成新内核，
      // 说明这是上一代的退出，直接忽略——否则会清掉新进程引用并误触发自动重启（重启死循环）
      if (this.proc !== child) return
      this.proc = null
      if (!this.stopping) {
        console.error('[opencode] 内核意外退出 code=' + String(code))
        this.onUnhealthy?.()
      }
    })
    await this.waitHealthy()
    this.openEventBridge()
    // 内核（重）启动成功：渲染层据此清理重启前的残留 busy/running 状态（任务为内存态，重启即失效）
    this.safePush({ type: 'qingniao.kernel.started', properties: {} })
  }

  /** 轮询 /global/health 直到内核就绪（冷启动偶尔较慢，给 ~10s） */
  private async waitHealthy(): Promise<void> {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(this.base + '/global/health')
        if (r.ok) return
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('OpenCode 内核启动超时（/global/health 无响应）')
  }

  /** SSE 事件桥：内核 /event 全量转发渲染层；断线自动重连 */
  private openEventBridge(): void {
    this.sseAbort = new AbortController()
    const signal = this.sseAbort.signal
    ;(async () => {
      let backoff = 1000
      while (!this.stopping && !signal.aborted) {
        try {
          const res = await fetch(this.base + '/event', { signal, headers: { accept: 'text/event-stream' } })
          if (!res.ok || !res.body) throw new Error('SSE HTTP ' + res.status)
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line.startsWith('data:')) continue
              try {
                const evt = JSON.parse(line.slice(5).trim()) as { type?: string; properties?: Record<string, unknown> }
                if (evt && typeof evt.type === 'string') {
                  this.safePush({ type: evt.type, properties: evt.properties ?? {} })
                }
              } catch {
                /* keepalive / 注释行 */
              }
            }
          }
          backoff = 1000
        } catch {
          // stop() 主动 abort / 正在重启（stopping）属预期内的连接关闭，不算异常：
          // 必须在这里直接返回，绝不能触发 onUnhealthy——否则每次重启都会自我触发下一轮重启，
          // adapter.restart() 的 do…while 永远退不出，调用方 await 永久挂起（表现为「界面不动」）
          if (this.stopping || signal.aborted) return
          /* 连接断开走重连 */
          // 记录断连遥测 + 通知渲染层做一次轻量重同步，兜住 busy 残留等状态
          bumpTelemetryReconnect()
          this.safePush({ type: 'qingniao.sse.reconnected', properties: {} })
          // 若内核确实已死（非瞬时断连），健康探测会返回 false，触发自动重启
          if (!(await this.isHealthy())) this.onUnhealthy?.()
        }
        if (this.stopping || signal.aborted) return
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 8000)
      }
    })()
  }

  stop(): void {
    this.stopping = true
    this.sseAbort?.abort()
    this.sseAbort = null
    const p = this.proc
    this.proc = null
    p?.kill()
  }

  /** 设置变更后重启（provider/MCP 写盘 + env 重启生效）。
   *  串行 + 合并：重启进行中再被调用只记一次待补——连续拨开关不会并发 spawn 多个内核，
   *  最后一轮重启从盘上读到的就是最新设置，等待方也在最终重启完成后才返回。 */
  async restart(): Promise<void> {
    if (this.restarting) {
      this.restartAgain = true
      await new Promise<void>((r) => this.restartWaiters.push(r))
      return
    }
    this.restarting = true
    try {
      do {
        this.restartAgain = false
        this.stop()
        await new Promise((r) => setTimeout(r, 300))
        await this.start()
      } while (this.restartAgain)
    } finally {
      this.restarting = false
      const waiters = this.restartWaiters
      this.restartWaiters = []
      waiters.forEach((r) => r())
    }
  }

  // ---------- REST 透传 ----------

  async api(path: string, method = 'GET', body?: Record<string, unknown>): Promise<ApiResult> {
    if (!this.proc) return { status: 503, data: '内核未启动' }
    try {
      let payload = body
      // 模型校正：渲染层 localStorage 存档可能是过期值（provider 改名/停用/删除），
      // 命中不了 config 里的提供商就回落默认档，避免内核报 provider not found
      const seg = path.split('?')[0].split('/').filter(Boolean)
      if (method === 'POST' && seg[0] === 'session' && seg[2] === 'message') {
        payload = { ...body, model: resolveModel(loadSettings(), body?.model as never) }
      }
      const res = await fetch(this.base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload)
      })
      let data: unknown = null
      const text = await res.text()
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = text
      }
      if (!res.ok) {
        // 统一成字符串错误，渲染层 oc.call 直接 throw 显示
        const em = (data as { error?: { name?: string; message?: string } })?.error?.message
        data = typeof data === 'string' ? data : (em ?? `${method} ${path} -> HTTP ${res.status}`)
      }
      return { status: res.status, data }
    } catch (e) {
      const detail = String(e instanceof Error ? e.message : e)
      // 连接层故障（fetch failed / ECONNREFUSED）：内核进程可能已退出或端口已释放，
      // 提示更友好的恢复话术，避免渲染层直接 dump "fetch failed"
      if (/fetch failed|ECONNREFUSED|socket hang up|ECONNRESET/i.test(detail)) {
        return { status: 502, data: '内核连接中断（进程可能已退出），请重试；若持续出现请重启应用' }
      }
      return { status: 502, data: '内核通信失败：' + detail }
    }
  }
}

/** 从固定起点扫一个可绑定的本地端口 */
async function findFreePort(): Promise<number> {
  for (let port = PORT_START; port < PORT_START + PORT_TRY; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, HOST, () => {
        srv.close(() => resolve(true))
      })
    })
    if (free) return port
  }
  throw new Error('找不到可用的本地端口')
}

export const adapter = new Adapter()

/** 设置文件路径（主进程日志/诊断用） */
export { settingsPath }
