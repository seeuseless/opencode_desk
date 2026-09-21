/** OpenCode 内核 REST API 的渲染层封装（经主进程代理，见 electron/main） */
import type { McpCfg, Modality, ProviderCfg, Settings, ThinkingMode } from '../../electron/main/types'
import { MODEL_DEFAULTS, VISION_MODEL_RE, genRoleOf, isBuiltinModel } from '../../electron/main/types'

export type { McpCfg, Modality, ModelCfg, ProviderCfg, SkillDraft, SkillItem, SkillScope, DeskStatus, GenKind, GenRole, ThinkingMode } from '../../electron/main/types'
export type { PlatformStatus, UsageBucket, UsageRow, UsageSeries, UsageSummary, UsageLog, UsagePage, UsageRecord, PlatformAccount } from '../../electron/main/types'
export { MODEL_DEFAULTS, VISION_MODEL_RE, genRoleOf } from '../../electron/main/types'
/** 设置聚合（避开与 lucide `Settings` 图标重名） */
export type SettingsCfg = Settings

/** 平台 provider 在内核里的 ID，与 electron/main/config.ts 的 PLATFORM_PROVIDER_ID 保持一致 */
export const PLATFORM_PROVIDER_ID = 'qingniao'

/**
 * 对话区的模型清单：平台「内置模型」永远排最前（二级列的就是后台启用的内置模型，跟随后台排序），
 * 用户自建的提供商接在后面。
 *
 * 两个过滤条件缺一不可：
 *   remote —— 全局关了远程服务时，平台这套（登录/内置模型）整个不该出现；
 *   builtin —— 后台为了适配各家上游会挂一批同名第三方模型（builtin=false），
 *              它们不属于「内置」，混进来会让人以为模型比实际多。
 *
 * 设置页绝不能吃这份列表——它保存时会把 providers 整体写回磁盘，
 * 而平台那条是登录态虚拟出来的，混进去会被落成一份假配置。
 */
export function chatProviders(s: SettingsCfg): ProviderCfg[] {
  const builtin = s.platform.models.filter(isBuiltinModel)
  const platform =
    s.remote && s.platform.token && builtin.length
      ? [
          {
            id: PLATFORM_PROVIDER_ID,
            name: '内置模型',
            baseURL: s.platform.baseUrl.replace(/\/+$/, '') + '/api/ide/v1',
            apiKey: '',
            enabled: true,
            models: builtin
          }
        ]
      : []

  return [...platform, ...s.providers]
}

/** 「生图/生视频」意图的轻量识别（纯文字、没有附图时的生成请求）。命中只用于提示，不影响发送。 */
const GEN_INTENT_RE =
  /(生图|文生图|生成.{0,6}(图|图片|logo|图标|海报|封面|头像|壁纸|插画)|画(一|个|张|幅)?\S{0,8}?(图|logo|图标|海报|封面|头像|壁纸|插画)|出张?图|设计.{0,6}(logo|图标|海报|封面|头像)|做个图标|生成海报)/i
export function isGenIntent(text: string): boolean {
  return GEN_INTENT_RE.test(text)
}

/** 常见桌面应用名（要模型看屏幕点窗口的这类，浏览器不在内——那走内置面板浏览器） */
const DESKTOP_APP =
  '微信|企业微信|weixin|wechat|qq|钉钉|dingtalk|飞书|lark|记事本|notepad|计算器|calculator|任务管理器|task\\s?manager|资源管理器|explorer|photoshop|illustrator|premiere\\s?pro|\\bword\\b|\\bexcel\\b|powerpoint|\\bwps\\b|steam|网易云音乐|酷狗|potplayer|typora|\\bvscode\\b'
/**
 * 「要操作本机桌面」意图的轻量识别：这类任务必须看屏幕截图（computer 工具回的是图），
 * 所以纯文本模型接不了——命中就按缺图片输入处理，发送前换成能看画面的模型。
 */
