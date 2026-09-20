/** 主进程与渲染层共享的设置类型（无 node 依赖，可在两侧 import） */

/** 模型输入类型（内核 modalities.input 的可选值，输出固定为文本） */
export type Modality = 'text' | 'image' | 'video'

export const MODALITIES: Modality[] = ['text', 'image', 'video']

/**
 * 新模型的默认接入参数：上下文窗口 100 万、最大输出 128K、**输入只勾文本**。
 *
 * 图片/视频不默认勾：绝大多数模型（含大量号称多模态的）实际吃不了图，默认全勾会把
 * 伪视觉模型灌进识图 MCP 的目标清单（靠 NO_IMAGE 逐试兜底，白白浪费一轮），
 * 也会让内核误以为模型能读图。真支持的需要用户在该模型上显式勾一次，勾选即生效。
 * 生成类模型不受影响：生图/生视频/识图目标另按模型的生成角色（见 GenKind）挑，不依赖这个勾选。
 */
export const MODEL_DEFAULTS = { context: 1_000_000, output: 128_000, input: ['text'] as Modality[] }

/** 单个模型的思考形态（用户在配置里为该模型自己选，替代旧的自动探测）。
 *  - 'off'：不支持思考，输入框思考选择器禁用；
 *  - 'toggle'：只有「关闭 / 开启」，思考默认开启；
 *  - 'low' | 'medium' | 'high'：固定档位，选择器给「低 / 中 / 高」，默认就是这一档。
 *  缺省（undefined）按 'toggle' 处理：思考默认开启，用户在「关 / 开」之间切。 */
export type ThinkingMode = 'off' | 'toggle' | 'low' | 'medium' | 'high'

/**
 * 模型的生成角色（设置里逐模型显式选）。
 *
 * 生图/生视频/语音模型不走普通 chat 接口（只认 /images/generations、异步 /videos、/audio/speech），
 * 当对话模型用必被拒，主进程据此把它们挂进生成工具的目标清单、并从识图清单里排除。
 *  - 'auto'（含未设置）：按模型名判，等价于旧行为；
 *  - 'image' | 'video' | 'tts'：强制认作生图 / 生视频 / 语音合成模型（seedream、即梦这类名字认不出的靠它）；
 *  - 'none'：强制按对话模型处理，名字像生图也不拿去出图。
 */
export type GenKind = 'auto' | 'image' | 'video' | 'tts' | 'none'
/** 判定结果：'none' = 普通对话模型 */
export type GenRole = Exclude<GenKind, 'auto'>

/** 纯生图模型的命名特征：这类模型只认 /images/generations，发 chat 必被拒，由生图工具代劳 */
export const IMAGE_MODEL_RE = /(^|[-_.])(image|img|dall[-_.]?e?|flux|stable[-_.]?diffusion|sdxl)/i
/** 生视频模型同理，只认异步 /videos 任务接口 */
export const VIDEO_MODEL_RE = /(^|[-_.])(video|sora|kling|veo|wan)/i
/**
 * 语音合成模型：tts / 配音 / 音色复刻那类命名。
 * 'speech' 单列在备选里而非合并进前缀类：asr（识别）也常带 speech，会把听写模型错挂成合成目标。
 */
export const TTS_MODEL_RE = /(^|[-_.])(tts|text[-_.]?to[-_.]?speech|voice[-_.]?clone|cosyvoice|sambert|speech[-_.]?synth)/i

/** 这个模型到底算生图、生视频、语音合成还是对话：用户在配置里显式选过的为准，'auto'/未设置按名字判 */
export function genRoleOf(m: { id: string; gen?: GenKind }): GenRole {
  if (m.gen === 'image' || m.gen === 'video' || m.gen === 'tts' || m.gen === 'none') return m.gen
  if (TTS_MODEL_RE.test(m.id)) return 'tts'
  if (IMAGE_MODEL_RE.test(m.id)) return 'image'
  if (VIDEO_MODEL_RE.test(m.id)) return 'video'
  return 'none'
}

