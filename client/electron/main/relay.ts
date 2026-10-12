import { hostname } from 'node:os'
import qrcode from 'qrcode-generator'
import { adapter } from './adapter.ts'
import { loadSettings, platformBaseUrl, setPlatform, type Settings } from './config.ts'
import { isBuiltinModel, type DeskStatus, type DeviceCfg } from './types.ts'

/**
 * 移动端中转通道（青鸟 → 平台 → 手机）。
 *
 * 手机不直连电脑：扫码打开的是平台上的页面，页面把指令发给平台，本模块每 1.2 秒
 * 去平台认领一次指令，在本机内核上执行完再把结果交回去；同时把内核事件批量推给平台，
 * 手机因此能看到 AI 正在一个字一个字往外吐。
 *
 * 这么做的好处是手机在 4G 下也能操作这台电脑，不要求同一个 Wi-Fi；
 * 代价是每条指令都要绕一圈，所以只做「看项目/看任务/收发消息/停止」这几件必要的事。
 *
 * 执行内核操作直接用 adapter.api（与渲染层同一个透传门面），不做第二套协议。
 */

/** 认领指令的间隔：够快（手感上像实时），又不至于把平台的 PHP 打爆 */
const POLL_MS = 1200

/** 一段时间内没有指令就顺手把攒下的事件推上去 */
const EVENT_FLUSH_MS = 400

/** 同一会话两次「内容变了」之间的最小间隔：合并工具每一步的抖动，又不至于让手机明显滞后 */
const CHANGE_DEBOUNCE_MS = 350

/** 一次最多带回多少条事件（平台上限 200） */
const EVENT_BATCH = 60

interface Rpc {
  id: number
  method: string
  params: Record<string, unknown>
}

class Relay {
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private lastError = ''
  /** 待上报的内核事件，攒够一批或到点就发 */
  private queue: { type: string; payload: Record<string, unknown> }[] = []
  /** 各会话是否在处理中：来自内核事件，手机每次拉任务列表时由它回答 busy */
  private busy: Record<string, boolean> = {}
  /** 会话内容变更的最近推送时间：同一会话内合并，别让每个 token 都发一次 */
  private changedAt: Record<string, number> = {}
  /**
   * partID → part 类型（'text' / 'reasoning' / 'tool'…）。
   *
   * 存在的唯一理由：内核的 message.part.delta 里，**思考的增量 field 也是 'text'**，
   * 光看 field 分不出正文与思维链。权威类型在 part.updated 快照里，这里记一份，
   * 让转发正文增量时能按 partID 精确判断。只留当前会话量级的条目，定期清。
   */
  private partType: Record<string, string> = {}
  /** 有没有手机正连着（平台每轮认领时顺手带回；只认手机自己的活动，不认开关） */
  private mobileOnline = false
  /** 渲染层推过来的项目清单（主进程读不到 localStorage） */
  private projects: { id: string; path: string; name: string }[] = []
  /** 上一版项目清单的指纹，用来判断「清单变了没有」 */
  private projectsSig = ''

  /**
   * 状态变化回调：主进程用它把新状态推给渲染层。
   * 设备注册要问平台要 token（异步），完成后二维码才会出现——不推的话界面停在「生成中」。
   */
  onChange: (() => void) | null = null

  /**
   * Busy 状态上送回调：桌面子进程改「手机发来的回合」——手机一发消息，内核还没出 delta 时
   * 桌面就该亮「处理中」。主进程接它把 {type:'session.busy'} 塞进 opencode:event 桥喂给渲染层。
   */
  onBusy: ((sid: string, on: boolean) => void) | null = null

  status(s: Settings = loadSettings()): DeskStatus {
    const device = s.platform.device
    const url = device?.url ?? ''
    return {
      // 关了远程服务就整个不作数：二维码留着也连不上，界面据此整块隐藏
      enabled: s.remote && s.mobile,
      loggedIn: !!s.platform.token,
      user: s.platform.user?.name,
      device: device?.name,
      url,
      qr: url ? qrMatrix(url) : null,
      running: this.running,
      mobileConnected: this.running && this.mobileOnline,
      error: this.lastError || undefined
    }
  }

