import { BrowserWindow, shell } from 'electron'
import { hostname } from 'node:os'
import { adapter } from './adapter.ts'
import { clearPlatform, loadSettings, platformBaseUrl, platformLoginUrl, setPlatform } from './config.ts'
import { relay } from './relay.ts'
import type { ModelCfg, Modality, PlatformAccount, PlatformStatus, UsageLog, UsagePage, UsageRecord, UsageSummary } from './types.ts'
import { MODEL_DEFAULTS, VISION_MODEL_RE, isBuiltinModel } from './types.ts'

/**
 * 平台（青鸟服务端）客户端。
 *
 * 登录链路：
 *   1. 桌面端点「登录」→ 系统浏览器打开 {平台}/ide/login
 *   2. 网页登录（平台账号，含二步验证）→ 平台发一次性授权码 → 跳 qingniao://auth?code=xxx
 *   3. 系统把 qingniao:// 交给本进程（第二个实例或 open-url）→ 用授权码换长期 token
 *   4. token 落 settings.json，同时把平台注册成一个 provider（第三方 provider 保持不变）
 *
 * 站点地址统一由 config.platformBaseUrl() 决定（环境变量 > 设置 > 默认值），本模块不自己拼地址。
 */

/** 自定义协议：网页登录成功后用它把授权码交回本机青鸟 */
export const AUTH_PROTOCOL = 'qingniao'

interface TokenResponse {
  token?: string
  user?: { id: number; name: string; email?: string } | null
  message?: string
}

interface ModelsResponse {
  data?: {
    id?: string
    name?: string
    /** 平台官方提供（后台模型列表那一列「内置」）；false = 第三方接入的同名模型 */
    builtin?: boolean
    /** 平台扩展字段：限免 / 折扣 / 倍率。限免（free）只用于识别并剔除，不展示，见 types.ts 的 dropFreeModels */
    free?: boolean
    discount?: number | null
    ratio?: number
    effective_ratio?: number
  }[]
}

class Platform {
  /** 最近一次失败原因（渲染层浮层展示；成功即清空） */
  private lastError = ''

  status(): PlatformStatus {
    const s = loadSettings()
    return {
      baseUrl: platformBaseUrl(s),
      loginUrl: platformLoginUrl(s),
      loggedIn: !!s.platform.token,
      user: s.platform.user,
      models: s.platform.models.length,
      syncedAt: s.platform.syncedAt,
      error: this.lastError || undefined
    }
  }

  /** 打开平台的青鸟登录页（走系统默认浏览器：自定义协议回调在那边最可靠） */
  async openLogin(): Promise<PlatformStatus> {
    if (!loadSettings().remote) {
      this.lastError = '远程服务已关闭：请到「设置 → 远程服务」打开'

      return this.status()
    }
    await shell.openExternal(platformLoginUrl())
    return this.status()
  }

  /** 改平台地址（上线换域名就改这里）；地址变了旧 token 作废，需要重新登录 */
  setBaseUrl(url: string): PlatformStatus {
    const clean = String(url ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(clean)) {
      this.lastError = '平台地址需以 http:// 或 https:// 开头'

      return this.status()
    }
    const before = loadSettings().platform.baseUrl
    setPlatform({ baseUrl: clean })
    if (before !== clean && loadSettings().platform.token) {
      // 换平台了，旧 token 在新平台不认，清掉免得报一堆 401
      clearPlatform()
      this.lastError = '平台地址已切换，请重新登录'
    } else {
      this.lastError = ''
    }

    return this.status()
  }

  /**
   * 用一次性授权码换长期 token（登录链路第 3~4 步）。
   * 授权码一次性、10 分钟有效，重放会被平台拒绝。
   */
  async acceptCode(code: string): Promise<PlatformStatus> {
    const clean = String(code ?? '').trim()
    if (!loadSettings().remote) {
      this.lastError = '远程服务已关闭'

      return this.status()
    }
    if (!clean) {
      this.lastError = '授权码为空'

      return this.status()
    }

    const base = platformBaseUrl()
    try {
      const res = await fetch(base + '/api/ide/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code: clean, device: deviceLabel() })
      })
      const data = (await res.json().catch(() => null)) as TokenResponse | null
      if (!res.ok || !data?.token) throw new Error(data?.message || `HTTP ${res.status}`)

      setPlatform({ baseUrl: base, token: data.token, user: data.user ?? null, models: [], syncedAt: undefined, device: null })
      await this.sync()
      // provider 变了：重启内核让模型选择里出现平台模型
      await adapter.restart()
      // 登录身份变了：中转通道要么该注册设备、要么该换账号，交给它自己判断
      relay.apply()
      this.lastError = ''
      console.log('[platform] 已登录：' + (data.user?.name ?? ''))
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      console.log('[platform] 登录失败：' + this.lastError)
    }

