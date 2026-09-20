import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { DeviceCfg, GenKind, McpCfg, ModelCfg, Modality, PlatformCfg, ProviderCfg, Settings, ThinkingMode } from './types.ts'
import { DEFAULT_PLATFORM_URL, MODEL_DEFAULTS, MODALITIES, genRoleOf, isBuiltinModel } from './types.ts'

export type { McpCfg, ProviderCfg, Settings } from './types.ts'
export { DEFAULT_SETTINGS } from './types.ts'

/**
 * 青鸟设置 → OpenCode 内核配置的桥：
 * ~/.qingniaoai/settings.json          应用层数据（UI 唯一事实源）
 * ~/.qingniaoai/opencode/              内核配置目录（生成的 opencode.json；XDG_CONFIG_HOME 隔离）
 * ~/.qingniaoai/data/                  OpenCode 会话存储（XDG_DATA_HOME 隔离，不污染用户默认目录）
 */

const storeDir = () => join(homedir(), '.qingniaoai')
export const settingsPath = () => join(storeDir(), 'settings.json')
/** opencode 在 XDG_CONFIG_HOME 下再套一层 opencode/ 目录（实测） */
export const opencodeConfigDir = () => join(storeDir(), 'opencode')
export const opencodeDataDir = () => join(storeDir(), 'data')
export const opencodeStateDir = () => join(storeDir(), 'state')
export const opencodeConfigPath = () => join(opencodeConfigDir(), 'opencode.json')
export const qingniaoHome = storeDir