const DESKTOP_INTENT_RE = new RegExp(
  `(打开|启动|唤起|切换到|切到|关掉|关闭|最小化|最大化|退出)[^。！？\\n]{0,14}(${DESKTOP_APP})` +
    `|(${DESKTOP_APP})[^。！？\\n]{0,14}(发消息|发送|回复|输入|点击|打开|启动|窗口)` +
    `|操作电脑|控制电脑|控制一下电脑|看屏幕|看下屏幕|截个?屏|截图看看` +
    `|(点击|单击|双击|勾选|滚动到)[^。！？\\n]{0,12}(按钮|图标|菜单|输入框|搜索框|窗口|任务栏|托盘)`,
  'i'
)
export function isDesktopIntent(text: string): boolean {
  if (!DESKTOP_INTENT_RE.test(text)) return false
  // 「在代码里点击按钮的事件怎么处理」这类是写代码，不是操作本机桌面：点名要动电脑才照样算
  if (/(代码|源码|函数|方法|组件|事件|监听|回调|接口|api|css|样式|选择器|报错|bug|调试|编译|仓库|脚本|正则|数据库)/i.test(text))
    return /(操作电脑|控制电脑|看屏幕|看下屏幕|截屏|桌面上)/i.test(text)
  // 「打开微信里的那个网页」这类其实是要浏览器，不需要看桌面；点名要在桌面上操作才照样算
  if (!/(浏览器|网页|网址|链接|url)/i.test(text)) return true
  return /(操作电脑|控制电脑|桌面上|看屏幕|截屏)/i.test(text)
}

/** 是否有可用的生图/生视频模型（决定 generate_image / create_video 工具是否被挂载）。
 *  判定与主进程同一份 genRoleOf：用户在模型配置里显式选过的为准，没选过的按名字判。
 *  只认这两个角色：语音模型（tts）满足不了「画一张图」，别让它把发送前的预警压掉。 */
export function hasGenModel(providers: ProviderCfg[]): boolean {
  return providers.some((p) =>
    p.models.some((m) => {
      const role = genRoleOf(m)
      return role === 'image' || role === 'video'
    })
  )
}

/**
 * 所选模型是否支持图片输入（桌面控制的硬依赖：`computer` 工具回的是屏幕截图，收不了图就等于闭眼点鼠标。
 * 内置浏览器不吃这一套——它回文本 DOM 快照，见 panel-mcp.mjs，所以面板浏览器不要求模型带视觉）。
 * key 为 'pid/mid'，'' = 跟随内核默认，无法判定，返回 true 不拦。
 */
export function modelSupportsImage(list: ProviderCfg[], key: string): boolean {
  if (!key) return true
  const i = key.indexOf('/')
  if (i <= 0) return true
  const m = list.find((x) => x.id === key.slice(0, i))?.models.find((x) => x.id === key.slice(i + 1))
  if (!m) return true
  return (m.input ?? MODEL_DEFAULTS.input).includes('image')
}

/** 同上，视频输入版（用户上传视频附件的发送拦截用） */
export function modelSupportsVideo(list: ProviderCfg[], key: string): boolean {
  if (!key) return true
  const i = key.indexOf('/')
  if (i <= 0) return true
  const m = list.find((x) => x.id === key.slice(0, i))?.models.find((x) => x.id === key.slice(i + 1))
  if (!m) return true
  return (m.input ?? MODEL_DEFAULTS.input).includes('video')
}

/**
 * 有没有可用的「能当眼睛」的对话模型——电脑控制的视觉叠加（screen MCP）靠它代看截图。
 *
 * 判定与主进程 collectVisionTargets 同口径：
 *  1. 勾了「视觉」的（本机显式标注，最可信，平台/第三方一视同仁）；
 *  2. 勾了「图片」的（能读图，通常也能代看）；
 *  3. 名字像视觉模型的（VISION_MODEL_RE，兜住没勾过的老配置）。
 * 这里的用途只是界面提示，判定宽松一点没关系（多认出几个最多是文案上说「已代看」）。
 */
export function hasVisionModel(list: ProviderCfg[]): boolean {
  return list.some((p) =>
    p.enabled &&
    p.models.some((m) => {
      if (genRoleOf(m) !== 'none') return false // 生成类吃不了 chat，代看不了
      const input = m.input ?? MODEL_DEFAULTS.input
      if (input.includes('vision') || input.includes('image')) return true
      return VISION_MODEL_RE.test(m.id + ' ' + (m.name || ''))
    })
  )
}

/**
 * 挑一个「会当眼睛」的模型展示名，用于电脑控制时点名是谁在看屏幕。
 *
 * 与主进程 collectVisionTargets 的三级优先**同序**，所以这里排第一的就是内核实际会用的那个：
 * 显式勾「视觉」的最优先，其次勾「图片」，最后名字像的。找不到返回空串。
 */
