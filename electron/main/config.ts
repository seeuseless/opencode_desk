import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { DeviceCfg, McpCfg, ModelCfg, Modality, PlatformCfg, ProviderCfg, Settings } from './types.ts'
import { DEFAULT_PLATFORM_URL, MODEL_DEFAULTS, MODALITIES, isBuiltinModel } from './types.ts'

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
    browser: raw?.browser !== false,
    computerUse: raw?.computerUse === true,
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

/** 纯生图模型的命名特征：这类模型只认 /images/generations，发 chat 必被拒，由生图工具代劳 */
const IMAGE_MODEL_RE = /(^|[-_.])(image|img|dall[-_.]?e?|flux|stable[-_.]?diffusion|sdxl)/i
/** 生视频模型同理，只认异步 /videos 任务接口 */
const VIDEO_MODEL_RE = /(^|[-_.])(video|sora|kling|veo|wan)/i
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
  if (s.browser && panelMcp) {
    // 内置浏览器 = 右侧面板里的 webview：AI 与用户看同一个浏览器（登录态共享），
    // 靠元素 ref 定位点击/输入，不依赖模型支持图片。playwright 独立浏览器已由它取代。
    mcp.panel = {
      type: 'local',
      command: ['node', panelMcp.path, String(panelMcp.port)],
      enabled: true
    }
  }
  if (s.computerUse) {
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
  }
  // 生图/生视频：只要任一可用提供商带了生成类模型就挂上工具，对话模型靠它们出图出片
  if (mediaMcp) {
    const pick = (re: RegExp) =>
      usableProviders(s).flatMap((p) =>
        p.apiKey.trim() && p.baseURL.trim()
          ? p.models
              .filter((m) => re.test(m.id))
              .map((m) => ({
                id: `${p.id}/${m.id}`,
                label: m.name || m.id,
                baseURL: p.baseURL.trim().replace(/\/+$/, ''),
                apiKey: p.apiKey.trim(),
                model: m.id
              }))
          : []
      )
    const imageTargets = pick(IMAGE_MODEL_RE)
    const videoTargets = pick(VIDEO_MODEL_RE)
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
        if (IMAGE_MODEL_RE.test(m.id) || VIDEO_MODEL_RE.test(m.id)) continue // 生成类吃不了 chat
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
  // 桌面控制开启时注入工具路由约定：浏览器操作默认走桌面真实浏览器，panel_* 仅限用户点名面板时
  const instructions: string[] = []
  if (s.computerUse) {
    const routing = join(opencodeConfigDir(), 'qingniao-tools.md')
    writeFileSync(
      routing,
      '# 工具路由约定\n' +
        '- 「打开网页 / 上网 / 操作浏览器」默认指用户桌面上的真实浏览器：用 computer 工具（截屏 + 键鼠）完成，不要用 panel_*。\n' +
        '- panel_* 只控制青鸟窗口右侧的内嵌面板浏览器，仅当用户明确要求「在面板 / 内置浏览器里打开」时使用。\n' +
        '- 「打开某应用」动手前必须先调 app_running 查该应用是否已在运行（传英文进程名/拼音关键词，如微信 ["wechat","weixin"]）：\n' +
        '  已在运行 → 严禁再用 Win+R / 双击图标启动第二个实例，改为截屏找任务栏图标点击唤起，找不到再试 Alt+Tab 或系统托盘；\n' +
        '  未在运行 → 才走启动流程，启动后截屏确认窗口出现。\n' +
        '- 「打开某应用」直接就是任务：第一步调 app_running，不要先截屏猜、更不要直接 Win+R。'
    )
    instructions.push(routing)
  }
  /**
   * 附件工具路由约定（常驻指令）：模型看不到图片画面时，光靠工具 description 里的触发条件
   * 基本不会调工具——实测它会直接回「我看不了图片」。这里把规则写进内核指令，
   * 重启内核即生效，不依赖渲染层改动（渲染层那次注入仍保留，它额外带上本轮附件的具体路径）。
   */
  if (mcp.vision || mcp.media) {
    const attach = join(opencodeConfigDir(), 'qingniao-attach.md')
    const lines = [
      '# 图片 / 视频附件处理约定',
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
        '- 要**按视频出片**（续写、换风格、配音乐）→ 调 `create_video`，视频路径放进 videos（配音乐用 audios，参考图用 images）。'
      )
    }
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