  /**
   * 登录态/开关变化后调用：该跑就跑，不该跑就停。
   *
   * 关键：**设备注册只看登录态，不看开关**。二维码是「这台电脑在平台上的入口」，
   * 登录了就一定有；开关管的是准入（放不放手机进来认领指令）。
   * 早先写成「开关 + 登录」两条件才注册，结果登录后开关没开就永远拿不到二维码，
   * 面板一直显示「二维码生成中…」。
   *
   * 另一个前提是全局的「远程服务」开着——关掉它连设备都不注册，一个请求都不发。
   */
  apply(): void {
    const s = loadSettings()
    if (!s.remote || !s.platform.token) {
      this.lastError = ''
      this.stop()
      this.notify()

      return
    }
    void this.ensureDevice().then(() => {
      // 设备有了才可能跑通道（认领指令要用 device_id + secret）
      if (loadSettings().mobile && loadSettings().platform.device) this.start()
      else this.stop()
      this.notify()
    })
  }

  /** 桌面端每轮结束推一次项目清单，手机端 projects.list 直接读它 */
  setProjects(list: { id: string; path: string; name: string }[]): void {
    const next = Array.isArray(list) ? list : []
    // 项目增删改也要让手机知道：原先只在手机上手动点刷新才看得到，
    // 现在清单一变就立刻推一条，手机侧自己去重拉 projects.list。
    const sig = projectsSig(next)
    if (sig !== this.projectsSig) {
      this.projectsSig = sig
      if (this.running) this.push({ type: 'projects.changed', payload: {} })
    }
    this.projects = next
  }

  /**
   * 换一张二维码：让平台把这台设备的 token 换掉，旧二维码立即作废。
   * secret 不变，所以通道不用重启。
   */
  async rotate(): Promise<DeskStatus> {
    if (!loadSettings().platform.token) {
      this.lastError = '请先登录平台账号'
      this.notify()

      return this.status()
    }
    // 还没注册过设备时，「换码」等价于「注册一张」——不能直接报错
    await this.ensureDevice()
    const device = loadSettings().platform.device
    if (!device) {
      this.notify()

      return this.status()
    }
    try {
      const data = await this.call<{ id: number; name: string; token: string; secret: string; path: string }>(
        '/api/ide/desk/register',
        { name: device.name, platform: platformLabel(), rotate: true },
        'POST'
      )
      setPlatform({ device: this.compose(data) })
      this.lastError = ''
    } catch (e) {
      this.lastError = errText(e)
    }
    this.notify()

    return this.status()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastError = ''
    this.loop()
    this.scheduleFlush()
  }