/** 单个模型的接入参数，写入内核 opencode.json 的 limit / modalities */
export interface ModelCfg {
  /** 模型 ID（provider.models 的键，如 deepseek-chat） */
  id: string
  /** 展示名称（可选）。平台模型对外 ID 是 qn-xxx，靠它给用户看人话 */
  name?: string
  /** 上下文窗口（token） */
  context: number
  /** 最大输出（token） */
  output: number
  /** 输入类型 */
  input: Modality[]
  /** 生成角色（见 GenKind）；undefined / 'auto' = 按模型名判 */
  gen?: GenKind
  /** 思考形态（见 ThinkingMode）；undefined = 默认「关闭/开启」 */
  thinking?: ThinkingMode
  /**
   * 以下四个只有「平台内置模型」有（登录时随模型清单下发），第三方 provider 的模型恒为 undefined。
   * 它们只影响展示：选择器里在模型名后打「限免 / 折扣」标签，最右侧写明倍率。
   */
  /** 限免：活动期内这个模型不扣积分（倍率按 0 算） */
  free?: boolean
  /** 折扣倍率（0.01–0.99，显示成 0.2x）；null = 不打折 */
  discount?: number | null
  /** 原价倍率（常见是 1） */
  ratio?: number
  /** 实际扣费倍率：限免为 0，打折已乘折扣 */
  effRatio?: number
  /**
   * 平台官方提供（后台模型列表里那一列「内置」）。
   *
   * 对话区的「内置模型」分组只收内置的：后台为适配各家上游会挂一批
   * 同名第三方模型（builtin=false），它们不该混进「内置」里让人以为都是平台官方的。
   */
  builtin?: boolean
}

/**
 * 这个模型算不算「内置」。
 *
 * 字段缺失时按「是」算：老平台不下发 builtin、或首次同步失败沿用了旧缓存时，
 * 宁可多显示几个，也不能让人一个模型都选不到（同步成功后会落成明确的 true/false）。
 */
export function isBuiltinModel(m: { builtin?: boolean }): boolean {
  return m.builtin !== false
}

export interface ProviderCfg {
  id: string
  name: string
  baseURL: string
  apiKey: string
  enabled: boolean
  models: ModelCfg[]
  /**
   * 生视频任务查询地址模板（可选），占位符 {video_id} / {model} / {baseURL} / {origin}。
   *
   * 创建任务各家都是 POST {baseURL}/videos，但查询进度没有统一约定：agnes 在 {origin}/agnesapi，
   * OpenAI 兼容端点在 {baseURL}/videos/{video_id}。留空时生视频工具按这两种依次试并记住命中的那个，
   * 只有两种都不对的提供商才需要手工填这一条。
   */
  videoPoll?: string
}

/** 自定义 MCP 服务器（local 用 command，remote 用 url） */
export interface McpCfg {
  name: string
  type: 'local' | 'remote'
  /** local：完整命令行（含参数），设置里按空格输入 */
  command: string
  /** remote：MCP 服务地址 */
  url: string
  enabled: boolean
}

/**
 * 这台电脑在平台侧登记的设备身份。
 *
 * 目的只有一个：让二维码里的地址是「平台域名 + 每台电脑唯一的 token」，
 * 而不是一个裸 IP —— 裸 IP 谁拿到都能打开，token 泄露了换一张码就作废。
 */
export interface DeviceCfg {
  id: number
  name: string
  /** 二维码里的那串（64 位随机），泄露即换 */
  token: string
  /** 向平台认领指令用的凭证，二维码里不带它 */
  secret: string
  /** 二维码内容 = 平台地址 + /ide/device/{token} */
  url: string
}