export function visionModelName(list: ProviderCfg[]): string {
  const hit = (m: { id: string; name?: string; input?: readonly Modality[] }): boolean => {
    const input = m.input ?? MODEL_DEFAULTS.input
    return input.includes('vision') || input.includes('image') || VISION_MODEL_RE.test(m.id + ' ' + (m.name || ''))
  }
  const ok = (m: ProviderCfg['models'][number]) => genRoleOf(m) === 'none' && hit(m)
  const all = list.filter((p) => p.enabled).flatMap((p) => p.models)
  const explicit = all.find((m) => ok(m) && (m.input ?? []).includes('vision'))
  const flagged = all.find((m) => ok(m) && (m.input ?? []).includes('image'))
  const guessed = all.find(ok)
  const pick = explicit ?? flagged ?? guessed
  return pick ? pick.name || pick.id : ''
}

/** 思考方式：effort = 低/中/高；toggle = 只有开/关；off = 不支持思考。
 *  档位集合由用户在配置里为该模型选的 `思考形态`（ModelCfg.thinking）决定，不再自动探测。 */
export type ThinkingKind = 'off' | 'toggle' | 'effort'

/**
 * 思考形态（配置里的 `ModelCfg.thinking`）→ 输入框思考选择器的档位集合。
 * 'off' → 不支持（禁用）；'toggle'/缺省 → 关/开；固定档 → 低/中/高。
 */
export function thinkingKindOf(mode: ThinkingMode | undefined): ThinkingKind {
  if (mode === 'off') return 'off'
  if (mode === 'low' || mode === 'medium' || mode === 'high') return 'effort'
  return 'toggle'
}

/**
 * 某模型思考档位的**默认取值**：支持思考的模型默认就把思考打开（固定档 → 该档；关/开 → 开），
 * 不支持思考的一律不传（空串）。`mode` 是配置里为该模型选的思考形态，缺省按「关/开」的「开」处理。
 */
export function defaultThinkingValue(mode: ThinkingMode | undefined): string {
  if (mode === 'low' || mode === 'medium' || mode === 'high') return mode
  return mode === 'off' ? '' : 'on'
}

async function call<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const r = await window.qingniao.call(path, opts)
  if (r.status >= 400) {
    const err = new Error(typeof r.data === 'string' ? r.data : `${opts?.method ?? 'GET'} ${path} -> HTTP ${r.status}`) as Error & { status: number }
    err.status = r.status
    throw err
  }
  return r.data as T
}

export interface Session {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  /** 父会话 id：AI 用 task 工具（子 agent）派生出来的子会话都带这个字段；
   *  用户自己发起的会话没有。左侧任务列表只呈现用户的，故列表接口按它过滤 */
  parentID?: string
}

export interface ToolState {
  status?: string
  title?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  /** running 起跳时刻 / 起止时刻（内核 ToolState 携带，超时判定用） */
  time?: { start?: number; end?: number }
  /** 工具自身携带的结构化结果：edit 存 filediff，apply_patch/write 存 files[]
   *  （均为 {file, patch, additions, deletions}，直接用于 +N/-M 与差量展开） */
  metadata?: Record<string, unknown>
  /** MCP 工具返回的附件：browser_take_screenshot 的截图在这里（url 为 data:image/...;base64） */
  attachments?: { type?: string; mime?: string; url: string }[]
}

export interface Part {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  tool?: string
  state?: ToolState
  /**
   * 内核自己生成的「过程说明」文本（不是模型写的、更不是用户输入）。
   *
   * 最典型的是 read 工具的结果：内核在真正读文件前后塞一条
   * `Called the Read tool with the following input: {"filePath":"..."}`，
   * 再跟上文件内容。这类文本呈现给用户毫无信息量（工具行本身已经写了「读取 + 路径」），
   * 而且会把 mp3/图片这类附件路径当成正文糊在对话里。渲染层据此跳过。
   */
  synthetic?: boolean
  /** file part（用户上传的图片/视频附件）：历史渲染与预览用 */
  mime?: string
  filename?: string
  url?: string
  /** 内核某些版本把附件挂在 part 顶层而非 state 上，浏览面板提取时两处兼容 */
  attachments?: { type?: string; mime?: string; url: string }[]
}

export interface MessageInfo {
  id: string
  role: 'user' | 'assistant'
  sessionID: string
  modelID?: string
  providerID?: string
}

export interface MessageView {
  info: MessageInfo
  parts: Part[]
}

export interface ModelSel {
  providerID: string
  modelID: string
}

