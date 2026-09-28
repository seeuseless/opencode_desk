import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AccessLevel, DeviceCfg, GenKind, McpCfg, ModelCfg, Modality, PlatformCfg, ProviderCfg, Settings, ThinkingMode } from './types.ts'
import { DEFAULT_PLATFORM_URL, INPUT_OPTIONS, MODEL_DEFAULTS, MODALITIES, VISION_MODEL_RE, genRoleOf, isBuiltinModel } from './types.ts'

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

const GEN_KINDS: GenKind[] = ['auto', 'image', 'video', 'tts', 'music', 'asr', 'none']
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
    // 输入模态按 INPUT_OPTIONS 白名单过滤（**不是** MODALITIES）：后者是写进内核的真实模态，
    // 不含本机专用的 'vision' 标记，用它过滤会把用户勾的「视觉」丢掉。
    input: Array.isArray(r.input) ? r.input.filter((x): x is Modality => INPUT_OPTIONS.includes(x)) : [...MODEL_DEFAULTS.input],
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
  // 内置浏览器默认开启（它没有开关：没记录过的新/旧配置都开）；
  // 移动端连接会把服务暴露到局域网，默认关
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
    models: Array.isArray(rawPlatform.models)
      ? rawPlatform.models.map(normalizeModel).filter((m): m is ModelCfg => !!m).map(healPlatformModalities)
      : [],
    syncedAt: Number(rawPlatform.syncedAt) > 0 ? Number(rawPlatform.syncedAt) : undefined,
    device
  }
  return {
    providers,
    mcps,
    // 内置浏览器没有开关（见 writeOpencodeConfig 的挂载段：面板 MCP 一直是开的）
    // 远程服务默认关：只有显式存过 true 才开（老配置没有这个键，自然落到关）
    remote: raw?.remote === true,
    mobile: raw?.mobile === true,
    platform,
    // 访问权限（全局一档）：只认 'full'，其余（含老存档的按目录表、手改错值）一律落默认
    access: normalizeAccess(raw?.access),
    // 「永久允许调用」清单：只收非空字符串（手改存档塞进数字/对象时一并滤掉，否则授权判定会静默失配）
    modelAuth: Array.isArray(raw?.modelAuth)
      ? [...new Set(raw.modelAuth.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()))]
      : []
  }
}

/**
 * 访问权限归一化：**全局一档**，只认 'full' | 'default'，其余一律落 'default'。
 *
 * 兼容老存档：早期版本存的是 `{ "<项目路径>": "full" }` 这张按目录表，现在若读到对象，
 * 取「只要有任一条是 full 就算 full」——用户当初既然对某个目录开过完全控制，
 * 说明他整体上愿意放开，升级后不该反而被收紧；其余键值（含形状不对的）一律忽略。
 */
function normalizeAccess(raw: unknown): AccessLevel {
  if (raw === 'full') return 'full'
  if (raw && typeof raw === 'object') {
    const vals = Object.values(raw as Record<string, unknown>)
    return vals.includes('full') ? 'full' : 'default'
  }
  return 'default'
}

/**
 * 内核 `permission` 配置：按访问档位生成。
 *
 * 两档的差别只在**写操作**上——`edit`（改文件）、`bash`（执行命令）默认要确认；
 * 读类的 `read` / `glob` / `grep` / `list` 一律放行：这是本应用的核心用途，
 * 每看一眼文件都弹框只会把人逼疯，而读操作本身不可逆伤害为 0。
 *
 * 注意内核对**项目外**目录的写入本来就是 'ask'（external_directory），这里不动它——
 * 用户授权的是「这个项目目录」，越过边界仍然要问。
 */
function permissionCfgFor(level: AccessLevel): Record<string, unknown> {
  if (level === 'full') {
    return { edit: 'allow', bash: 'allow' }
  }
  return { edit: 'ask', bash: 'ask' }
}