    return this.status()
  }

  /** 拉平台模型清单并落盘（登录后、手动同步、启动刷新都走这里） */
  async sync(): Promise<PlatformStatus> {
    const s = loadSettings()
    if (!s.remote) {
      this.lastError = ''

      return this.status()
    }
    if (!s.platform.token) {
      this.lastError = '尚未登录'

      return this.status()
    }

    try {
      const res = await fetch(platformBaseUrl(s) + '/api/ide/v1/models', {
        headers: { Authorization: 'Bearer ' + s.platform.token, Accept: 'application/json' }
      })
      if (res.status === 401) {
        this.lastError = '授权已失效，请重新登录'

        return this.status()
      }
      const data = (await res.json().catch(() => null)) as ModelsResponse | null
      const models: ModelCfg[] = (Array.isArray(data?.data) ? data!.data! : [])
        .filter((m) => !!m && typeof m.id === 'string' && m.id !== '')
        .map((m) => {
          const id = String(m.id)
          const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : undefined
          /**
           * 输入模态：只按名字给一个保守的初始值，**不再无脑全勾**。
           *
           * 原来写死 [...MODALITIES]（文本+图片+视频全勾），后果是：所有内置模型在配置里
           * 都"支持读图"，用户界面看到的勾选是假的，而挑代看目标时又只能反过来靠名字猜——
           * 两边口径不一致。现在改成：名字像视觉模型 → 勾「图片」并同时勾「视觉」
           * （能读图通常也能代看，给它一个合理起点）；其余只勾「文本」。
           * 平台不下发模态，所以这只是起点，用户可以在设置里逐模型改，改了就以勾选为准。
           */
          const looksVision = VISION_MODEL_RE.test(id + ' ' + (name ?? ''))
          return {
            id,
            name,
            context: MODEL_DEFAULTS.context,
            output: MODEL_DEFAULTS.output,
            input: looksVision ? (['text', 'image', 'vision'] as Modality[]) : (['text'] as Modality[]),
            // 计价信息一起落盘：限免那批由 dropFreeModels 剔除，折扣/倍率则要打标签并写在最右边，不必再单独请求一次
            free: m.free === true,
            discount: typeof m.discount === 'number' ? m.discount : null,
            ratio: typeof m.ratio === 'number' ? m.ratio : undefined,
            effRatio: typeof m.effective_ratio === 'number' ? m.effective_ratio : undefined,
            // 内置标记一并落盘：「内置模型」分组只收它。老平台不下发该字段时按「内置」算，别把模型全藏了
            builtin: isBuiltinModel({ builtin: m.builtin })
          }
        })

      setPlatform({ models, syncedAt: Date.now() })
      this.lastError = ''
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      console.log('[platform] 同步模型失败：' + this.lastError)
    }

    return this.status()
  }

  /**
   * 静默刷新模型清单并广播给窗口（启动时、用户点开选择器里的「内置模型」时都走它）。
   *
   * 计价信息（限免 / 折扣 / 倍率）是登录那一刻落盘的快照，平台随时可能改活动，
   * 所以每次都要对一遍——不然用户看到的是旧价格。
   * 只有「模型清单本身变了」（增删改名）才重启内核；纯计价变化内核不关心，不折腾它。
   * 拉起这个过程是「静默」的：不等它、不清列表，界面照旧显示旧值，拉回来自动替换。
   */
  async refresh(): Promise<PlatformStatus> {
    // 关了远程服务就一个请求都不发：离线/内网部署时这台机器不该往外连
    if (!loadSettings().remote) return this.status()
    if (!loadSettings().platform.token) return this.status()
    const before = loadSettings().platform.models.map((m) => m.id).join(',')
    await this.sync()
    const after = loadSettings().platform.models.map((m) => m.id).join(',')
    if (before !== after) await adapter.restart()
    // 界面上的「内置模型」分组要重画（新价格、新标签），统一广播一次
    const st = this.status()
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('platform:changed', st)
    }

    return st
  }

  /** 启动时的静默刷新：与按需刷新同一套逻辑，单独留个名字让调用点读起来有语义 */
  async refreshOnBoot(): Promise<void> {
    await this.refresh()
  }

  /** 退出登录：通知平台吊销 token，本地清干净并重启内核（平台模型随之消失） */
  async logout(): Promise<PlatformStatus> {
    const s = loadSettings()
    if (s.platform.token) {
      try {
        await fetch(platformBaseUrl(s) + '/api/ide/logout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + s.platform.token, Accept: 'application/json' }
        })
      } catch {
        /* 平台连不上也要能本地退出 */
      }
    }
    clearPlatform()
    await adapter.restart()
    // 设备身份是绑在账号上的，退出即作废：把中转通道一并停掉
    relay.apply()
    this.lastError = ''

    return this.status()
  }

  /** 处理 qingniao://auth?code=xxx 回调，并把结果广播给窗口 */
  async handleCallback(url: string): Promise<void> {
    const code = extractCode(url)
    if (!code) return
    const st = await this.acceptCode(code)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('platform:changed', st)
    }
  }

  /* ---------------- 会员自己的数据（设置 → 账号 / 使用量） ---------------- */

  /**
   * 用量汇总：总量 / 今日 / 昨日 + 区间内的按天与按模型明细。
   * from、to 为 YYYY-MM-DD；都不传时平台按最近 30 天算。
   */
  usageSummary(from?: string, to?: string): Promise<UsageSummary | null> {
    const q = new URLSearchParams()
    if (from) q.set('from', from)
    if (to) q.set('to', to)
    const qs = q.toString()

    return this.get<UsageSummary>('/api/ide/usage/summary' + (qs ? `?${qs}` : ''))
  }

  /**
   * 积分流水（发放 / 消耗 / 调整），一页 20 条。
   * 平台连不上或未登录返回一个空页，界面按「还没有记录」渲染，不必区分。
   */
  usageLogs(type?: 'consume' | 'grant' | 'adjust', page = 1): Promise<UsagePage<UsageLog>> {
    const q = new URLSearchParams({ page: String(page) })
    if (type) q.set('type', type)

    return this.get<UsagePage<UsageLog>>('/api/ide/usage/logs?' + q.toString()).then(emptyPage)
  }

  /** 每次消耗明细（一次调用一行），一页 20 条 */
  usageRecords(page = 1): Promise<UsagePage<UsageRecord>> {
    return this.get<UsagePage<UsageRecord>>(`/api/ide/usage/records?page=${page}`).then(emptyPage)
  }

  /** 账号信息：登录用户、当前授权、积分余额、本机设备名 */
  account(): Promise<PlatformAccount | null> {
    return this.get<PlatformAccount>('/api/ide/me')
  }

  /**
   * 带 token 的 GET。未登录返回 null（调用方按「未登录」渲染，不当成错误弹提示）；
   * 出错时把原因记进 lastError，跟登录链路共用同一个错误出口。
   */
  private async get<T>(path: string): Promise<T | null> {
    const s = loadSettings()
    if (!s.remote || !s.platform.token) {
      return null
    }

    try {
      const res = await fetch(platformBaseUrl(s) + path, {
        headers: { Authorization: 'Bearer ' + s.platform.token, Accept: 'application/json' }
      })
      if (!res.ok) throw new Error(res.status === 401 ? '授权已失效，请重新登录' : `HTTP ${res.status}`)

      return (await res.json()) as T
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)

      return null
    }
  }
}

/** 从回调地址里取出授权码（兼容 query 与 hash 两种写法） */
export function extractCode(url: string): string {
  try {
    const u = new URL(url)
    return u.searchParams.get('code') || new URLSearchParams(u.hash.replace(/^#/, '')).get('code') || ''
  } catch {
    return ''
  }
}

/** 设备名：平台后台「已连接客户端」里靠它区分机器 */
function deviceLabel(): string {
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'

  return `青鸟 · ${os} · ${hostname()}`.slice(0, 80)
}

/** 取不到数据（未登录 / 平台不可达）时的空页：界面统一按「空列表」渲染 */
function emptyPage<T>(d: UsagePage<T> | null): UsagePage<T> {
  return d && Array.isArray(d.items) ? d : { items: [], total: 0, page: 1, per_page: 20, pages: 0 }
}

export const platform = new Platform()