/** 聊天附件（media:pick 返回）：图片 url=data URL，视频 url=file:// 本机路径 */
export interface Attachment {
  path: string
  name: string
  mime: string
  url: string
}

/**
 * 项目记忆注入标记：以该前缀开头的用户消息是「仅上下文」记忆（noReply 注入，AI 可见但界面不渲染），
 * 用于在新会话首发时把项目记忆喂给内核。ChatView 渲染时据此跳过，避免顶部出现多余提示。
 */
export const MEMORY_PREFIX = '␞␞项目记忆␞␞\n'

/**
 * 浏览器上下文注入标记：内置浏览器开着且有页面时，发消息前把「当前页面 URL + 对话聚焦浏览器」
 * 以 noReply 注入。与项目记忆同一机制——AI 可见、界面不渲染，ChatView 渲染时据此跳过。
 */
export const BROWSER_CTX_PREFIX = '␞␞浏览器上下文␞␞\n'

/**
 * 附件工具路由注入标记：用户发图片/视频附件时，发消息前把「附件路径 + 该调哪个工具」
 * 以 noReply 注入。与项目记忆同一机制——AI 可见、界面不渲染，ChatView 渲染时据此跳过。
 *
 * 为什么需要：光靠工具 description 里的触发条件，模型经常不调工具——尤其是它压根看不到图片
 * 画面、只拿到 [Attached image/png: 路径] 一行占位时，会直接回「我看不了图片」。
 * 明确点名工具和参数，触发率才稳。
 */
export const ATTACH_CTX_PREFIX = '␞␞附件路由␞␞\n'

/**
 * 桌面控制上下文注入标记：本轮要操作桌面时，发消息前把「只用 computer、别碰 panel_*」
 * 这条边界以 noReply 注入。与上面同一机制——AI 可见、界面不渲染，ChatView 渲染时据此跳过。
 *
 * **必须带这个前缀**：isCtxOnly() 靠前缀判定「仅上下文」，漏了就会被当成普通用户消息
 * 渲染出来（实测：桌面控制那几条规则直接显示在对话区里，看着像用户自己发的一段话）。
 */
export const DESKTOP_CTX_PREFIX = '␞␞桌面控制上下文␞␞\n'

/** 内核 question 工具的提问请求（question.v2.asked 事件推送，阻塞等待用户应答） */
export interface QuestionAsk {
  id: string
  sessionID: string
  questions: {
    question: string
    options?: { label: string; description?: string }[]
    /** 允许一次选多个选项 */
    multiple?: boolean
    /** 允许自定义输入（默认 true） */
    custom?: boolean
  }[]
}

/**
 * 内核的权限询问（`permission.asked` 事件）。
 *
 * v1/v2 两套事件名并存，字段名不同，归一到这里：
 *   v1：permission（工具名）+ patterns + always
 *   v2：action + resources + save
 * 内核在用户应答前**一直阻塞**，所以这张卡片必须有出口（允许/拒绝），不能只是提示。
 */
export interface PermissionAsk {
  id: string
  sessionID: string
  /** 动作/工具名，如 edit / bash / read（展示用，也决定提示文案） */
  kind: string
  /** 要动的东西：文件路径、要跑的命令等 */
  targets: string[]
  /** 允许「总是允许」时可选的资源（内核给的候选，为空则不显示该按钮） */
  always: string[]
  metadata: Record<string, unknown>
}

/**
 * 会话文件差量（内核 /session/{id}/diff 返回项）
 * messageID 必须是「用户消息」id：内核把整轮（该用户消息 + 其后续助手消息）的快照差量挂在它身上，
 * patch 是带 +/- 行的完整 unified diff，直接拿来着色即可
 */
export interface FileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

/** 内核管理的终端会话（PTY） */
export interface PtySession {
  id: string
  title?: string
  command: string
  args?: string[]
  cwd?: string
  status: 'running' | 'exited'
  pid?: number
  exitCode?: number
}

/** 多项目：所有会话类接口都带 directory 参数，同一内核实例按项目隔离 */
const dirQ = (directory?: string) => (directory ? `?directory=${encodeURIComponent(directory)}` : '')