/**
 * 修正平台内置模型存档里那份**假的输入模态**。
 *
 * 老版本在同步平台清单时把 input 写死成全勾（文本+图片+视频），导致所有内置模型
 * 在界面和判定里都"支持读图"——设置里看到的勾选是假的，而挑代看目标时又只能反过来
 * 按名字猜，两边口径不一致。现在同步侧已改成按名字给保守初值（见 platform.ts），
 * 但已落盘的老存档还带着全勾，这里在读盘时修一次。
 *
 * 只改"明显是全勾的老数据"，不动用户手改过的：用户真去设置里逐模型调过之后，
 * 那份勾选是他自己定的，不该被覆盖。判据是"三模态齐全且没有 vision"——这正是老版本的写法。
 */
function healPlatformModalities(m: ModelCfg): ModelCfg {
  const isLegacyAllOn =
    m.input.includes('text') && m.input.includes('image') && m.input.includes('video') && !m.input.includes('vision')
  if (!isLegacyAllOn) return m
  const looksVision = VISION_MODEL_RE.test(m.id + ' ' + (m.name ?? ''))
  return { ...m, input: looksVision ? ['text', 'image', 'vision'] : ['text'] }
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

/**
 * 只改「全局访问权限档位」并落盘——**不重启内核**。
 *
 * 同 setMobileEnabled 的理由：拨档位只是改一个数，走 saveSettings 会让内核白重启一次，
 * 正在跑的任务直接断掉。档位真正生效需要内核重载配置（permission 是启动时读的），
 * 由界面侧显式确认后再走一次保存即可。
 *
 * 权限是**全局一份、对所有文件夹生效**，所以这里不需要任何路径参数。
 */
export function setAccess(level: AccessLevel): Settings {
  const s = loadSettings()
  s.access = normalizeAccess(level)
  mkdirSync(storeDir(), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(normalize(s), null, 2))
  return s
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

/**
 * 「调用其他模型」授权闸门的端点端口 —— 复用面板那个本地控制端点（同一个 127.0.0.1 服务，
 * 另外挂了 `/qn/authorize` 与 `/qn/model-used` 两条路由），不额外起服务。
 *
 * 只有会调用**别的模型**的 MCP 需要它：识图 / 生图 / 生视频 / 配音 / 音乐 / 听写。
 * 面板这种不调模型的不用注入（注了也无害，但没必要）。
 */
function gateEnv(): Record<string, string> {
  return panelMcp ? { QN_GATE_PORT: String(panelMcp.port) } : {}
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
/** 音乐生成 MCP（generate_music / check_music 工具）脚本路径 */
let musicMcp: { path: string } | undefined
export function setMusicMcp(v: { path: string }): void {
  musicMcp = v
}
/** 语音识别 MCP（transcribe_audio 听写工具）脚本路径 */
let asrMcp: { path: string } | undefined
export function setAsrMcp(v: { path: string }): void {
  asrMcp = v
}

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
 * 识图目标清单：能被派去「代看」的视觉模型。
 *
 * 三级优先（前面的更可信，vision MCP 与 screen MCP 都按这个顺序试）：
 *  1. **显式勾了「视觉」** —— 用户亲手标注这个模型能代看画面，最可信，排最前。
 *     平台内置模型也纳入这一档（勾选是用户在本机做的，比按名字猜准）；
 *  2. **勾了「图片」输入的第三方模型** —— 能读图，通常也能代看，但用户勾它本意是"我能发图给它"，
 *     不一定是让它当眼睛，所以排在显式「视觉」之后；
 *  3. 按模型名猜（VISION_MODEL_RE）：留给没勾过的老配置，以及平台清单里那些名字就写着 vl/vision 的。
 */
function collectVisionTargets(
  s: Settings
): { id: string; label: string; baseURL: string; apiKey: string; model: string }[] {
  const explicit: { id: string; label: string; baseURL: string; apiKey: string; model: string }[] = []
  const flagged: { id: string; label: string; baseURL: string; apiKey: string; model: string }[] = []
  const guessed: { id: string; label: string; baseURL: string; apiKey: string; model: string }[] = []
  for (const p of usableProviders(s)) {
    if (!p.apiKey.trim() || !p.baseURL.trim()) continue
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
      const input = m.input ?? []
      if (input.includes('vision')) explicit.push(item)
      else if (input.includes('image')) flagged.push(item)
      else if (VISION_MODEL_RE.test(m.id + ' ' + label)) guessed.push(item)
    }
  }
  return [...explicit, ...flagged, ...guessed]
}

/**
 * 内核 agent 工具（bash/shell）用的 shell：
 *
 * **必须固定成 Git Bash，绝不走内核默认**——内核在 Windows 上的默认探测顺序是
 * pwsh → powershell → git bash → cmd（对内核二进制的 EU() 实测），不写 shell 配置时
 * AI 执行命令会弹出可见的 PowerShell 控制台窗口（用户实测跑 `npm run dev` 时弹窗、拖慢系统）。
 *
 * 解析全部走环境（不写死盘符路径，mac 等平台同规则）：
 * - Windows：先认 OPENCODE_GIT_BASH_PATH（内核同款环境变量，用户可自行覆盖），
 *   再沿 PATH 找 git.exe 反推 ..\..\bin\bash.exe（与内核解析逻辑一致，只认带 git.exe 的
 *   目录防误吞 System32 的 WSL bash），最后扫常见安装位置。
 * - macOS / Linux：给 short name "bash"，内核按 PATH 解析（macOS 自带 /bin/bash，Linux 发行版各异，
 *   让内核用它在 PATH 里找到的那个）。
 * - Windows 上一路找不到（罕见）返回 undefined 走内核默认。
 */
function agentShell(): string | undefined {
  if (process.platform !== 'win32') return 'bash'
  const gitBashEnv = process.env['OPENCODE_GIT_BASH_PATH']
  if (gitBashEnv && existsSync(gitBashEnv)) return gitBashEnv
  const bashBesideGit = (gitExe: string): string | undefined => {
    // git.exe 在 <root>\cmd 或 <root>\mingw64\bin → bash.exe 在 <root>\bin
    const candidate = join(gitExe, '..', '..', 'bin', 'bash.exe')
    return existsSync(candidate) ? candidate : undefined
  }
  for (const dir of (process.env['PATH'] ?? '').split(';')) {
    const d = dir.trim()
    if (!d) continue
    const gitExe = join(d, 'git.exe')
    if (existsSync(gitExe)) {
      const hit = bashBesideGit(gitExe) ?? (existsSync(join(d, 'bash.exe')) ? join(d, 'bash.exe') : undefined)
      if (hit) return hit
    }
  }
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Programs'),
    process.env['USERPROFILE'] && join(process.env['USERPROFILE'], 'scoop', 'apps', 'git', 'current')
  ].filter((x): x is string => Boolean(x))
  for (const root of roots) {
    const hit = bashBesideGit(join(root, 'Git', 'cmd', 'git.exe'))
    if (hit) return hit
  }
  return undefined
}

/**
 * 生成内核配置：自定义提供商（OpenAI Chat 兼容，经 @ai-sdk/openai-compatible）+ MCP（含内置浏览器）。
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
      //
      // 输入模态必须按 MODALITIES 白名单过滤：设置里多出来的 'vision' 是本机能力标记
      // （挑代看目标用），内核不认这个词，原样写进 modalities.input 会被判配置非法。
      models: Object.fromEntries(
        p.models.map((m) => [
          m.id,
          {
            ...(m.name ? { name: m.name } : {}),
            limit: { context: m.context, output: m.output },
            modalities: {
              input: MODALITIES.filter((x) => (m.input ?? []).includes(x)),
              output: ['text']
            },
            variants: THINK_VARIANTS
          }
        ])
      )
    }
  }
  const mcp: Record<string, unknown> = {}
  // 内置浏览器是应用自身的一部分（右侧面板里的 webview），永远挂上、不受设置开关控制
  // （要停得改这份配置本身）。
  if (panelMcp) {
    // 内置浏览器 = 右侧面板里的 webview：AI 与用户看同一个浏览器（登录态共享），
    // 靠元素 ref 定位点击/输入，不依赖模型支持图片。playwright 独立浏览器已由它取代。
    mcp.panel = {
      type: 'local',
      command: ['node', panelMcp.path, String(panelMcp.port)],
      enabled: true
    }
  }
  // 生成类模型（生图 / 生视频 / 语音）都不走对话接口，逐个角色挑出目标挂成工具，对话模型靠它们出片出声
  // 生成角色由用户在模型配置里显式选（ModelCfg.gen），没选过的按模型名判——见 types.ts genRoleOf
  //
  // 注意是**从全部启用的提供商里挑**（usableProviders 返回的是平台内置 + 所有第三方，不是「当前分组」）：
  // 用户把生图模型配在 A 家、对话模型选 B 家是常态，只认当前组会直接找不到可用目标。
  // 候选顺序：平台内置在前（usableProviders 的排列），第三方按用户在设置里的拖拽顺序——同角色多个时取第一个。
  const pick = (role: 'image' | 'video' | 'tts' | 'music' | 'asr') =>
    usableProviders(s).flatMap((p) =>
      p.apiKey.trim() && p.baseURL.trim()
        ? p.models
            .filter((m) => genRoleOf(m) === role)
            .map((m) => ({
              id: `${p.id}/${m.id}`,
              label: m.name || m.id,
              // 提供方展示名：工具回执里写「生图由 agnes 提供」这类说明要用它（id 是给机器看的技术串）
              provider: p.name || p.id,
              baseURL: p.baseURL.trim().replace(/\/+$/, ''),
              apiKey: p.apiKey.trim(),
              model: m.id
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
        environment: { QN_TTS_TARGETS: JSON.stringify(ttsTargets), QN_MEDIA_DIR: join(storeDir(), 'media'), ...gateEnv() },
        timeout: 180000,
        enabled: true
      }
    }
  }
  // 音乐生成：与生视频同属「异步任务 + 轮询」形态，工具拆成 generate_music / check_music 两步
  if (musicMcp) {
    const musicTargets = pick('music')
    if (musicTargets.length) {
      mcp.music = {
        type: 'local',
        command: ['node', musicMcp.path],
        environment: { QN_MUSIC_TARGETS: JSON.stringify(musicTargets), QN_MEDIA_DIR: join(storeDir(), 'media') },
        // 一首歌数十秒到几分钟，单次 generate 只提交，但请求体可能含几十兆的参考音频，超时给宽些
        timeout: 300000,
        enabled: true
      }
    }
  }
  // 语音识别（听写）：一次提交整段音频、SSE 边识别边推，长音频可能要跑几分钟
  if (asrMcp) {
    const asrTargets = pick('asr')
    if (asrTargets.length) {
      mcp.asr = {
        type: 'local',
        command: ['node', asrMcp.path],
        environment: { QN_ASR_TARGETS: JSON.stringify(asrTargets), ...gateEnv() },
        // 一小时音频约 2.8 元，长会议转写要几分钟，默认 5s 超时必被掐
        timeout: 600000,
        enabled: true
      }
    }
  }
  // 识图：对话模型不支持 image 输入时，内核不会把图放进上下文，只剩一行 [Attached image/png: 路径]。
  // 挂一个视觉模型当「代看」——describe_image 读那个路径问视觉模型，把答案交还给对话模型。
  const visionTargets = collectVisionTargets(s)
  if (visionMcp && visionTargets.length) {
    mcp.vision = {
      type: 'local',
      command: ['node', visionMcp.path],
      environment: {
        QN_VISION_TARGETS: JSON.stringify(visionTargets),
        QN_MEDIA_DIR: join(storeDir(), 'media'),
        ...gateEnv()
      },
      // 识图几秒到几十秒（大图更久），默认 5s 超时必被掐
      timeout: 120000,
      enabled: true
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
  // 内置浏览器常驻，工具路由约定围绕它展开
  const instructions: string[] = []
  const routing = join(opencodeConfigDir(), 'qingniao-tools.md')
  writeFileSync(
    routing,
    '# 工具路由约定\n' +
      '- 「打开网页 / 打开链接 / 上网 / 操作浏览器」一律用青鸟窗口右侧的内置浏览器（`panel_*` 工具）：' +
      '它与用户看同一个浏览器、登录态共享，靠元素 ref 定位点击/输入，不需要截屏。**本回复里给出的 URL 要打开时同样走 panel_*。**\n' +
      '- **面板的显示与隐藏由用户控制，你调用 `panel_*` 不会把浏览器面板弹出来**（页面照样在后台加载、元素照样能操作）。' +
      '所以用 `panel_navigate` 打开页面后，要在回复里说一句「已在内置浏览器打开 XX，点窗口右上角的浏览器按钮可查看」，' +
      '否则用户看不到任何变化，会以为你没打开。\n' +
      '- **网页内容一律用 `panel_snapshot` 读（文本元素清单 + 标题），严禁为了「看看打开没有 / 页面长什么样」去桌面截屏**：' +
      '截屏要移动鼠标、等画面、还要求当前模型支持图片输入，比 snapshot 慢一个数量级，而且面板页面本来就能直接读到结构。\n' +
      // 用户实测过的典型事故：一条「打开我的邀请」的任务里，模型看不到「地址不存在」的反馈，
      // 于是连猜 /account/referral、/my/invite、/account/friend… 十几个地址，53 次调用没做完。
      '- **要进站点的某个页面时，不要靠猜地址**：`panel_snapshot` 清单里 a 标签后 `→ /path` 就是站点给出的**真实地址**，点它的 `ref` 进去。' +
      '只有你已经确知完整地址时才用 `panel_navigate`——**不要靠拼 `/invite`、`/my/xxx` 这类路径试探站点有没有那个页面**。\n' +
      '  `panel_navigate` 回执里出现「导航没有生效」「页面上没有任何可交互元素」就是在告诉你**这个地址不存在**：' +
      '**绝对不要换一个近似地址接着试**，立刻 `panel_snapshot` 找真实入口；页面上确实没有这个入口，就**停下来如实告诉用户「没找到 XX 入口」，并说明你试过哪些地址**。\n' +
      '- **不要拿识图工具（`vision_describe_image`）去「看」你自己刚生成 / 刚拿到的图片**：生图回执里已经给了提示词与本地路径；' +
      '也不要凭空编造路径（例如工作目录下的 `image.png`）让它去读——识图只用于**用户发来的附件**。\n' +
      '- **工具名要写全名**（内核注册时会拼上服务名前缀，清单里的名字就是全名）：' +
      '内置浏览器 = `panel_navigate` / `panel_snapshot` / `panel_click` / `panel_type`，识图 = `vision_describe_image`。' +
      '**写裸名（少前缀等）会报「工具不存在」**，只能照清单里的全名调。\n' +
      '- **没有桌面控制能力**：遇到「打开某个应用 / 在桌面上操作 / 帮我点一下微信」这类要求，' +
      '直接如实说明「青鸟目前不支持操控桌面应用」；**不要试图用 `bash` 跑 PowerShell / pyautogui 模拟键鼠来绕过**——' +
      '这类脚本看不见画面、不会等待界面就绪，只会把东西打进错误的地方。`bash` 只允许用来「启动一个进程」。\n' +
      '- **执行命令一律用 bash（Git Bash）语法**：路径用正斜杠、环境变量用 `export`/`$VAR`。' +
      '**严禁调用 powershell / pwsh / powershell.exe / pwsh.exe（含 `cmd /c` 转调），严禁写 PowerShell 语法' +
      '（`$env:`、`Get-Content`、`Write-Host`、`-ErrorAction` 之类）**——那会在用户桌面上弹出 PowerShell 窗口，明确违反用户要求。'
  )
  instructions.push(routing)
  // 文件系统边界（2026-09-24 用户要求）：青鸟自身数据只放 ~/.qingniaoai，项目操作不越界。
  // 单独一份指令文件而不是塞进路由约定——它管的是「能在哪儿写文件」，与工具路由是两回事。
  const boundary = join(opencodeConfigDir(), 'qingniao-boundary.md')
  writeFileSync(
    boundary,
    '# 文件系统边界\n' +
      '- 青鸟应用自身的一切数据（配置、会话、生成的图片 / 视频 / 音频、内置「任务」目录）只存在 `~/.qingniaoai` 之下，**不要在用户家目录新建任何别的目录**。\n' +
      '- **除当前项目目录和 `~/.qingniaoai` 之外，不要在任何位置创建 / 修改 / 删除文件或文件夹**：\n' +
      '  产物默认放当前项目目录；当前没有具体项目（内置「任务」）时放 `~/.qingniaoai/workspace`。\n' +
      '- 在项目里干活时**只处理当前项目内的文件**；确需写到别的目录，先停下来问用户、拿到明确指定的路径再动手。\n'
  )
  instructions.push(boundary)
  /**
   * 工具路由约定（常驻指令）：模型看不到图片画面、或没意识到有生图工具时，光靠工具 description 里的
   * 触发条件基本不会调工具——实测它会直接回「我看不了图片」、或改用写代码的方式画图。这块把规则写进
   * 内核指令，重启内核即生效，不依赖渲染层改动（渲染层那次注入仍保留，它额外带上本轮附件的具体路径）。
   */
  if (mcp.vision || mcp.media || mcp.tts || mcp.music || mcp.asr) {
    const attach = join(opencodeConfigDir(), 'qingniao-attach.md')
    const lines = [
      '# 图片 / 视频 / 音频处理约定',
      '- 用户消息里出现 `[Attached image/png: 路径]`、`[Attached audio/mpeg: 路径]` 这类占位文本，说明**你拿不到该素材的内容**。',
      '  此时严禁回答「我看不了图片 / 我听不了音频 / 请你描述一下」，也**严禁反问用户「要不要我识别一下」「需要我处理吗」**——' +
        '用户把素材发出来就是要你处理，**直接调用下面对应的工具**，把占位里的路径**原样**填进参数（不要改成文件名，不要自己编造路径）。'
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
        '- 生图/生视频成功后：结果原样转达，展示一律内嵌本地文件——`![图片](本地路径)` 或 `![视频](本地路径)`，另起一行用反引号给出该路径；远程 URL 可能过期，不要当媒体地址贴出来。',
        '- **失败就停，绝不重试**：`generate_image` / `create_video` / `check_video` 返回失败时（尤其 429 限流、' +
          '额度不足、鉴权失败、连接失败），**立刻停手**，把错误原样转告用户并说明稍后或恢复额度后再试。' +
          '**不要**换提示词、换参数、换模型重试，也不要「再试一次看看」、不要重新创建同一个视频任务——' +
          '这类错误与请求内容无关，重试只会一直失败。系统对这类错误做了熔断，重复调用会被直接拒绝，' +
          '连续失败还会自动中止本轮（用户会看到「已自动停止」）。',
        '- **成果归属要说清**：工具回执里带了「生图由 X 提供 / 生视频由 X 提供」，转达时必须把这句一起说给用户（如「生图由 agnes 提供」）——' +
          '用户常常在这家聊天、用别家出图，不说他就不知道成品是谁家出的。'
      )
    }
    if (mcp.tts)
      lines.push(
        '- 用户要**配音 / 朗读这段 / 念出来 / 生成语音 / 做成音频 / 换个音色读**→ 必须调 `generate_speech`：' +
          '要念的正文放 text（别把风格要求混进去），语气情绪语速放 style，音色放 voice（不确定就不填，用默认音色）。' +
          '严禁回答「我不能生成音频」，也严禁改用写代码合成波形的方式硬凑。',
        '- 若本轮**没有** `generate_speech` 工具（说明当前没配语音模型），直接如实说明「需先在设置里配置一个语音合成模型」，不要假装出音频。',
        '- 语音成功后：本地路径原样转达（另起一行用反引号包住），并直接用 `![音频](本地路径)` 内嵌——客户端会渲染成播放器试听。' +
          '同时把回执里的「配音由 X 提供」一并说给用户。'
      )
    if (mcp.music)
      lines.push(
        '- 用户要**生成音乐 / 写首歌 / 做 BGM / 配背景音乐 / 翻唱 / 给清唱配伴奏**→ 必须调 `generate_music`：' +
          '风格描述放 prompt，歌词放 lyrics（[Verse]/[Chorus] 等标签独占一行），' +
          'mode 选 song（歌曲）/ instrumental（纯器乐）/ cover（翻唱）/ vocal_to_music（干声配伴奏），' +
          '参考歌曲或干声放 reference。严禁回答「我不会作曲」，也严禁改用写代码合成波形的方式硬凑。',
        '- **音乐是异步长任务**：`generate_music` 只返回 task_id，不会等出曲。拿到后先告知用户「音乐生成中」，' +
          '随后反复调 `check_music`（每次内部已静默等约 15 秒，返回「还在生成中」就立即再查），' +
          '两次之间用一句话向用户播报进度。完成或失败都要原样转达。',
        '- 若本轮**没有** `generate_music` 工具（说明当前没配音乐模型），直接如实说明「需先在设置里配置一个音乐生成模型」。',
        '- 音乐成功后：本地路径原样转达（另起一行用反引号包住），并直接用 `![音频](本地路径)` 内嵌试听；' +
          '同时把回执里的「音乐由 X 提供」一并说给用户。'
      )
    if (mcp.asr)
      lines.push(
        '- 用户要**把录音/音频转成文字**（听写、转录、会议纪要、生成字幕、「这段音频说了什么」）→ 必须调 `transcribe_audio`：' +
          '音频路径放 audio（用户上传的附件把 `[Attached audio/mpeg: 路径]` 里的路径原样填进去），' +
          '人名/地名/专有名词等易错词放 hotwords 能明显提升准确率。' +
          '严禁回答「我听不了音频」，也严禁靠猜内容编造转录结果。',
        '- 若本轮**没有** `transcribe_audio` 工具（说明当前没配语音识别模型），直接如实说明「需先在设置里配置一个语音识别模型」。',
        '- **转录结果要把识别出的正文完整原样给用户**（用户要的就是这段文字）：不要自己总结、改写或节选，除非用户另外要求。' +
          '同时把回执里的「识别由 X 提供」一并说给用户。'
      )
    lines.push(
      '- 分不清意图时按上述顺序判断：先问内容 → describe_image；要求改画面 → generate_image；' +
        '要听见文字 → transcribe_audio；要音乐 → generate_music；要念出来的声音 → generate_speech。'
    )
    writeFileSync(attach, lines.join('\n') + '\n')
    instructions.push(attach)
  }
  const shell = agentShell()
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    // AI 执行命令固定走 Git Bash（找不到才回落内核默认），根绝 PowerShell 弹窗——见 agentShell 注释
    ...(shell ? { shell } : {}),
    provider,
    mcp,
    /**
     * 访问权限：**全局一档，对所有文件夹生效**（见 types.ts AccessLevel）。
     *
     * 内核的 permission 配置在**启动时一次性读入**，所以切档位必须重启内核才生效——
     * 界面侧的切换提示与 saveSettings 的「保存并重启内核」流程已经覆盖这一点。
     *
     * 早先按「每个项目目录各存一档、再取最严的那档」来做，属于绕远路：内核本来就只有
     * 一份全局 permission，按目录存既做不到真正的分目录，又让「现在到底是什么档位」
     * 变得需要推演。现在直接是用户选的那一档。
     */
    permission: permissionCfgFor(s.access),
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