  stop(): void {
    this.running = false
    // 通道停了手机就进不来，连接状态跟着熄掉（否则绿点会一直挂在上面）
    this.mobileOnline = false
    if (this.timer) clearTimeout(this.timer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.timer = null
    this.flushTimer = null
  }

  /** 内核事件进来：只留手机用得上的那几类，其他一律丢掉（别把整个会话往上搬） */
  onKernelEvent(e: { type: string; properties: Record<string, unknown> }): void {
    if (!this.running) return
    const p = e.properties as { sessionID?: string }
    const sid = p?.sessionID

    if (e.type === 'message.part.delta') {
      if (sid) this.markBusy(sid, true)
      const pr = e.properties as { sessionID?: string; field?: string; delta?: string; partID?: string }
      // **不能只看 field**：内核的 reasoning（思考）增量 field 同样是 'text'，
      // 光看 field 会把整段思维链当成正文推到手机上，答案框里先冒出一大段 thinking。
      // 权威类型在 message.part.updated 快照的 part.type 里（下面登记），
      // 这里按 partID 查一次：登记过且不是 text 的增量直接丢。
      // 快照还没到（查不到）时保守丢弃——宁可少几个字，也不能把思考当正文，
      // 真丢了正文随后会被 session.changed 的完整历史补回来。
      if (pr.partID && this.partType[pr.partID] && this.partType[pr.partID] !== 'text') return
      if (pr.field !== 'text' || !pr.delta) return
      this.push({ type: 'message.delta', payload: { sessionID: pr.sessionID, text: pr.delta } })

      return
    }
    if (e.type === 'session.idle' || e.type === 'session.error') {
      if (sid) {
        this.markBusy(sid, false)
        // 补一条「内容变了」：纯工具轮次可能一条文本增量都没有，busy 从没亮过，
        // 只靠 session.busy 手机不会去对账，界面就停在旧内容上
        this.pushChange(sid)
      }
      return
    }
    if (e.type === 'message.updated' || e.type === 'message.part.updated') {
      // 登记 part 类型：message.part.delta 靠它分辨「正文」与「思考」
      this.rememberPartTypes(e.properties)
      // 会话内容变了（电脑上自己发的消息、AI 回复、工具输出）：通知手机拉一次完整历史。
      // 不能只依赖 message.delta —— 那个是「追进度」用的，丢了就永远补不回来。
      if (sid) this.pushChange(sid)
      return
    }
    if (e.type === 'session.updated' || e.type === 'session.created' || e.type === 'session.deleted') {
      // 带directory：手机上据此只重拉受影响的那个项目，不必把整个项目清单都重扫一遍。
      // 内核这几个事件的载荷形状不完全一致（有的塞在 info 里，有的直接平铺），
      // 两种都试一下，取不到就留空——手机那边会退回到「重拉所有已展开项目」。
      const info = (e.properties as { info?: { directory?: string } }).info ?? {}
      const dir = info.directory ?? (e.properties as { directory?: string }).directory ?? ''
      this.pushUrgent({ type: 'sessions.changed', payload: { sessionID: sid ?? '', directory: dir } })
    }
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 从 message.updated / message.part.updated 的快照里记下每个 part 的类型。
   *
   * 两种载荷形状都认：整条消息（parts 数组）与单个 part（part 对象）。
   * 顺带做容量兜底——这张表只增不减，长会话跑久了会一直涨，超过阈值就整表清掉：
   * 丢了顶多多转发几段思考（随后被完整历史覆盖），不能让它把内存吃光。
   */
  private rememberPartTypes(properties: Record<string, unknown>): void {
    const take = (pt: unknown) => {
      const o = pt as { id?: string; type?: string }
      if (o && typeof o.id === 'string' && typeof o.type === 'string') this.partType[o.id] = o.type
    }
    const arr = (properties as { parts?: unknown[] }).parts
    if (Array.isArray(arr)) for (const pt of arr) take(pt)
    take((properties as { part?: unknown }).part)
    if (Object.keys(this.partType).length > 4000) this.partType = {}
  }

  /** 设备身份：没有就注册一台（同一账号同名设备会被平台复用，重装不换码） */
  private async ensureDevice(): Promise<void> {
    const s = loadSettings()
    if (!s.platform.token) return
    if (s.platform.device) return
    try {
      const data = await this.call<{ id: number; name: string; token: string; secret: string; path: string }>(
        '/api/ide/desk/register',
        { name: deviceName(), platform: platformLabel() },
        'POST'
      )
      setPlatform({ device: this.compose(data) })
      this.lastError = ''
    } catch (e) {
      this.lastError = errText(e)
    }
  }

  /** 状态变了就告诉主进程（由它推给窗口） */
  private notify(): void {
    this.onChange?.()
  }

  /** 二维码地址用「本机配置的平台地址」拼：那是已经验证过能连通的地址 */
  private compose(data: { id: number; name: string; token: string; secret: string; path: string }): DeviceCfg {
    return {
      id: data.id,
      name: data.name,
      token: data.token,
      secret: data.secret,
      url: platformBaseUrl() + (data.path || '/ide/device/' + data.token)
    }
  }

  private markBusy(sid: string, on: boolean, external = false): void {
    if (this.busy[sid] === on) return
    if (on) this.busy[sid] = true
    else delete this.busy[sid]
    // 手机按钮状态跟着它走：电脑上点了停止，手机上也会亮回「发送」
    this.push({ type: 'session.busy', payload: { sessionID: sid, busy: on } })
    // 只把「外部（手机）发起」的 busy 变化注入桌面渲染层——手机发消息的瞬间就亮「处理中」。
    // 桌面自己发起的回合它已通过内核 delta/session.idle 知道，再注入会把本端会话误标成
    // external/foreign（那会像“手机发起的回合不自动停”一样跳过桌面自己的自动停止）。
    if (external) this.onBusy?.(sid, on)
  }

  /**
   * 「这个会话的内容变了，去拉一次完整历史」——去抖后推送。
   *
   * message.part.updated 会随工具每一步都来一次，原样转发会把队列灌满；
   * CHANGE_DEBOUNCE_MS 合并一次，手机那边也不至于一秒拉几十遍历史。
   */
  private pushChange(sid: string): void {
    const now = Date.now()
    if (now - (this.changedAt[sid] ?? 0) < CHANGE_DEBOUNCE_MS) return
    this.changedAt[sid] = now
    this.push({ type: 'session.changed', payload: { sessionID: sid } })
  }

  private push(e: { type: string; payload: Record<string, unknown> }): void {
    this.queue.push(e)
    if (this.queue.length >= EVENT_BATCH) void this.flush()
  }

  /**
   * 立刻把队列推上去，不等 EVENT_FLUSH_MS 那个攒批定时器。
   *
   * 给「列表状态变了」这类**离散事件**用：用户刚点发送就该在手机上看到任务冒到最上面，
   * 多等这几百毫秒是白等。流式增量（message.delta）相反——一个 token 一个 token 地来，
   * 等攒批反而更省流量，所以仍走 push()。
   */
  private pushUrgent(e: { type: string; payload: Record<string, unknown> }): void {
    this.push(e)
    void this.flush()
  }

  private scheduleFlush(): void {
    if (!this.running) return
    this.flushTimer = setTimeout(() => {
      void this.flush().finally(() => this.scheduleFlush())
    }, EVENT_FLUSH_MS)
  }

  private async flush(): Promise<void> {
    if (!this.queue.length) return
    const batch = this.queue.splice(0, EVENT_BATCH)
    try {
      await this.call('/api/ide/desk/events', { ...this.identity(), events: batch }, 'POST')
    } catch {
      // 推失败就丢掉这批：事件是「追进度」用的，重放价值不大，重试反而会堵住队列
    }
  }

  private identity(): { device_id: number; secret: string } {
    const d = loadSettings().platform.device!

    return { device_id: d.id, secret: d.secret }
  }

  private async loop(): Promise<void> {
    if (!this.running) return
    try {
      const s = loadSettings()
      if (!s.remote || !s.mobile || !s.platform.token || !s.platform.device) {
        this.stop()

        return
      }
      const r = await this.call<{ rpcs: Rpc[]; mobile?: boolean }>('/api/ide/desk/pull', this.identity(), 'POST')
      // 手机连没连着只有平台知道（它记的是手机自己最后一次请求的时间）。
      // 认领循环本来就在跑，顺路把状态带回渲染层——状态变了才推，免得每秒都刷界面。
      if (typeof r.mobile === 'boolean' && r.mobile !== this.mobileOnline) {
        this.mobileOnline = r.mobile
        this.notify()
      }
      if (this.lastError) {
        this.lastError = ''
        this.notify()
      }
      for (const rpc of r.rpcs) await this.execute(rpc)
    } catch (e) {
      // 只在错误内容变化时上报一次：认领循环 1.2 秒一轮，每次都推会把渲染层刷爆
      const msg = errText(e)
      if (msg !== this.lastError) {
        this.lastError = msg
        this.notify()
      }
    }
    if (!this.running) return
    this.timer = setTimeout(() => void this.loop(), POLL_MS)
  }

  /** 执行一条指令并把结果交回去（无论成败都要交，否则手机会一直转圈） */
  private async execute(rpc: Rpc): Promise<void> {
    try {
      const result = await this.run(rpc)
      await this.call('/api/ide/desk/result', { ...this.identity(), id: rpc.id, ok: true, result }, 'POST')
    } catch (e) {
      this.queue.push({ type: 'session.busy', payload: {} }) // 占位：确保下面 flush 有内容时也顺带把错误送出去
      this.queue.pop()
      try {
        await this.call('/api/ide/desk/result', { ...this.identity(), id: rpc.id, ok: false, error: errText(e) }, 'POST')
      } catch {
        /* 平台也不可达：这轮就算了，下一轮 pull 会把超时的指令重新派下来 */
      }
    }
  }

  /** 指令表：手机能做的全部事情（与平台 IdeDeviceController::METHODS 一一对应） */
  private async run(rpc: Rpc): Promise<unknown> {
    const p = (rpc.params ?? {}) as {
      path?: string
      sessionId?: string
      text?: string
      /** 仅新建任务用：首条消息截出来的任务名 */
      title?: string
      model?: { providerID: string; modelID: string }
    }
    const dir = p.path

    switch (rpc.method) {
      case 'projects.list':
        return { projects: this.projects }

      case 'models.list': {
        const s = loadSettings()
        const models: { key: string; providerID: string; modelID: string; label: string }[] = []
        // 平台模型排最前（与桌面端选择器同序），且只给内置的——与桌面端同一口径
        if (s.remote && s.platform.token) {
          for (const m of s.platform.models) {
            if (!isBuiltinModel(m)) continue
            models.push({ key: `qingniao:${m.id}`, providerID: 'qingniao', modelID: m.id, label: m.name || m.id })
          }
        }
        for (const prov of s.providers) {
          if (!prov.enabled) continue
          for (const m of prov.models) {
            models.push({ key: `${prov.id}:${m.id}`, providerID: prov.id, modelID: m.id, label: `${m.name || m.id}` })
          }
        }

        return { models }
      }

      case 'sessions.list': {
        const list = await this.sessions(dir)
        // 刷新一次在跑的任务，让手机上的转圈与电脑一致
        for (const s of list) this.markBusy(s.id, s.busy)

        return { tasks: list }
      }

      case 'session.create': {
        // 标题由调用方给（手机端拿首条消息截前 30 字，与电脑上新建任务完全同一口径）。
        // 绝不写死「手机新建的任务」——那是来源标签，不是任务名，左栏里一眼就露馅。
        const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : undefined
        const s = await this.req<{ id: string; title?: string; time?: { updated?: number } }>(
          `/session${dirQ(dir)}`,
          'POST',
          title ? { title } : {}
        )
        // 会话已经落库，手机的任务列表该立刻能看到它。
        // 不靠内核回头抛 session.created（那要等到这一轮真正落盘），
        // 手机自己也会 reload 一次，但别的标签页/别的手机不会——这里主动报一声最稳。
        this.push({ type: 'sessions.changed', payload: { sessionID: s.id, directory: dir ?? '' } })

        return {
          task: { id: s.id, title: s.title || title || '新任务', updated: s.time?.updated ?? Date.now(), busy: false }
        }
      }

      case 'session.messages': {
        if (!p.sessionId) throw new Error('缺少任务 id')
        const list = await this.req<KernelMessage[]>(`/session/${p.sessionId}/message${dirQ(dir)}`)

        return { messages: simplify(list) }
      }

      case 'session.send': {
        if (!p.sessionId) throw new Error('缺少任务 id')
        if (!p.text?.trim()) throw new Error('消息为空')
        const sid = p.sessionId
        const body = {
          parts: [{ type: 'text', text: p.text }],
          ...(p.model ? { model: p.model } : {})
        }
        this.markBusy(sid, true, true)
        // 关键：**不能 await**。内核这个接口要等整轮跑完才返回，await 会把认领循环堵死，
        // 手机点「停止」就再也送不进来了。这里放它自己跑，结果全靠事件流回传。
        void this.req<KernelMessage>(`/session/${sid}/message${dirQ(dir)}`, 'POST', body)
          .then(() => {
            // 消息已落库 → 这个任务的「最近更新」变了，列表要立刻重排。
            // 内核的 session.updated 事件要等 AI 跑完才来，那样手机上就得等到
            // AI 出结果才看到自己的任务冒到最上面；这里在受理的瞬间就报一声。
            this.push({ type: 'sessions.changed', payload: { sessionID: sid, directory: dir ?? '' } })
            this.markBusy(sid, false, true)
          })
          .catch((e) => {
            this.lastError = errText(e)
            this.push({ type: 'session.error', payload: { sessionID: sid, message: errText(e) } })
            this.markBusy(sid, false, true)
          })

        return { started: true }
      }

      case 'session.stop': {
        if (!p.sessionId) throw new Error('缺少任务 id')
        await this.req(`/session/${p.sessionId}/abort${dirQ(dir)}`, 'POST')
        this.markBusy(p.sessionId, false, true)

        return { ok: true }
      }

      default:
        throw new Error('不认识的指令：' + rpc.method)
    }
  }

  /** 会话列表：与左栏同一口径——过滤掉 AI 派生的子会话 */
  private async sessions(dir?: string): Promise<{ id: string; title: string; updated: number; busy: boolean }[]> {
    const list = await this.req<{ id: string; title?: string; time?: { updated?: number }; parentID?: string }[]>(
      `/session${dirQ(dir)}`
    )

    return list
      .filter((s) => !s.parentID)
      .map((s) => ({ id: s.id, title: s.title || '未命名任务', updated: s.time?.updated ?? 0, busy: !!this.busy[s.id] }))
      .sort((a, b) => b.updated - a.updated)
  }

  /** 内核 REST 透传（与渲染层同一个 adapter 门面） */
  private async req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const r = await adapter.api(path, method, body as Record<string, unknown> | undefined)
    if (r.status >= 400) throw new Error(typeof r.data === 'string' ? r.data : `HTTP ${r.status}`)

    return r.data as T
  }

  /** 平台接口调用（Bearer 是登录换来的 IDE token） */
  private async call<T>(path: string, body: unknown, method: string): Promise<T> {
    const s = loadSettings()
    const res = await fetch(platformBaseUrl(s) + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + s.platform.token
      },
      body: JSON.stringify(body ?? {})
    })
    const data = (await res.json().catch(() => null)) as { message?: string } | null
    if (!res.ok) throw new Error(data?.message || `平台返回 HTTP ${res.status}`)