/** 非负数字（倍率），非法/缺失一律 undefined——只有平台模型才带这些字段 */
function ratioOr(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const GEN_KINDS: GenKind[] = ['auto', 'image', 'video', 'tts', 'none']
const THINKING_MODES: ThinkingMode[] = ['off', 'toggle', 'low', 'medium', 'high']

/** 单条模型记录归一化：兼容旧版字符串数组与手改文件的缺字段，缺失一律落默认参数 */
function normalizeModel(m: unknown): ModelCfg | null {
  if (typeof m === 'string') return { id: m, context: MODEL_DEFAULTS.context, output: MODEL_DEFAULTS.output, input: [...MODEL_DEFAULTS.input] }
  if (!m || typeof (m as ModelCfg).id !== 'string' || !(m as ModelCfg).id.trim()) return null
  const r = m as Partial<ModelCfg>
  const ratio = ratioOr(r.ratio)
  const effRatio = ratioOr(r.effRatio)
  return {
    id: r.id!.trim(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined,
    context: Number(r.context) > 0 ? Number(r.context) : MODEL_DEFAULTS.context,
    output: Number(r.output) > 0 ? Number(r.output) : MODEL_DEFAULTS.output,
    input: Array.isArray(r.input) ? r.input.filter((x): x is Modality => MODALITIES.includes(x)) : [...MODEL_DEFAULTS.input],
    // 生成角色 / 思考形态：只透传合法值，非法或没选过的不落盘（两者缺省各自按 'auto' / 'toggle' 处理）
    ...(GEN_KINDS.includes(r.gen as GenKind) ? { gen: r.gen } : {}),
    ...(THINKING_MODES.includes(r.thinking as ThinkingMode) ? { thinking: r.thinking } : {}),
    // 计价信息（限免/折扣/倍率）只做展示用，原样透传；没有的键不落盘，省得第三方模型也带一堆 null
    ...(typeof r.free === 'boolean' ? { free: r.free } : {}),
    ...(r.discount === null || typeof r.discount === 'number' ? { discount: (r.discount ?? null) as number | null } : {}),
    ...(ratio === undefined ? {} : { ratio }),
    ...(effRatio === undefined ? {} : { effRatio }),
    // 平台后台那一列「内置」：对话区「内置模型」分组按它过滤，只留平台官方提供的
    ...(typeof r.builtin === 'boolean' ? { builtin: r.builtin } : {})
  }
}

/** 补齐缺失字段并做形状清洗（旧版存档 / 手改文件都走这里） */
export function normalize(raw: Partial<Settings> | null | undefined): Settings {
  const providers: ProviderCfg[] = Array.isArray(raw?.providers)
    ? raw!.providers
        .filter((p): p is ProviderCfg => !!p && typeof p.id === 'string')
        .map((p) => ({
          id: String(p.id).trim(),
          name: String(p.name ?? p.id),
          baseURL: String(p.baseURL ?? ''),
          apiKey: String(p.apiKey ?? ''),
          enabled: p.enabled !== false,
          // 视频任务查询地址模板：留空不落盘（生成工具会按默认几种形态试）
          ...(String(p.videoPoll ?? '').trim() ? { videoPoll: String(p.videoPoll).trim() } : {}),
          models: Array.isArray(p.models) ? p.models.map(normalizeModel).filter((m): m is ModelCfg => !!m) : []
        }))
    : []
  const mcps: McpCfg[] = Array.isArray(raw?.mcps)
    ? raw!.mcps
        .filter((m): m is McpCfg => !!m && typeof m.name === 'string' && (m.name as string).trim() !== '')
        .map((m) => ({
          name: String(m.name).trim(),
          type: m.type === 'remote' ? 'remote' : 'local',
          command: String(m.command ?? ''),
          url: String(m.url ?? ''),
          enabled: m.enabled !== false
        }))
    : []
  // 内置浏览器默认开启：没记录过开关的新/旧配置都开，用户显式关过（false）才保持关；
  // 桌面控制涉及键鼠操控，默认关；移动端连接会把服务暴露到局域网，默认关
  // 平台登录态：地址、token、用户、模型清单都是纯数据；缺字段一律落默认
  const rawPlatform = (raw?.platform ?? {}) as Partial<PlatformCfg>
  const rawDevice = rawPlatform.device as Partial<DeviceCfg> | null | undefined
  const device: DeviceCfg | null =
    rawDevice && typeof rawDevice.token === 'string' && rawDevice.token && typeof rawDevice.secret === 'string'
      ? {
          id: Number(rawDevice.id) || 0,
          name: String(rawDevice.name ?? '青鸟'),
          token: String(rawDevice.token),
          secret: String(rawDevice.secret),
          url: String(rawDevice.url ?? '')
        }
      : null
  const platform: PlatformCfg = {
    baseUrl: String(rawPlatform.baseUrl ?? DEFAULT_PLATFORM_URL).trim().replace(/\/+$/, '') || DEFAULT_PLATFORM_URL,
    token: String(rawPlatform.token ?? ''),
    user: rawPlatform.user && typeof rawPlatform.user === 'object' ? rawPlatform.user : null,
    models: Array.isArray(rawPlatform.models) ? rawPlatform.models.map(normalizeModel).filter((m): m is ModelCfg => !!m) : [],
    syncedAt: Number(rawPlatform.syncedAt) > 0 ? Number(rawPlatform.syncedAt) : undefined,
    device
  }
  return {
    providers,
    mcps,
    // 内置浏览器与桌面控制不再有开关（旧存档里那两个键读到时直接忽略）：见 writeOpencodeConfig 的挂载段
    // 远程服务默认关：只有显式存过 true 才开（老配置没有这个键，自然落到关）
    remote: raw?.remote === true,
    mobile: raw?.mobile === true,
    platform
  }
}

/** 旧数据目录一次性迁移（codexdesk / qingniao / justdo 时代的设置） */
function migrateLegacy(): void {
  if (existsSync(settingsPath())) return
  for (const old of [join(homedir(), '.codexdesk'), join(homedir(), '.qingniao'), join(homedir(), '.justdo')]) {
    const src = join(old, 'settings.json')
    if (!existsSync(src)) continue
    try {
      mkdirSync(storeDir(), { recursive: true })
      writeFileSync(settingsPath(), JSON.stringify(normalize(JSON.parse(readFileSync(src, 'utf8')) as Partial<Settings>), null, 2))
    } catch {
      /* 坏文件直接忽略，走空配置 */
    }
    return
  }
}

export function loadSettings(): Settings {
  migrateLegacy()
  try {
    return normalize(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>)
  } catch {
    return normalize({}) // 坏文件/无文件：走默认配置（内置浏览器默认开）
  }
}

export function saveSettings(s: Settings): void {
  mkdirSync(storeDir(), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(normalize(s), null, 2))
  writeOpencodeConfig(loadSettings())
}

/**
 * 只改「允许移动端连接」这一个开关并落盘——**不重启内核**。
 * 这个开关跟 provider/MCP 那套内核配置无关，走 saveSettings 会让内核白重启一次，
 * 手机正连着的时候直接断流。
 */
export function setMobileEnabled(on: boolean): void {
  const s = loadSettings()
  if (s.mobile === on) return
  s.mobile = on
  mkdirSync(storeDir(), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(normalize(s), null, 2))
}

/** provider 密钥经环境变量注入（opencode.json 的 {env:...} 插值） */
export function envKey(providerID: string): string {
  return 'QN_KEY_' + providerID.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

/** 平台 provider 的固定 ID 与名称（第三方 provider 与它并存，互不覆盖） */
export const PLATFORM_PROVIDER_ID = 'qingniao'
export const PLATFORM_PROVIDER_NAME = '青鸟平台'

/**
 * 生效的平台地址 —— 全应用只此一处：
 * 环境变量 QINGNIAO_PLATFORM_URL > 设置里的 platform.baseUrl > 内置默认值。
 * 上线换域名时改设置（或打包时给环境变量）即可，登录入口与网关 baseURL 自动跟着变。
 */
export function platformBaseUrl(s?: Settings): string {
  const fromEnv = (process.env.QINGNIAO_PLATFORM_URL || '').trim()
  const raw = fromEnv || (s ?? loadSettings()).platform.baseUrl || DEFAULT_PLATFORM_URL
  return raw.replace(/\/+$/, '')
}

/** 平台登录页地址（浏览器可直开） */
export function platformLoginUrl(s?: Settings): string {
  return platformBaseUrl(s) + '/ide/login'
}

/**
 * 平台登录态 → 一个虚拟 provider（指向平台的 OpenAI 兼容网关）。
 *
 * 两种情况下返回 null，此时内核里不会出现平台条目：
 *   1. 关了「远程服务」（全局总开关，见 Settings.remote）；
 *   2. 未登录，或平台没下发任何「内置」模型。
 *
 * 只收内置模型：平台后台为了适配各家上游会挂一批同名第三方模型
 * （builtin=false），那是给后台运维看的，不该混进用户的「内置模型」里。
 */
export function platformProvider(s: Settings): ProviderCfg | null {
  if (!s.remote) return null
  const models = s.platform.models.filter(isBuiltinModel)
  if (!s.platform.token || !models.length) return null

  return {
    id: PLATFORM_PROVIDER_ID,
    name: PLATFORM_PROVIDER_NAME,
    baseURL: platformBaseUrl(s) + '/api/ide/v1',
    apiKey: s.platform.token,
    enabled: true,
    models
  }
}

/** 只改平台登录态并落盘（是否重启内核交给调用方决定） */
export function setPlatform(patch: Partial<PlatformCfg>): Settings {
  const next = normalize({ ...loadSettings(), platform: { ...loadSettings().platform, ...patch } })
  mkdirSync(storeDir(), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  writeOpencodeConfig(next)
  return next
}

/** 退出登录：清 token、用户信息、模型清单与设备身份（设备是绑在账号上的） */
export function clearPlatform(): Settings {
  return setPlatform({ token: '', user: null, models: [], syncedAt: undefined, device: null })
}

export function providerEnv(s: Settings): Record<string, string> {
  const env: Record<string, string> = {}
  const platform = platformProvider(s)
  if (platform) env[envKey(platform.id)] = platform.apiKey
  for (const p of s.providers) {
    if (p.enabled && p.apiKey) env[envKey(p.id)] = p.apiKey
  }
  return env
}

/**
 * 真正会写入 opencode.json 的 provider（writeOpencodeConfig 与 defaultModel 的唯一判定源）。
 * 平台 provider 固定排在最前：平台登录后它就是默认首选，第三方配置照旧并排列在后面。
 */
export function usableProviders(s: Settings): ProviderCfg[] {
  const manual = s.providers.filter(
    (p) => p.enabled && p.id.trim() && p.id !== PLATFORM_PROVIDER_ID && p.baseURL.trim() && p.models.length > 0
  )
  const platform = platformProvider(s)
  return platform ? [platform, ...manual] : manual
}

/** 面板浏览器 MCP 的启动信息（主进程启动时注入：脚本路径 + 控制端点端口），writeOpencodeConfig 用 */
let panelMcp: { path: string; port: number } | undefined
export function setPanelMcp(v: { path: string; port: number }): void {
  panelMcp = v
}
/** 桌面辅助 MCP（app_running 查进程）脚本路径，桌面控制开启时注册 */
let desktopMcp: { path: string } | undefined
export function setDesktopMcp(v: { path: string }): void {
  desktopMcp = v
}
/** 媒体生成 MCP（生图/生视频工具）脚本路径 */
let mediaMcp: { path: string } | undefined
export function setMediaMcp(v: { path: string }): void {
  mediaMcp = v
}
/** 图片理解 MCP（describe_image 识图工具）脚本路径 */
let visionMcp: { path: string } | undefined
export function setVisionMcp(v: { path: string }): void {
  visionMcp = v
}
/** 语音合成 MCP（generate_speech 配音工具）脚本路径 */
let ttsMcp: { path: string } | undefined
export function setTtsMcp(v: { path: string }): void {
  ttsMcp = v
}

/**
 * 视觉（能看图）模型的命名特征——挑识图目标时用。
 *
 * 平台下发的模型清单不带模态字段，内置模型的 input 又是硬编码全勾（见 platform.ts），
 * 那份 input 不可信，只能按名字认；名字是最可靠的公开信号（厂商自己都这么命名）。
 * 匹配的是「id + 展示名」：平台内置模型对外 ID 常是 qn-xxx，靠展示名才认得出。
 */
const VISION_MODEL_RE =
  /(vision|omni|gemini|internvl|minicpm|llava|pixtral|gpt-4o|gpt-4-turbo|gpt-5|claude-3|claude-4|glm-4v|glm-4\.5v|glm-v|qwen.*vl|doubao.*(vision|vl)|(^|[-_.\s])vl([-_.\s]|$)|(^|[-_.\s])o[1-9])/i

/**
 * 思考档位 → 内核 variants（档位名 → 请求选项覆盖）。
 * 固定把档位写全（低/中/高 + 开），**显示哪些档位交给渲染层按模型自身能力判定**，配置侧不再区分模型：
 * 内核遇到请求里没声明过的档位名时不合并任何 options（等于服务端默认），多写不会有害；
 * 反过来若只按配置写一种，模型能力与配置不符时用户就选不到正确档位。
 */
const THINK_VARIANTS: Record<string, unknown> = {
  low: { reasoningEffort: 'low' },
  medium: { reasoningEffort: 'medium' },
  high: { reasoningEffort: 'high' },
  // toggle 型（只有开/关）的「开」：统一按高档思考发出
  on: { reasoningEffort: 'high' },
  // 「关」：显式关闭思考。OpenAI 兼容端点的通用值是 reasoning_effort=none
  //（实测 agnes-3.0-flash 传 none 后不再产出 reasoning_content，与 chat_template_kwargs.enable_thinking=false 等效）
  none: { reasoningEffort: 'none' }
}

/**
 * 生成内核配置：自定义提供商（OpenAI Chat 兼容，经 @ai-sdk/openai-compatible）+ MCP（含内置浏览器与桌面控制）。
 * opencode 默认放行全部工具执行，无需 permission 配置；端点必须提供 /chat/completions。
 */
export function writeOpencodeConfig(s: Settings): void {
  mkdirSync(opencodeConfigDir(), { recursive: true })
  const provider: Record<string, unknown> = {}
  for (const p of usableProviders(s)) {
    const id = p.id.trim()
    provider[id] = {
      npm: '@ai-sdk/openai-compatible',
      name: p.name || id,
      options: {
        baseURL: p.baseURL.trim().replace(/\/+$/, ''),
        apiKey: '{env:' + envKey(id) + '}'
      },
      // 每模型接入参数：上下文窗口/最大输出 → limit，输入类型 → modalities.input（输出固定文本）
      // 思考档位 → variants（内核 model variant，key 为档位名，值为请求选项覆盖）：
      // reasonEffort 经 @ai-sdk/openai-compatible 变成请求体 reasoning_effort（见 docs/内核variant思考档位机制.md）
      // name 只在有展示名时写（平台模型对外 ID 是 qn-xxx，靠它显示人话）
      models: Object.fromEntries(
        p.models.map((m) => [
          m.id,
          {
            ...(m.name ? { name: m.name } : {}),
            limit: { context: m.context, output: m.output },
            modalities: { input: m.input, output: ['text'] },
            variants: THINK_VARIANTS
          }
        ])
      )
    }
  }
  const mcp: Record<string, unknown> = {}
  // 内置浏览器与桌面控制是内置能力，一律挂上，不再受设置开关控制（要停得改这份配置本身）
  if (panelMcp) {
    // 内置浏览器 = 右侧面板里的 webview：AI 与用户看同一个浏览器（登录态共享），
    // 靠元素 ref 定位点击/输入，不依赖模型支持图片。playwright 独立浏览器已由它取代。
    mcp.panel = {
      type: 'local',
      command: ['node', panelMcp.path, String(panelMcp.port)],
      enabled: true
    }
  }
  // 截屏 + 键鼠模拟控制本机（nut.js 实现，跨平台；模型需支持图片输入）
  mcp['computer-use'] = {
    type: 'local',
    command: ['npx', '-y', 'computer-use-mcp'],
    enabled: true
  }
  // 桌面辅助：app_running 给模型确定性的「应用在不在跑」答案，杜绝重复启动实例
  if (desktopMcp) {
    mcp['desktop-helper'] = { type: 'local', command: ['node', desktopMcp.path], enabled: true }
  }
  // 生成类模型（生图 / 生视频 / 语音）都不走对话接口，逐个角色挑出目标挂成工具，对话模型靠它们出片出声
  // 生成角色由用户在模型配置里显式选（ModelCfg.gen），没选过的按模型名判——见 types.ts genRoleOf
  const pick = (role: 'image' | 'video' | 'tts') =>
    usableProviders(s).flatMap((p) =>
      p.apiKey.trim() && p.baseURL.trim()
        ? p.models
            .filter((m) => genRoleOf(m) === role)
            .map((m) => ({
              id: `${p.id}/${m.id}`,
              label: m.name || m.id,
              baseURL: p.baseURL.trim().replace(/\/+$/, ''),
              apiKey: p.apiKey.trim(),
              model: m.id,
              // 查询地址模板只有生视频用得上：填过就带上，工具据此优先
              ...(role === 'video' && p.videoPoll ? { poll: p.videoPoll } : {})
            }))
        : []
    )
  if (mediaMcp) {
    const imageTargets = pick('image')
    const videoTargets = pick('video')
    if (imageTargets.length || videoTargets.length) {
      mcp['media'] = {
        type: 'local',
        command: ['node', mediaMcp.path],
        environment: {
          QN_IMAGE_TARGETS: JSON.stringify(imageTargets),
          QN_VIDEO_TARGETS: JSON.stringify(videoTargets),
          QN_MEDIA_DIR: join(storeDir(), 'media')
        },
        // 生图一次要几十秒，默认 5s 的 MCP 超时会把工具调用掐死
        timeout: 300000,
        enabled: true
      }
    }
  }
  if (ttsMcp) {
    const ttsTargets = pick('tts')
    if (ttsTargets.length) {
      mcp.tts = {
        type: 'local',
        command: ['node', ttsMcp.path],
        environment: { QN_TTS_TARGETS: JSON.stringify(ttsTargets), QN_MEDIA_DIR: join(storeDir(), 'media') },
        timeout: 180000,
        enabled: true
      }
    }
  }
  // 识图：对话模型不支持 image 输入时，内核不会把图放进上下文，只剩一行 [Attached image/png: 路径]。
  // 挂一个视觉模型当「代看」——describe_image 读那个路径问视觉模型，把答案交还给对话模型。
  if (visionMcp) {
    const flagged: { id: string; label: string; baseURL: string; apiKey: string; model: string }[] = []
    const guessed: { id: string; label: string; baseURL: string; apiKey: string; model: string }[] = []
    for (const p of usableProviders(s)) {
      if (!p.apiKey.trim() || !p.baseURL.trim()) continue
      // 平台清单不下发模态字段、内置模型的 input 又是硬编码全勾（见 platform.ts），那份 input 不可信
      const trustInput = p.id !== PLATFORM_PROVIDER_ID
      for (const m of p.models) {
        if (genRoleOf(m) !== 'none') continue // 生成类吃不了 chat
        const label = m.name || m.id
        const item = {
          id: `${p.id}/${m.id}`,
          label,
          baseURL: p.baseURL.trim().replace(/\/+$/, ''),
          apiKey: p.apiKey.trim(),
          model: m.id
        }
        if (trustInput && (m.input ?? []).includes('image')) flagged.push(item)
        else if (VISION_MODEL_RE.test(m.id + ' ' + label)) guessed.push(item)
      }
    }
    // 用户显式勾了图片输入的排前面（可信），按名字认出来的兜底
    const visionTargets = [...flagged, ...guessed]
    if (visionTargets.length) {
      mcp.vision = {
        type: 'local',
        command: ['node', visionMcp.path],
        environment: {
          QN_VISION_TARGETS: JSON.stringify(visionTargets),
          QN_MEDIA_DIR: join(storeDir(), 'media')
        },
        // 识图几秒到几十秒（大图更久），默认 5s 超时必被掐
        timeout: 120000,
        enabled: true
      }
    }
  }
  for (const m of s.mcps) {
    if (m.type === 'remote') {
      if (!m.url.trim()) continue
      mcp[m.name] = { type: 'remote', url: m.url.trim(), enabled: m.enabled }
    } else {
      const argv = m.command.trim().split(/\s+/).filter(Boolean)
      if (!argv.length) continue
      mcp[m.name] = { type: 'local', command: argv, enabled: m.enabled }
    }
  }
  // 内置浏览器与桌面控制常驻，这份工具路由约定也就常驻
  const instructions: string[] = []
  const routing = join(opencodeConfigDir(), 'qingniao-tools.md')
  writeFileSync(
    routing,
    '# 工具路由约定\n' +
      '- 「打开网页 / 打开链接 / 上网 / 操作浏览器」一律用青鸟窗口右侧的内置浏览器（`panel_*` 工具）：' +
      '它与用户看同一个浏览器、登录态共享，靠元素 ref 定位点击/输入，不需要截屏。**本回复里给出的 URL 要打开时同样走 panel_*。**\n' +
      '- **网页内容一律用 `panel_snapshot` 读（文本元素清单 + 标题），严禁为了「看看打开没有 / 页面长什么样」去 `computer` 截屏**：' +
      '截屏要移动鼠标、等画面、还要求当前模型支持图片输入，比 snapshot 慢一个数量级，而且面板页面本来就能直接读到结构。\n' +
      '- 只有用户明确要求「在桌面上 / 外部真实浏览器里打开」时，才用 computer 工具（截屏 + 键鼠）去操作桌面浏览器。\n' +
      '- **操作本机桌面应用一律用 `computer` 工具**（它在内置清单里，永远可用）：`{"action":"get_screenshot"}` 看画面 → ' +
      '`left_click` / `type` / `key` 动手 → 再截屏确认。典型任务如「打开微信给文件助手发条消息」：' +
      '截屏找到窗口 → 点搜索框 → `type` 搜「文件传输助手」→ 点开 → 点输入框 → `type` 正文 → `key` Return。\n' +
      '- **严禁改用写代码的方式操作桌面**：不要 `bash` 跑 PowerShell 的 SendKeys / `Add-Type` UIAutomation / user32 `keybd_event`，' +
      '也不要装 pyautogui、AutoIt、RobotJS 之类去模拟点击输入。这类脚本看不见画面、不会等待界面就绪，只会把东西打进错误的地方。' +
      '`bash` 在这类任务里只允许用来「启动一个进程」，其余一律 `computer`。\n' +
      '- `computer` 返回的是屏幕截图：若截图回不来（当前模型不支持图片输入）或工具报错，如实说明并让用户换支持图片输入的模型，' +
      '**不要退化成写脚本硬猜**。\n' +
      '- 「打开某应用」动手前必须先调 app_running 查该应用是否已在运行（传英文进程名/拼音关键词，如微信 ["wechat","weixin"]）：\n' +
      '  已在运行 → 严禁再用 Win+R / 双击图标启动第二个实例，改为截屏找任务栏图标点击唤起，找不到再试 Alt+Tab 或系统托盘；\n' +
      '  未在运行 → 才走启动流程，启动后截屏确认窗口出现。\n' +
      '- 「打开某应用」直接就是任务：第一步调 app_running，不要先截屏猜、更不要直接 Win+R。'
  )
  instructions.push(routing)
  /**
   * 工具路由约定（常驻指令）：模型看不到图片画面、或没意识到有生图工具时，光靠工具 description 里的
   * 触发条件基本不会调工具——实测它会直接回「我看不了图片」、或改用写代码的方式画图。这块把规则写进
   * 内核指令，重启内核即生效，不依赖渲染层改动（渲染层那次注入仍保留，它额外带上本轮附件的具体路径）。
   */
  if (mcp.vision || mcp.media || mcp.tts) {
    const attach = join(opencodeConfigDir(), 'qingniao-attach.md')
    const lines = [
      '# 图片 / 视频 / 语音处理约定',
      '- 用户消息里出现 `[Attached image/png: 路径]` 这类占位文本，说明**你看不到图片画面**（当前模型不支持读图）。',
      '  此时严禁回答「我看不了图片 / 请你描述一下这张图」，也**严禁反问用户「要不要我识别一下」「需要我处理吗」**——' +
        '用户把图发出来就是要你处理，**直接调用下面对应的工具**，把占位里的路径**原样**填进参数（不要改成文件名，不要自己编造路径）。'
    ]
    if (mcp.vision)
      lines.push(
        '- 要**看懂图片内容**（识别画面、读取图里文字、回答关于这张图的问题）→ 调 `describe_image`，images 填该路径。'
      )
    if (mcp.media) {
      lines.push(
        '- 要**改图 / 按图出图**（换背景、换风格、去掉某物、做成某风格）→ 调 `generate_image`，把该路径放进 image 参数，文字要求写进 prompt。',
        '- 要**按视频出片**（续写、换风格、配音乐）→ 调 `create_video`，视频路径放进 videos（配音乐用 audios，参考图用 images）。',
        '- **没有附图、纯文字要求生图/生视频**（「画一张 / 设计 / 生成 / 出张 *图」「做个 *logo、图标、海报」「做个 *视频」）→ 同样必须调 `generate_image`（只填 prompt、不填 image）/ `create_video`。禁止自己写 Python / 装库的方式来画图。',
        '- 若本轮**没有** `generate_image` 工具（说明当前没配生图模型），直接如实说明「需先在设置里配置一个生图模型」，不要假装用代码出图、更不要硬画。',
        '- 生图/生视频成功后：结果原样转达，展示一律内嵌本地文件——`![图片](本地路径)` 或 `![视频](本地路径)`，另起一行用反引号给出该路径；远程 URL 可能过期，不要当媒体地址贴出来。'
      )
    }
    if (mcp.tts)
      lines.push(
        '- 用户要**配音 / 朗读这段 / 念出来 / 生成语音 / 做成音频 / 换个音色读**→ 必须调 `generate_speech`：' +
          '要念的正文放 text（别把风格要求混进去），语气情绪语速放 style，音色放 voice（不确定就不填，用默认音色）。' +
          '严禁回答「我不能生成音频」，也严禁改用写代码合成波形的方式硬凑。',
        '- 若本轮**没有** `generate_speech` 工具（说明当前没配语音模型），直接如实说明「需先在设置里配置一个语音合成模型」，不要假装出音频。',
        '- 语音成功后：本地路径原样转达（另起一行用反引号包住），并直接用 `![音频](本地路径)` 内嵌——客户端会渲染成播放器试听。'
      )
    lines.push('- 分不清意图时按上述顺序判断：先问内容 → describe_image；要求改画面 → generate_image。')
    writeFileSync(attach, lines.join('\n') + '\n')
    instructions.push(attach)
  }
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    provider,
    mcp,
    instructions
  }
  writeFileSync(opencodeConfigPath(), JSON.stringify(cfg, null, 2))
}

/** 首个可用 provider+model，作为 UI 未选中/选中失效时的回落档 */
export function defaultModel(s: Settings): { providerID: string; modelID: string } | undefined {
  const p = usableProviders(s)[0]
  const m = p?.models[0]
  return p && m ? { providerID: p.id, modelID: m.id } : undefined
}

/**
 * 把 UI 传来的模型选择校正到 opencode.json 里实际存在的 provider（存档值可能因改名/停用/删除而失效）。
 * 命中不了回落默认档；一个可用提供商都没有时返回 undefined（由调用方决定报错还是放行内核默认）。
 */
export function resolveModel(
  s: Settings,
  sel?: { providerID?: string; modelID?: string }
): { providerID: string; modelID: string } | undefined {
  const list = usableProviders(s)
  const hit = sel?.providerID ? list.find((p) => p.id === sel.providerID) : undefined
  if (!hit) return defaultModel(s)
  const modelID = sel?.modelID && hit.models.some((m) => m.id === sel.modelID) ? sel.modelID : hit.models[0].id
  return { providerID: hit.id, modelID }
}
