import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
/** 内核就绪等待：单次探测超时 / 探测间隔 / 总上限（实测冷启动 ~3s，上限留给慢盘与 models.dev 卡网） */
const HEALTH_PROBE_TIMEOUT_MS = 2000
const HEALTH_PROBE_INTERVAL_MS = 250
const HEALTH_TIMEOUT_MS = 30000

class Adapter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private base = ''
  private sseAbort: AbortController | null = null
  private stopping = false
  /**
   * 应用退出标记（区别于 stopping）：stop() 在重启流程里也会被调（stop→start 属正常轮换），
   * 但应用退出后 start() **绝不能**再拉起新内核——否则退出落在「stop 完、start 未跑」的重启
   * 间隙时，stop 杀了个空、start 重置 stopping 又 spawn，产出一个无人管理的孤儿内核，
   * 应用都退了它还在后台跑 AI 任务（旧配置下就是弹 PowerShell 窗口的元凶）。
   */
  private quitting = false
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

  /** 内核 REST 基地址（如 http://127.0.0.1:39421）。桌面移动端服务反代要用；未启动时为空串 */
  get baseUrl(): string {
    return this.base
  }

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
    // 应用已退出（shutdown）：拒绝任何（重）启动，防孤儿内核——见 quitting 注释
    if (this.quitting) return
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

  /**
   * 轮询 /global/health 直到内核就绪。
   *
   * 两次探测都必须带超时/上限，不能只靠循环次数：
   * - fetch 默认**没有超时**（undici 的 headersTimeout 是 5 分钟）。若这个端口被一个「只接受连接、永不回包」
   *   的半死进程占着（上一代内核被 kill 后端口还没释放、或被别的进程抢绑），单次探测就会挂几分钟甚至更久；
   *   restart() 于是永不返回，settings:save 的 IPC 也不 settle——设置页看到的就是「保存并重启内核…」一直转。
   * - 循环次数换算的是 sleep 时间，不含 fetch 自身耗时，所以按墙钟算截止点。
   */
  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    let last = '未响应'
    for (;;) {
      // 内核自己已经退出（如端口冲突时 opencode 直接报 ServeError 退出）：立刻失败，别等满超时
      if (!this.proc) throw new Error('OpenCode 内核启动失败（进程已退出，见主进程日志）')
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS)
        const r = await fetch(this.base + '/global/health', { signal: ctrl.signal })
        clearTimeout(t)
        if (r.ok) return
        last = 'HTTP ' + r.status
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
      }
      if (Date.now() + HEALTH_PROBE_INTERVAL_MS > deadline)
        throw new Error(`OpenCode 内核启动超时（${Math.round(HEALTH_TIMEOUT_MS / 1000)}s 内 ${this.base}/global/health 未就绪：${last}）`)
      await new Promise((r) => setTimeout(r, HEALTH_PROBE_INTERVAL_MS))
    }
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
    if (!p) return
    // Windows 上必须杀整棵树：p.kill() 只终止内核本身，它的 MCP 子进程 / pty shell / 正在执行的
    // bash 会话全部变成孤儿继续存活（pty shell 在 Windows 默认还是 PowerShell——用户退出后
    // 「还会弹 PowerShell」的另一来源）。taskkill /T /F 一次带走上上下下。
    if (process.platform === 'win32' && p.pid) {
      try {
        spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        /* 失败走下面的兜底 */
      }
    }
    try {
      p.kill()
    } catch {
      /* 进程已退出 */
    }
  }

  /** 应用退出专用：置 quitting 后任何人（含进行中的 restart 轮次）都无法再拉起新内核 */
  shutdown(): void {
    this.quitting = true
    this.stop()
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
        try {
          this.stop()
          await new Promise((r) => setTimeout(r, 300))
          await this.start()
        } catch (e) {
          // 这一轮没起来。期间又被请求过重启（盘上设置已变）就再来一轮，
          // 否则直接把错误交给调用方——不能把 restartAgain 挂着不管：等待方会当成「重启成功」返回
          if (!this.restartAgain) throw e
        }
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
      if (method === 'POST' && seg[0] === 'session' && (seg[2] === 'message' || seg[2] === 'prompt_async')) {
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