    return data as T
  }
}

interface KernelMessage {
  info: { role: 'user' | 'assistant'; id: string }
  parts: KernelPart[]
}

/** 内核 part：这里只声明 simplify 与 delta 分流真正用到的字段 */
interface KernelPart {
  id?: string
  type: string
  text?: string
  tool?: string
  state?: { status?: string; input?: unknown }
}

/**
 * 「仅上下文」注入消息的标记前缀（与渲染层 oc.ts 的三个常量一致）。
 *
 * 这些消息是 noReply 注入的：**AI 看得到、人不该看**——项目记忆、浏览器当前页面、
 * 附件工具路由说明。桌面上渲染层有 isCtxOnly() 过滤，手机端拿的是内核原始消息，
 * 早先没过滤，于是手机聊天里会莫名其妙冒出一大段「项目记忆」原文。
 *
 * 在这里（主进程）滤掉而不是让手机端滤：一来少传一大坨文本过网络，
 * 二来手机端不用再维护一份前缀表，前缀变了只改这一处。
 */
const CTX_ONLY_PREFIXES = ['␞␞项目记忆␞␞\n', '␞␞浏览器上下文␞␞\n', '␞␞附件路由␞␞\n']

/**
 * 手机端要显示的一个 part（与渲染层 oc.ts 的 Part 同形，裁剪到手机用得到的字段）。
 *
 * 为什么改成「传结构」而不是像早先那样拍平成一段 text：
 * 拍平的结果是手机上只有「最终答复」，思考过程、工具调用（点元素、读文件、跑命令）
 * 全被丢掉——同一段对话，手机和桌面看到的完全是两回事。现在按 part 原样送，
 * 手机端照着桌面那套渲染，「思考」折叠块和工具步骤行都能出来。
 */