/**
 * 平台（青鸟服务端）登录态。
 *
 * 平台地址只此一处：登录入口、IDE 网关 baseURL、退出登录全都读它，
 * 以后上线换域名只改这一个值（或用环境变量 QINGNIAO_PLATFORM_URL 覆盖，便于临时切环境）。
 */
export interface PlatformCfg {
  /** 平台地址，如 http://127.0.0.1:9002 */
  baseUrl: string
  /** 登录换来的长期授权 token（10 年有效，可在平台后台吊销） */
  token: string
  /** 登录用户（未登录为 null） */
  user: { id: number; name: string; email?: string } | null
  /** 平台对外提供的模型清单（登录/同步时从平台拉取） */
  models: ModelCfg[]
  /** 上次同步模型清单的时间戳 */
  syncedAt?: number
  /** 本机在平台侧的设备身份（移动端中转用；未注册为 null） */
  device: DeviceCfg | null
}

export interface Settings {
  providers: ProviderCfg[]
  mcps: McpCfg[]
  /**
   * 全局总开关：是否启用「远程服务」（平台账号那套），只改全局配置文件，不在设置界面里。
   *
   * 关（默认）＝ 这些入口在界面上整块消失，青鸟退回「只用本机自配的模型提供商」，
   * 也不再向平台发任何请求。企业内网、纯离线环境的默认部署形态；要打开需手动改配置。
   * 开 ＝ 登录、内置模型、积分与用量、手机扫码操作这台电脑全都可用。
   */
  remote: boolean
  /** 允许移动端连接本机：开则手机扫码后能操作这台电脑（默认关闭） */
  mobile: boolean
  /** 平台登录态（第三方 provider 与它并存，不互相影响） */
  platform: PlatformCfg
}

export const DEFAULT_PLATFORM_URL = 'http://127.0.0.1:9002'

export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  mcps: [],
  remote: false,
  mobile: false,
  platform: { baseUrl: DEFAULT_PLATFORM_URL, token: '', user: null, models: [], device: null }
}

/** 平台状态（渲染层左下角登录入口用） */
export interface PlatformStatus {
  /** 当前生效的平台地址（含环境变量覆盖） */
  baseUrl: string
  /** 登录页地址（浏览器直接可开） */
  loginUrl: string
  loggedIn: boolean
  user: { id: number; name: string; email?: string } | null
  /** 平台可用模型数量 */
  models: number
  syncedAt?: number
  /** 上次同步/登录失败的原因 */
  error?: string
}

/** 技能作用域：全局（~/.qingniaoai/opencode/skills）或当前项目（<项目>/.opencode/skills） */
export type SkillScope = 'global' | 'project'
/** 一条技能 = 一个含 SKILL.md 的目录（内核按目录名识别技能名） */
export interface SkillItem {
  /** 目录名，也是内核识别的技能名 */
  name: string
  scope: SkillScope
  /** SKILL.md 的绝对路径 */
  path: string
  /** 模型据此判断何时加载该技能 */
  description: string
  /** frontmatter 校验失败的原因；合法时为 undefined */
  error?: string
  /** 青鸟内置技能（随安装包分发、同步到全局目录，未被用户修改过时为 true） */
  builtin?: boolean
}

export interface SkillDraft {
  scope: SkillScope
  /** project 作用域必填：技能所属项目的绝对路径 */
  projectPath?: string | null
  /** 编辑已有技能时的原目录名；新建时留空（用于重命名时清理旧目录） */
  originalName?: string
  name: string
  description: string
  /** frontmatter 之后的正文 */
  body: string
}

