import { loadSettings, platformBaseUrl, setRemoteEnabled } from './config.ts'
import { relay } from './relay.ts'

/**
 * 服务端（青鸟平台，Go 单二进制）的可用性探测。
 *
 * 设计：**服务端是独立进程**（用户自己起 / 独立部署），桌面端不负责拉起。
 * 启动时探测 {平台地址}/api/health：
 *   · 通 → 服务端可用，打开「远程服务」开关，帐号功能出现
 *   · 不通 → 保持关闭，帐号入口不出现（配置里的平台地址指向没在跑的服务端时也一样）
 *
 * 为什么用 health 而不是「开关状态」判断帐号能不能用：
 * 开关只是用户的意愿，服务端没起来时意愿再强也发不出请求。health 通 = 真的能用。
 *
 * 平台地址可在「设置 → 平台地址」改；改到自建服务端或另一个实例即可切换数据源。
 */

/** 健康检查路径（服务端 internal/api/api.go 的 /api/health） */
const HEALTH_PATH = '/api/health'

/** 单次探测超时：本地回环，2 秒够宽松 */
const PROBE_TIMEOUT_MS = 2000

class ServerManager {
  private starting = false

  /**
   * 探测服务端是否活着。
   *
   * 通就返回 true。任何异常（连不上、超时、非 200）都算不通。
   */
  async probe(baseUrl?: string): Promise<boolean> {
    const base = (baseUrl ?? platformBaseUrl()).replace(/\/+$/, '')
    try {
      const res = await fetch(base + HEALTH_PATH, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
   * 否则界面先闪一下帐号入口又消失。
   */
  async ensure(): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      if (await this.probe()) {
        this.enableRemote()
      }
    } finally {
      this.starting = false
    }
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
    /* 无操作 */
  }
}

export const server = new ServerManager()