interface WirePart {
  id: string
  type: string
  /** 正文 / 思考的文本 */
  text?: string
  /** 工具名（type === 'tool'） */
  tool?: string
  /** 工具状态：pending / running / completed / error */
  status?: string
  /** 工具入参里最能说明「在干什么」的那个字段（路径、命令、URL、选择器…） */
  detail?: string
}

/** 工具入参里按优先级取一个「摘要字段」：手机一行就显示它，比传整个 input 省事得多 */
function toolDetail(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }
  const s =
    pick('filePath', 'file_path', 'path') ||
    pick('command', 'cmd') ||
    pick('url', 'pattern', 'query') ||
    pick('selector', 'elementId', 'ref') ||
    pick('description', 'prompt', 'title')
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

/**
 * 内核消息 → 手机端消息。
 *
 * 丢掉两类：
 *   · step-start / step-finish —— 纯标记，手机自己按状态画步骤行，不需要内核那份
 *   · 「仅上下文」注入消息（项目记忆等）—— AI 可见、人不该看，见 CTX_ONLY_PREFIXES
 *
 * 正文/思考一律 trim 后判空：内核在「只有思考、没有正文」那轮会给出一个只含换行的
 * text part，不判空就会在手机上多出一个什么都没有的灰气泡。
 */
function simplify(list: KernelMessage[]): { role: 'user' | 'assistant'; parts: WirePart[] }[] {
  const out: { role: 'user' | 'assistant'; parts: WirePart[] }[] = []
  for (const m of list) {
    const parts: WirePart[] = []
    for (const raw of m.parts || []) {
      if (raw.type === 'text') {
        const text = String(raw.text ?? '').trim()
        if (!text) continue
        if (CTX_ONLY_PREFIXES.some((p) => text.startsWith(p))) continue
        parts.push({ id: raw.id ?? '', type: 'text', text })
      } else if (raw.type === 'reasoning') {
        const text = String(raw.text ?? '').trim()
        // 空思考（被中断/未产出）不渲染，与桌面端 isCtxOnly 之外的空思考同理
        if (!text) continue
        parts.push({ id: raw.id ?? '', type: 'reasoning', text })
      } else if (raw.type === 'tool') {
        const st = raw.state as { status?: string; input?: unknown } | undefined
        parts.push({
          id: raw.id ?? '',
          type: 'tool',
          tool: String(raw.tool ?? ''),
          status: st?.status ?? 'pending',
          detail: toolDetail(String(raw.tool ?? ''), st?.input)
        })
      }
      // step-start / step-finish 及其它类型一律不带
    }
    if (parts.length) out.push({ role: m.info.role, parts })
  }
  return out
}