/** 移动端接入状态（渲染层左栏手机面板直接用） */
export interface DeskStatus {
  /** 允许手机连接这台电脑（面板上那个开关）。关掉只断准入，设备身份与二维码保留 */
  enabled: boolean
  /** 是否已登录平台：没登录就没有设备身份，也就没有二维码 */
  loggedIn: boolean
  /** 平台账号名（面板里说明是谁在连） */
  user?: string
  /** 这台电脑在平台侧的设备名 */
  device?: string
  /** 二维码内容：{平台域名}/ide/device/{token}，手机扫码即用 */
  url: string
  /** 二维码点阵：size × size 的 0/1 数组，渲染层自己画 SVG（CSP 不许加载跨源图片） */
  qr: { size: number; rows: number[][] } | null
  /** 中转通道是否在跑：跑着手机才连得上（面板「在线」指示） */
  running: boolean
  /**
   * 真的有没有手机连着（不是「开关开着」）。
   *
   * 桌面端每轮认领指令时从平台顺手带回：平台记的是手机自己最后一次请求的时间。
   * 左栏手机图标上的绿点只认它——开关开着但没人扫码时不该亮绿点。
   */
  mobileConnected: boolean
  /** 出错原因（未登录、注册设备失败、平台不可达…） */
  error?: string
}

/** 一组用量数字：调用次数 / token 量 / 扣掉的积分 */
export interface UsageBucket {
  calls: number
  tokens: number
  points: number
}

/** 一条分组明细（按天或按模型） */
export interface UsageRow extends UsageBucket {
  label: string
}

/**
 * 趋势折线图的数据：一条线 = 一个模型。
 *
 * dates 是区间内**每一天**（含没数据的天，补 0），models[].points 与它一一对应——
 * 只有补齐了横轴，线才是连续的，不会把两段数据之间空着的几天连成一条斜线。
 */
export interface UsageSeries {
  /** 区间内每一天，YYYY-MM-DD，升序 */
  dates: string[]
  /** 按区间内 token 总量降序（与「各模型用量」同序，颜色与条形图一一对应） */
  models: { label: string; tokens: number; points: number[] }[]
}

/**
 * 用量汇总（设置 → 使用量）。
 *
 * 区间（from/to，默认最近 30 天）决定 range / days / models；
 * 今日、昨日、累计是固定口径，不随区间变化——用户看「今天用了多少」时不该被筛选器影响。
 */
export interface UsageSummary {
  from: string
  to: string
  /** 当前积分余额 */
  points: number
  /** 管理员不参与积分计费：界面把余额显示成「不限」（老平台不返回该字段则为 undefined） */
  exempt?: boolean
  range: UsageBucket
  today: UsageBucket
  yesterday: UsageBucket
  all: UsageBucket
  /** 按天升序（图表从左到右） */
  days: UsageRow[]
  /** 按模型降序（最费钱的排最前） */
  models: UsageRow[]
  /** 趋势折线图（按天 × 按模型）；老平台不返回该字段时为 undefined */
  series?: UsageSeries
}

/** 积分流水一条（发放 / 消耗 / 调整） */
export interface UsageLog {
  id: number
  change: number
  after: number
  type: string
  type_label: string
  remark: string | null
  created_at: string
}

/**
 * 分页信封（积分记录 / 每次消耗）：
 * 账本是越攒越长的列表，一次全塞给界面既慢又没法回看，故按页取。
 */
export interface UsagePage<T> {
  items: T[]
  /** 符合条件的总条数（不是当前页条数） */
  total: number
  page: number
  per_page: number
  pages: number
}

/** 一次调用的消耗明细 */
export interface UsageRecord {
  id: number
  model: string
  ratio: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  points: number
  created_at: string
}

/** 账号信息（设置 → 账号），来自平台 /api/ide/me */
export interface PlatformAccount {
  user: { id: number; name: string; email?: string }
  /** 当前这份授权（可在平台后台吊销） */
  token: { id?: number; name?: string; expires_at?: string | null }
  gateway: string
  /** 积分余额，与「使用量」里显示的同一个数 */
  points: number
  /** 管理员不参与积分计费：界面把余额显示成「不限」（老平台不返回该字段则为 undefined） */
  exempt?: boolean
  /** 本机设备名（平台侧登记的这台电脑，未注册为 undefined） */
  device?: string
}