export const oc = {
  /** 项目会话列表：**过滤掉 AI 派生的子会话**（task 工具 / 子 agent 创建，带 parentID）。
   *  左侧任务列表只显示用户自己创建的会话，AI 跑子任务不再往左栏冒条目。 */
  sessions: async (directory?: string) => {
    const list = await call<Session[]>(`/session${dirQ(directory)}`)
    return list.filter((s) => !s.parentID)
  },
  createSession: (directory?: string, title?: string) =>
    call<Session>(`/session${dirQ(directory)}`, { method: 'POST', body: { title } }),
  messages: (id: string, directory?: string) => call<MessageView[]>(`/session/${id}/message${dirQ(directory)}`),
  /** 同步等待本轮对话完成；期间流式内容走事件推送。
   *  附件（图片/视频/音频）转成内核 file part：图片 data URL 供内核缩图，视频与音频 file:// 由内核本机读取。
   *  filename 一律填**媒体目录/本地完整路径**——模型据此把路径传给 MCP 工具：
   *  图片用于图生图/图生视频，音频用于 transcribe_audio（语音转文字）。
   *  之前只有图片带路径、其余填裸文件名，模型拿不到绝对路径就调不动工具（音频尤其明显）。
   *  variant 为思考档位（低/高/最高），非空时随请求顶层传给内核（见 docs/内核variant思考档位机制.md）。 */
  prompt: (id: string, directory: string | undefined, text: string, model?: ModelSel, atts?: Attachment[], variant?: string) =>
    call<MessageView>(`/session/${id}/message${dirQ(directory)}`, {
      method: 'POST',
      body: {
        parts: [
          { type: 'text', text },
          ...(atts ?? []).map((a) => ({
            type: 'file',
            mime: a.mime,
            // 图片文件名不能带扩展名以外的装饰（内核按扩展名判类型），但它必须是真路径
            filename: a.path || a.name,
            url: a.url
          }))
        ],
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        ...(variant ? { variant } : {})
      }
    }),
  abort: (id: string, directory?: string) => call(`/session/${id}/abort${dirQ(directory)}`, { method: 'POST' }),
  /** 注入「仅上下文」消息（noReply：不触发 AI 回复，但后续 prompt 自动带上它）——项目记忆用此机制自动喂给新会话 */
  injectContext: (id: string, directory: string | undefined, text: string) =>
    call(`/session/${id}/message${dirQ(directory)}`, {
      method: 'POST',
      body: { parts: [{ type: 'text', text }], noReply: true }
    }),
  /** 撤回会话到指定「用户消息」之前：回滚文件快照并移除该条及其后的历史（编辑消息重发用） */
  revert: (id: string, directory: string | undefined, messageID: string) =>
    call<unknown>(`/session/${id}/revert${dirQ(directory)}`, { method: 'POST', body: { messageID } }),
  deleteSession: (id: string, directory?: string) =>
    call(`/session/${id}${dirQ(directory)}`, { method: 'DELETE' }),
  /** 内核全部待答问题（question 工具阻塞等待用户应答；事件可能漏收，轮询对账用）。
   *  实测该端点按实例（directory）隔离：不带目录参数永远返回空数组，必须随项目传。 */
  questions: (directory?: string) => call<QuestionAsk[]>(`/question${dirQ(directory)}`),
  /** 会话文件差量：messageID 必填且必须是用户消息 id（不传或传助手消息 id 一律返回空数组） */
  diff: (id: string, directory: string | undefined, messageID: string) => {
    const q = dirQ(directory)
    return call<FileDiff[]>(`/session/${id}/diff${q}${q ? '&' : '?'}messageID=${encodeURIComponent(messageID)}`)
  },
  /** 内核管理的终端列表（pty.created/updated/exited/deleted 事件可触发即时刷新） */
  terminals: () => call<PtySession[]>('/pty'),
  /** 终止终端（内核会杀掉该 pty 进程） */
  killTerminal: (ptyID: string, directory?: string) => call(`/pty/${ptyID}${dirQ(directory)}`, { method: 'DELETE' }),
  /** 内核健康探测（主进程 isHealthy，不经内核 REST；停止按钮兜底用） */
  kernelHealth: (): Promise<boolean> => window.qingniao.kernelHealth(),
  /** question 工具应答：answers 与 questions 一一对应，每项是选中的标签数组 */
  replyQuestion: (requestID: string, answers: string[][], directory?: string) =>
    call(`/question/${requestID}/reply${dirQ(directory)}`, { method: 'POST', body: { answers } }),
  rejectQuestion: (requestID: string, directory?: string) =>
    call(`/question/${requestID}/reject${dirQ(directory)}`, { method: 'POST' })
}
