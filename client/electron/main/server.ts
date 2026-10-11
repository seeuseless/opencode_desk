import { loadSettings, platformBaseUrl, setPlatform, setRemoteEnabled } from './config.ts'
import { relay } from './relay.ts'

/**
 * 服务端（青鸟平台，server_cloudflare 的 Workers 云端 / 本地 Node 部署）的可用性探测。
 *
 * 设计：**服务端是独立进程**（用户自己起 / 独立部署），桌面端不负责拉起。
 * 启动时探测 {平台地址}/api/health：
 *   · 通 → 服务端可用，打开「远程服务」开关，帐号功能出现
 *   · 不通 → 保持关闭，帐号入口不出现（配置里的平台地址指向没在跑的服务端时也一样）
 *
 * 服务端被占用端口时会**顺延**，而客户端配置的地址是死的——所以地址为空（纯本地模式）或
 * 指向回环时探测不通，就从 35000 起在本机扫一圈 health 端点，找到自己的实例就把地址改过去
 * （落盘 + 重写内核配置，登录态不动）。
 * 环境变量 QINGNIAO_PLATFORM_URL 显式指定的、或指向远程域名的，不猜，保持原样。
 *
 * 为什么用 health 而不是「开关状态」判断帐号能不能用：
 * 开关只是用户的意愿，服务端没起来时意愿再强也发不出请求。health 通 = 真的能用。
 *
 * 平台地址可在「设置 → 平台地址」改；改到自建服务端或另一个实例即可切换数据源。
 */

/** 健康检查路径（服务端 src/app.ts 的 /api/health） */
const HEALTH_PATH = '/api/health'

/** 显式地址的单次探测超时：本地回环 2 秒宽松，远程域名留够网络余量 */
const PROBE_TIMEOUT_MS = 2000

/** 自动发现时的单口探测超时：本地回环 refused 立即失败，只兜「有服务但不响应」 */
const SCAN_TIMEOUT_MS = 400

/** 自动发现端口范围：新默认段（本地服务端 PORT 顺延区间对齐）+ 旧版 Go 服务的 9002 段（兼容已部署实例） */
const SCAN_RANGES: [number, number][] = [
  [35000, 35099],
  [9002, 9101]
]

/** 服务端可能比桌面端后起：失败后隔这么久重试一轮（通了就不再进这里） */
const RETRY_MS = 60000

function isLoopback(base: string): boolean {
  try {
    const h = new URL(base).hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '::1'
  } catch {
    return false
  }
}

class ServerManager {
  private starting = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 探测服务端是否活着。
   *
   * 通就返回 true。任何异常（连不上、超时、非 200）都算不通。
   */
  async probe(baseUrl?: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    const base = (baseUrl ?? platformBaseUrl()).replace(/\/+$/, '')
    if (!base) return false // 默认地址为空 = 纯本地模式，等 ensure 走自动发现
    try {
      const res = await fetch(base + HEALTH_PATH, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' }
      })
      if (!res.ok) return false
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null
      return data?.ok === true
    } catch {
      return false
    }
  }

  /**
   * 启动时调用：探测服务端可用性，并据此决定帐号功能开不开。
   *
   * 服务端是独立进程，这里只探不拉；探测通过才打开「远程服务」开关——
   * 否则界面先闪一下帐号入口又消失。**必须在写内核配置之前跑**：
   * 发现出的新端口要落盘进 platform.baseUrl，内核里的平台网关地址才会跟着对。
   */
  async ensure(): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      const env = (process.env.QINGNIAO_PLATFORM_URL || '').trim()
      const base = platformBaseUrl()
      if (base && (await this.probe(base))) {
        this.enableRemote()
        return
      }
      // 没配地址（空 = 纯本地模式）或配的是回环地址时，扫本机实际端口（服务端顺延也能找到）
      if (!env && (!base || isLoopback(base))) {
        const found = await this.discover()
        if (found) {
          // 同一台机器上 server 顺延了端口：地址改过去（setPlatform 会落盘并重写内核配置），
          // token 不动——服务没换，只是端口变了
          setPlatform({ baseUrl: found })
          if (await this.probe(found)) {
            this.enableRemote()
            return
          }
        }
      }
      this.scheduleRetry()
    } finally {
      this.starting = false
    }
  }

  /** 从本机 health 端点扫 server 实际端口（35000 段优先，兼容旧 9002 段），找到返回基地址；
   *  总时限兜住「每口都挂着一个慢服务」的极端情形 */
  private async discover(): Promise<string | null> {
    const deadline = Date.now() + 2500
    for (const [from, to] of SCAN_RANGES) {
      for (let port = from; port <= to; port++) {
        if (Date.now() > deadline) return null
        const base = `http://127.0.0.1:${port}`
        if (await this.probe(base, SCAN_TIMEOUT_MS)) return base
      }
    }
    return null
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.ensure()
    }, RETRY_MS)
    this.retryTimer.unref?.()
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /**
   * 换平台地址后立即重接（「设置 → 关于 → 远程 URL」保存时调，不用重启应用）：
   * 探测新地址 → 通则打开「远程服务」开关（与启动时 ensure 同口径）、不通则关掉——
   * 登录态已由 platform.setBaseUrl 清掉，新平台不通时远程功能不可能可用；
   * 不通时继续挂 60s 重试（服务端后起也能接上）。调用方负责广播状态刷新。
   */
  async reattach(): Promise<void> {
    this.clearRetry()
    if (await this.probe()) {
      this.enableRemote()
      return
    }
    if (loadSettings().remote) setRemoteEnabled(false)
    relay.apply()
    this.scheduleRetry()
  }

  /** 打开「远程服务」开关并刷新中转通道（登录态没变时 apply 是幂等的） */
  private enableRemote(): void {
    const s = loadSettings()
    if (!s.remote) {
      setRemoteEnabled(true)
      relay.apply()
    }
  }

  /** 保留接口：服务端是独立进程，桌面端退出不收尸（避免误杀用户自己起的实例） */
  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
  }
}

export const server = new ServerManager()
