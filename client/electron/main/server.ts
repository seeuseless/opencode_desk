import { loadSettings, platformBaseUrl, setPlatform, setRemoteEnabled } from './config.ts'
import { relay } from './relay.ts'

/**
 * 服务端（青鸟平台，Go 单二进制）的可用性探测。
 *
 * 设计：**服务端是独立进程**（用户自己起 / 独立部署），桌面端不负责拉起。
 * 启动时探测 {平台地址}/api/health：
 *   · 通 → 服务端可用，打开「远程服务」开关，帐号功能出现
 *   · 不通 → 保持关闭，帐号入口不出现（配置里的平台地址指向没在跑的服务端时也一样）
 *
 * 服务端被占用端口时会**顺延**（config.PickPort 从 9002 起找可用），而客户端配置的
 * 地址是死的——所以默认/回环地址探测不通时，从 9002 起在本机扫一圈 health 端点，
 * 找到自己的实例就把地址改过去（落盘 + 重写内核配置，登录态不动）。
 * 环境变量 QINGNIAO_PLATFORM_URL 显式指定的、或指向远程域名的，不猜，保持原样。
 *
 * 为什么用 health 而不是「开关状态」判断帐号能不能用：
 * 开关只是用户的意愿，服务端没起来时意愿再强也发不出请求。health 通 = 真的能用。
 *
 * 平台地址可在「设置 → 平台地址」改；改到自建服务端或另一个实例即可切换数据源。
 */

/** 健康检查路径（服务端 internal/api/api.go 的 /api/health） */
const HEALTH_PATH = '/api/health'

/** 显式地址的单次探测超时：本地回环 2 秒宽松，远程域名留够网络余量 */
const PROBE_TIMEOUT_MS = 2000

/** 自动发现时的单口探测超时：本地回环 refused 立即失败，只兜「有服务但不响应」 */
const SCAN_TIMEOUT_MS = 400

/** 自动发现端口范围：新默认段（与 server PickPort 顺延区间对齐）+ 旧版 server 的 9002 段（兼容已部署实例） */
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
      if (await this.probe()) {
        this.enableRemote()
        return
      }
      const env = (process.env.QINGNIAO_PLATFORM_URL || '').trim()
      const base = platformBaseUrl()
      if (!env && isLoopback(base)) {
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