const dirQ = (directory?: string) => (directory ? `?directory=${encodeURIComponent(directory)}` : '')

/** 项目清单指纹：只关心「有哪些项目、叫什么」，顺序与附加字段不比 */
function projectsSig(list: { id: string; path: string; name: string }[]): string {
  // 顺序敏感（不做 sort）：桌面按「最近活动 / 固定拖拽序」推来的展示顺序本身就是要对手机生效的，
  // 仅顺序变化也要触发 projects.changed，手机侧重拉 projects.list 才能跟上桌面同一顺序。
  return list.map((p) => `${p.path}\u0000${p.name}`).join('\u0001')
}

/** 设备名：平台后台列表里靠它区分机器 */
function deviceName(): string {
  return `青鸟 · ${platformLabel()} · ${hostname()}`.slice(0, 80)
}

function platformLabel(): string {
  return process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 二维码点阵（0/1 二维数组），渲染层画成内联 SVG——CSP 不允许加载跨源图片 */
function qrMatrix(text: string): { size: number; rows: number[][] } | null {
  try {
    const qr = qrcode(0, 'M')
    qr.addData(text, 'Byte')
    qr.make()
    const n = qr.getModuleCount()
    const rows: number[][] = []
    for (let r = 0; r < n; r++) {
      const row: number[] = []
      for (let c = 0; c < n; c++) row.push(qr.isDark(r, c) ? 1 : 0)
      rows.push(row)
    }

    return { size: n, rows }
  } catch (e) {
    console.log('[relay] 二维码生成失败：' + errText(e))

    return null
  }
}

export const relay = new Relay()
