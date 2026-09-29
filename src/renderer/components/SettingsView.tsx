import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, BarChart3, Check, CircleUser, Cpu, Eye, EyeOff, FolderOpen, GripVertical, Globe, ImagePlus, Layers, Link2, LoaderCircle, Monitor, Palette, Pencil, Plus, RefreshCw, Rocket, Sparkles, Terminal, Trash2, type LucideIcon } from 'lucide-react'
import { Modal } from './Modal'
import { moveItem, useDragSort } from './useDragSort'
import { Switch } from './Switch'
import { UsagePanel } from './UsagePanel'
import { AccountPanel } from './AccountPanel'
import { UpdatePanel } from './UpdatePanel'
import { getThemeList, CUSTOM_ID, type ThemeBgCfg, type ThemeBgMode, type ThemeBgSlot } from '../theme'
import { LANGS, t, type Lang } from '../i18n'
import type { CustomColors } from '../themeColors'
import type { GenKind, GenRole, McpCfg, Modality, ModelCfg, PlatformStatus, ProviderCfg, SettingsCfg, SkillItem, SkillScope, ThinkingMode } from '../oc'
import { MODEL_DEFAULTS, MODEL_ROLE_LABEL, genRoleOf } from '../oc'
import type { ProjectSortMode, SettingsTab } from '../App'
import type { AccessLevel } from './Sidebar'
import { CODE_STYLES, CODE_STYLE_PREVIEWS, type CodeStyle } from '../codeStyle'

/**
 * 外部请求的定位（对话框里的「配置模型」等）。tick 自增是为了「用户本来就停在模型页」
 * 时再点一次也能重新定位——只靠 tab 值判别不出「又点了一次」。
 */
export interface SettingsReq {
  tab: SettingsTab
  tick: number
}

/**
 * 输入类型可选项（输出恒为文本，不对外暴露配置项）。
 *
 * 「图片」和「视觉」是两件事，tip 里必须讲清，否则用户会以为勾了「图片」就是"有视觉了"：
 *  - 图片：这个模型自己能把图读进上下文（发张图它能看懂）；
 *  - 视觉：这个模型能当"眼睛"替**别的**模型看画面（截图、图片交给它，它把内容写成文字），
 *    识图工具与电脑控制的视觉代看就是靠这个标记挑人。
 */
const MODALITY_LABELS: { key: Modality; label: string; tip?: string }[] = [
  { key: 'text', label: '文本', tip: '能吃文字消息——绝大多数模型都要勾，否则不能当对话模型用' },
  { key: 'image', label: '图片', tip: '这个模型自己能读图：用户发图片它能直接看懂内容' },
  { key: 'video', label: '视频', tip: '这个模型自己能看视频：用户发视频它能直接理解画面' },
  {
    key: 'vision',
    label: '视觉',
    tip: '这个模型能当"眼睛"替别的模型看画面：截图/图片交给它，它把看到的内容写成文字。用于识图工具与电脑控制（当前模型看不到屏幕时由它代看）'
  }
]

/** 模态键 → 当前语言的标签（键是 MODALITY_LABELS 里的简体标签） */
function modalityLabel(k: Modality): string {
  return t(MODALITY_LABELS.find((m) => m.key === k)?.label ?? k)
}

/** 每个模型的思考形态选项（输入框思考选择器据此给档位，缺省=关/开） */
const THINK_LABELS: { key: ThinkingMode; label: string; tip: string }[] = [
  { key: 'toggle', label: '关/开', tip: '默认：思考默认开启，你可在「关/开」之间切' },
  { key: 'low', label: '低', tip: '固定低档思考' },
  { key: 'medium', label: '中', tip: '固定中档思考' },
  { key: 'high', label: '高', tip: '固定高档思考' },
  { key: 'off', label: '不支持', tip: '禁用思考' }
]

interface Props {
  settings: SettingsCfg
  onSave: (s: SettingsCfg) => Promise<void>
  saving: boolean
  theme: string
  onTheme: (id: string) => void
  custom: CustomColors
  onCustom: (key: keyof CustomColors, value: string) => void
  onResetCustom: () => void
  /** 主题背景图（设置 → 通用 → 主题背景图）：整屏一张 / 左右分开 */
  themeBg: ThemeBgCfg
  /** 图片路径 → data URL（缩略图与切换即时预览用，App 统一解析缓存） */
  bgUrls: Record<string, string>
  onThemeBgPick: (slot: ThemeBgSlot) => void
  onThemeBgClear: (slot: ThemeBgSlot) => void
  onThemeBgMode: (mode: ThemeBgMode) => void
  codeStyle: CodeStyle
  onCodeStyle: (style: CodeStyle) => void
  normalChatWidth: number
  onNormalChatWidth: (width: number) => void
  projectSortMode: ProjectSortMode
  onProjectSortMode: (mode: ProjectSortMode) => void
  /** 对话左侧「-」用户消息导航锚点条显隐（默认不显示，通用页可开） */
  userAnchors: boolean
  onUserAnchors: (v: boolean) => void
  /** 拨全局访问权限档位（'default'/'full'）；切「完全控制」的二次确认由 App 负责 */
  onAccess: (level: AccessLevel) => void
  /** 界面语言（App 持有，切换后整棵树重渲染） */
  lang: Lang
  onLang: (l: Lang) => void
  /** 当前活动项目路径：项目级技能写在 <项目>/.opencode/skills 下（没有项目时该组不可用） */
  projectPath?: string | null
  projectName?: string | null
  /** 对话区当前所选模型（'pid/mid'，'' = 跟随内核默认）：桌面控制页用它判断有无视觉能力 */
  model: string
  /** 当前标签页由 App 持有：左栏账号入口要能直接跳到「账号」 */
  tab: SettingsTab
  onTab: (t: SettingsTab) => void
  /** 外部请求的定位（对话框「配置模型」等）：tick 变化即执行一次，见下方 effect */
  req: SettingsReq | null
  /** 平台登录态（账号 / 使用量两页共用） */
  platform: PlatformStatus | null
  platformBusy: boolean
  onLogin: () => void
  onLogout: () => void
  onSetBaseUrl: (url: string) => void
  onSubmitCode: (code: string) => void
}

/** 自定义主题可调的 4 个基础色：标签 + 变量键 */
const CUSTOM_FIELDS: { key: keyof CustomColors; label: string }[] = [
  { key: 'accent', label: '主色' },
  { key: 'bg', label: '窗体背景' },
  { key: 'fg', label: '正文文字' },
  { key: 'sideBg', label: '左侧面板底色' },
]

/** 主题背景图的单个槽位：标签 + 缩略图（整行可点 = 选择/更换，悬停整行浮起）。
 *  不做独立的「选择图片」按钮：点缩略图就是上传入口，已有图时角标提供更换/移除。 */
function BgSlot({ label, url, onPick, onClear }: { label: string; url: string; onPick: () => void; onClear: () => void }) {
  return (
    <div className={'bg-slot' + (url ? ' has-img' : '')}>
      <button type="button" className="bg-slot-main" onClick={onPick} title={url ? t('更换图片') : t('选择图片')}>
        <span className="bg-slot-preview">
          {url ? <img src={url} alt="" /> : <ImagePlus size={18} />}
        </span>
        <span className="bg-slot-text">{label}</span>
      </button>
      {url && (
        <button type="button" className="bg-slot-del" onClick={onClear} title={t('移除')}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

/** 设置页左侧导航：账号 / 通用 / 模型 / 技能 / MCP / 使用量 / 关于 */
type TabId = SettingsTab
const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  // 账号置顶：登录是「用上内置模型」的前提，放第一位最容易被找到
  { id: 'account', label: '账号', icon: CircleUser },
  { id: 'theme', label: '通用', icon: Palette },
  { id: 'providers', label: '模型', icon: Cpu },
  { id: 'skills', label: '技能', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Globe },
  // 使用量紧跟 MCP：两者都是"往外看"的信息（连了什么、花了多少）
  { id: 'usage', label: '使用量', icon: BarChart3 },
  // 关于排最末：它是「这个软件本身」的信息（版本、条款），不是要配置的东西，
  // 整页的收口，也最符合「关于」这个命名的直觉
  { id: 'about', label: '关于', icon: Rocket }
]

/** 依赖平台接口的页：关了远程服务就没有存在意义，连同导航一起收起。
 *  「使用量」不在此列——本机统计来自内核会话记录，不依赖平台，常驻显示 */
const REMOTE_TABS: TabId[] = ['account']

interface Draft {
  isNew: boolean
  index: number
  name: string
  id: string
  baseURL: string
  apiKey: string
  modelsText: string
  /** 每个模型已编辑过的接入参数（键=模型 ID）；没编辑过的模型用 MODEL_DEFAULTS */
  cfgs: Record<string, ModelCfg>
}

/**
 * 单个模型的编辑草稿（提供商弹窗内的二级弹窗）。
 *
 * 用独立草稿而不是直接改 draft.cfgs：用户在二级弹窗里点了「取消」要能整份丢掉，
 * 半途误改的上下文窗口/生成角色不能污染提供商表单。
 * input 存成副本，取消时原配置的数组引用不被就地改动。
 */
interface ModelForm {
  /** 编辑的是第几个模型（新增时等于 modelsText 解析后的长度，即追加到末尾） */
  index: number
  isNew: boolean
  id: string
  context: number
  output: number
  input: Modality[]
  thinking: ModelCfg['thinking']
  gen: GenKind
}

interface McpDraft {
  isNew: boolean
  index: number
  name: string
  type: 'local' | 'remote'
  command: string
  url: string
}

/** 技能编辑弹窗的草稿：frontmatter 与正文拆开编辑，保存时由主进程拼回 SKILL.md */
interface SkillForm {
  isNew: boolean
  scope: SkillScope
  /** 编辑已有技能时的原目录名；改名保存时主进程据此清掉旧目录 */
  originalName: string
  name: string
  description: string
  body: string
}

function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'provider-' + Date.now()
}

function parseModels(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((m) => m.trim()).filter(Boolean))]
}

/** 未单独编辑过的模型用默认接入参数（每次新拷贝，避免共享数组引用） */
function defaultModelCfg(): Omit<ModelCfg, 'id'> {
  return { context: MODEL_DEFAULTS.context, output: MODEL_DEFAULTS.output, input: [...MODEL_DEFAULTS.input], thinking: 'toggle' }
}

/** 每个模型的生成角色（写进 ModelCfg.gen）：'auto' 按模型名判，其余是用户显式指定 */
const GEN_LABELS: { key: GenKind; label: string; tip: string }[] = [
  { key: 'auto', label: '自动', tip: '按模型名判：名字带 image / video / tts / music / asr 等算生成模型' },
  { key: 'image', label: '图片', tip: '只认生图接口（文生图 /images/generations，改图 /images/edits），挂给生图工具，当对话模型用必被拒' },
  { key: 'video', label: '视频', tip: '只认异步 /videos 任务，挂给生视频工具，当对话模型用必被拒' },
  { key: 'tts', label: '语音', tip: '只认语音合成接口（/audio/speech，MiMo 那类走 chat 带 audio 参数），挂给配音工具，当对话模型用必被拒' },
  { key: 'music', label: '音乐', tip: '只认音乐生成接口（异步提交 + 轮询，如阶跃 stepaudio-3-music），挂给音乐工具，当对话模型用必被拒' },
  { key: 'asr', label: '识别', tip: '只认语音识别接口（音频转文字，如阶跃 stepaudio-3-asr-max），挂给听写工具，当对话模型用必被拒' },
  { key: 'none', label: '对话', tip: '强制按对话模型处理：名字像生图也不拿去出图' }
]

/**
 * 模板里全新模型的生成角色与输入类型。判定走主进程那份 genRoleOf（名字规则），
 * 这里只是把结果落成显式配置，让用户在表单里看得见、改得动。
 *
 * 「输入」指的是**它吃什么**，不是「它产出什么」——两者容易混，逐角色写清楚：
 *  - 生图 / 生视频：收文本提示词（改图另说），不勾「图片」那种模态语义，给纯文本最稳；
 *  - 语音合成（tts）：收要念的文本 → 文本；
 *  - 音乐生成（music）：收风格描述与歌词 → 文本；
 *  - 语音识别（asr）：收的是**音频**，但本机模态里没有 audio 这一项可勾，给纯文本占位即可，
 *    真正决定它去听写 MCP 的是 `gen` 这一列。
 * 「不能当对话模型用」一律由生成角色（gen）判定，见 ChatView.resolveChatModel。
 */
function presetModelPatch(id: string, input?: Modality[], gen?: GenKind): Pick<ModelCfg, 'gen' | 'input'> {
  // 模板显式指定的角色优先：用户打开编辑弹窗一眼就能看到「生成 = 语音」，
  // 不必去猜为什么它不出现在模型选择器里（名字规则认不出的模型更是只能靠这个）
  if (gen) return { gen, input: input ?? ['text'] }
  const role = genRoleOf({ id })
  if (role === 'none') return { gen: 'auto', input: input ?? [...MODEL_DEFAULTS.input] }
  // 五个生成角色都吃文本类入参（图片/视频那两个也靠 prompt 工作），统一给纯文本
  const genInput: Modality[] = ['text']
  return { gen: role, input: genInput }
}

/**
 * 已知的「旧存档 Base URL 已过时」修正表。
 *
 * 模板里改对地址救不了老用户——applyPreset 优先带出 cur.baseURL（用户自己的存档），
 * 于是写错的地址会一直留着。而有些地址不是「用户随手写错」，是**这家的端点分层变了**：
 * 阶跃的 step_plan/v1 是计划端点，只放通用对话与 2.5 系音频模型；
 * stepaudio-3-asr-max / stepaudio-3-tts / stepaudio-3-music-preview 全挂在通用端点 /v1，
 * 老存档停在计划端点就会一路 404「模型不存在」，用户只会看到「模型配错了」。
 *
 * 只在本家暂存地址恰好等于旧值时改写，用户手填的其他地址一律不动。
 */
const STALE_BASE_URL: Record<string, Record<string, string>> = {
  stepfun: { 'https://api.stepfun.com/step_plan/v1': 'https://api.stepfun.com/v1' }
}

/** 已存地址若命中修正表则返回新地址，否则原样返回 */
function freshBaseURL(pid: string, saved: string | undefined): string | undefined {
  if (!saved) return saved
  const fix = STALE_BASE_URL[pid]
  if (!fix) return saved
  return fix[saved.replace(/\/+$/, '')] ?? saved
}

/** 常用提供商快速模板；本机已有同 ID 提供商时优先带出现有配置（apiKey 永不模板化） */
const PROVIDER_PRESETS: {
  id: string
  name: string
  baseURL: string
  models: string[]
  /** 官方文档写明的输入模态（键=模型 ID）：模板里替用户勾好，否则桌面控制/识图/看视频用不上 */
  input?: Record<string, Modality[]>
  /**
   * 显式指定生成角色（键=模型 ID）：名字规则认不出来的靠它兜。
   * 名字里带 tts/image/video 的能自动认出，这里写出来只是让配置更明确、便于将来改名。
   */
  gen?: Record<string, GenKind>
}[] = [
  {
    id: 'agnes',
    name: 'agnes',
    baseURL: 'https://api.agnes-ai.cn/v1',
    models: ['agnes-3.0-flash', 'agnes-image-2.5-flash', 'agnes-video-2.5-flash']
  },
  {
    id: 'mimo',
    name: 'mimo',
    baseURL: 'https://api.xiaomimimo.com/v1',
    // mimo-v2.5 是原生全模态理解（图/视频/音频进、文本出），mimo-v2.5-tts 是语音合成。
    // 能读图的模型顺带勾上「视觉」：它本来就能看懂画面，也能当眼睛替别人代看。
    // tts 那个显式写进 gen：名字规则虽然也能认出（带 -tts），但写出来用户打开编辑就能看到
    // 「生成 = 语音」，不用自己去猜为什么它不出现在模型选择器里
    models: ['mimo-v2.5', 'mimo-v2.5-tts'],
    input: { 'mimo-v2.5': ['text', 'image', 'video', 'vision'], 'mimo-v2.5-tts': ['text'] },
    gen: { 'mimo-v2.5-tts': 'tts' }
  },
  {
    id: 'stepfun',
    name: 'stepfun',
    baseURL: 'https://api.stepfun.com/v1',
    // step-3.7-flash 对话（原生多模态）、step-image-edit-2 改图；
    // stepaudio-3-asr-max 语音识别、stepaudio-3-music-preview 音乐生成、stepaudio-3-tts 语音合成。
    // 后三个不走 chat 接口，靠生成角色分别挂到听写 / 音乐 / 配音工具（名字规则能自动认出，也可手动指定）
    models: [
      'step-3.7-flash',
      'step-image-edit-2',
      'stepaudio-3-asr-max',
      'stepaudio-3-music-preview',
      'stepaudio-3-tts'
    ],
    input: { 'step-3.7-flash': ['text', 'image', 'vision'] }
  },
  { id: 'deepseek', name: 'deepseek', baseURL: 'https://api.deepseek.com', models: ['deepseek-flash'] }
]

export function SettingsView(p: Props) {
  const providers = p.settings.providers
  /**
   * 访问权限档位：**完全控制是总权限闸**——主进程收到「能不能调用别的模型」的询问时直接放行，
   * 不再弹授权卡（见 electron/main/gate.ts requestModelAuth）。所以这一档下本页的授权清单
   * 只是历史记录，撤销它也拦不住；文案必须说清，否则用户会以为撤销失效了。
   */
  const fullAccess = p.settings.access === 'full'
  const [draft, setDraft] = useState<Draft | null>(null)
  const [mcpDraft, setMcpDraft] = useState<McpDraft | null>(null)
  const [fetching, setFetching] = useState(false)
  const [formMsg, setFormMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [confirmDel, setConfirmDel] = useState<ProviderCfg | null>(null)
  /* 重启内核前给一次确认（自绘弹窗，不用原生 confirm）：保留没有运行任务时的「稍后再说」 */
  const [pending, setPending] = useState<{ next: SettingsCfg; keepTab?: SettingsTab; note: string } | null>(null)
  /**
   * 本组件自己发起的保存是否在跑。
   *
   * **不要用 p.saving 驱动按钮文案**：它是 App 里「所有设置保存」共用的一个开关，
   * 只要有任何一次保存在进行，提供商弹窗、MCP 弹窗、确认框里的按钮都会一起变成
   * 「保存并重启内核…」——用户根本没点那个按钮却看到它在转，就是这里来的。
   * 各动作各自的忙碌态（busySelf / skBusy）才反映「我刚点的那个操作」。
   */
  const [busySelf, setBusySelf] = useState(false)
  const [showKey, setShowKey] = useState(false)
  // 标签页由 App 持有（左栏「账号」入口要能直接跳过来），这里只读不存
  const tab = p.tab
  const setTab = p.onTab
  /** 远程服务总开关（全局配置，不在此界面上）：关掉则「账号 / 使用量」两页不可见 */
  const remote = p.settings.remote
  const tabs = TABS.filter((t) => remote || !REMOTE_TABS.includes(t.id))
  /**
   * 保存设置并重启内核：正在跑的任务会一起结束，所以先弹窗确认。
   *
   * 不弹原生 confirm（本项目自绘控件，风格要统一），且必须带「稍后再说」：
   * 有任务在跑时强行保存/重启会把用户正在等的这轮直接掐掉。
   *
   * restoreTab：从对话区「配置模型」跳过来的场景，取消后要退回原来那一页，
   * 否则用户停在模型页却没做任何事，会以为设置被改了。
   */
  function applySettings(next: SettingsCfg, opts: { note: string; keepTab?: SettingsTab; restoreTab?: SettingsTab } | null) {
    if (!opts) {
      void p.onSave(next)
      return
    }
    setPending({ next, keepTab: opts.keepTab, note: opts.note })
    // 立即切到目标页，让用户先看到自己点进去的地方（弹窗取消时再退回 restoreTab）
    if (opts.keepTab) setTab(opts.keepTab)
  }
  /** 磁盘上扫到的技能（全局 + 当前项目），进入技能页时刷新 */
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [skDraft, setSkDraft] = useState<SkillForm | null>(null)
  const [skDel, setSkDel] = useState<SkillItem | null>(null)
  /** 技能落盘后要重启内核（技能是启动时加载的），期间按钮转「保存并重启内核…」 */
  const [skBusy, setSkBusy] = useState(false)
  /**
   * 「永久允许调用其他模型」清单（形如 `vision|agnes/glm-5.2`）。
   * 用户在授权卡上点了「永久允许」就落进这里，之后 AI 调这个模型不再问；
   * 这一列表就是**唯一的撤销入口**——没有它，「永久允许」等于单向门，只能手改 settings.json。
   */
  const [authGrants, setAuthGrants] = useState<string[]>([])
  /** 右侧正文滚动容器：外部跳页后置顶，避免停在上一页的半截位置 */
  const body = useRef<HTMLDivElement>(null)

  /**
   * 提供商排序：拖完立即落盘（providers 是设置的一部分）。
   * 顺序会记进 settings.json，模型选择器的级联菜单就按这个顺序排——用户把常用的拖到最前，
   * 每次选模型不必再往下翻。
   */
  const provSort = useDragSort((from, to) =>
    applySettings({ ...p.settings, providers: moveItem(providers, from, to) }, null)
  )

  /** 弹窗内模型排序：只改草稿，点保存才生效（与其它表单字段一致，取消即丢弃） */
  const modelSort = useDragSort((from, to) => {
    if (!draft) return
    setDraft({ ...draft, modelsText: moveItem(parseModels(draft.modelsText), from, to).join('\n') })
  })

  /**
   * 模型列表不再是把参数摊在每行里，而是「名称 + 输入 + 编辑/删除」的紧凑列表，
   * 全部参数收进二级弹窗——列表只用来扫一眼「有哪几个模型、各自吃什么模态」。
   */
  const [modelForm, setModelForm] = useState<ModelForm | null>(null)
  /** 待删除的模型（自绘确认框，不用原生 confirm） */
  const [modelDel, setModelDel] = useState<string | null>(null)

  // 关掉远程服务时正停在「账号 / 使用量」上：那两页已经不可见了，退回主题页免得白屏
  useEffect(() => {
    if (!remote && REMOTE_TABS.includes(tab)) setTab('theme')
  }, [remote, tab, setTab])

  /**
   * 外部请求的定位：只在 tick 变化时跑一次（不进依赖，否则用户手动切页会被立刻拉回来）。
   *
   * 关掉远程服务时「账号 / 使用量」两页不存在，回落主题页，别停在一页空白上；
   * 切页后置顶滚动，否则从模型页跳到技能页会停在半截位置。
   */
  useEffect(() => {
    if (!p.req) return
    const t = !remote && REMOTE_TABS.includes(p.req.tab) ? 'theme' : p.req.tab
    setTab(t)
    setConfirmDel(null)
    closeProviderModal()
    setMcpDraft(null)
    setPending(null)
    setSkDel(null)
    requestAnimationFrame(() => body.current?.scrollTo({ top: 0 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.req?.tick])

  /**
   * 关闭提供商弹窗。二级弹窗（模型编辑 / 删除确认）必须一起关掉——
   * 它们挂在提供商的 draft 上，draft 没了还留着就会读到空值渲染出错。
   * 所有关闭路径都走这里，别直接 setDraft(null)。
   */
  function closeProviderModal() {
    setDraft(null)
    setModelForm(null)
    setModelDel(null)
  }

  function openNew() {
    setFormMsg(null)
    setModelForm(null)
    setModelDel(null)
    setDraft({ isNew: true, index: -1, name: '', id: '', baseURL: '', apiKey: '', modelsText: '', cfgs: {} })
  }

  /** 应用提供商模板：本机已有同 ID 的配置原样带出（模型/参数/Base URL），但绝不带入 API Key */
  function applyPreset(pid: string) {
    if (!draft) return
    const preset = PROVIDER_PRESETS.find((x) => x.id === pid)
    if (!preset) return
    setModelForm(null)
    setModelDel(null)
    const cur = providers.find((x) => x.id === preset.id)
    // 老存档里过时的端点顺手纠回来（见 STALE_BASE_URL），否则用户永远停在写死的错地址上
    const savedBase = freshBaseURL(preset.id, cur?.baseURL)
    const ids = cur?.models.length ? cur.models.map((m) => m.id) : preset.models
    const known = cur ? Object.fromEntries(cur.models.map((m) => [m.id, m])) : {}
    const cfgs: Record<string, ModelCfg> = {}
    for (const mid of ids) {
      // 已存过的参数（含用户选过的生成角色）不动，只对全新模型按名字/模板预填
      cfgs[mid] =
        known[mid] ?? { id: mid, ...defaultModelCfg(), ...presetModelPatch(mid, preset.input?.[mid], preset.gen?.[mid]) }
    }
    setDraft({
      isNew: true,
      index: -1,
      name: cur?.name ?? preset.name,
      id: preset.id,
      baseURL: savedBase ?? preset.baseURL,
      apiKey: '',
      modelsText: ids.join('\n'),
      cfgs
    })
    setFormMsg({ text: t('已填充模板，请填写 API Key'), bad: false })
  }

  function openEdit(i: number) {
    const c = providers[i]
    setFormMsg(null)
    setModelForm(null)
    setModelDel(null)
    setDraft({
      isNew: false,
      index: i,
      name: c.name,
      id: c.id,
      baseURL: c.baseURL,
      apiKey: c.apiKey,
      modelsText: c.models.map((m) => m.id).join('\n'),
      cfgs: Object.fromEntries(c.models.map((m) => [m.id, m]))
    })
  }

  async function fetchModels() {
    if (!draft) return
    if (!draft.baseURL.trim()) {
      setFormMsg({ text: t('请先填写 Base URL'), bad: true })
      return
    }
    setFetching(true)
    setFormMsg(null)
    const r = await window.qingniao.fetchModels(draft.baseURL, draft.apiKey)
    setFetching(false)
    if (r.error) setFormMsg({ text: t('拉取失败：') + r.error, bad: true })
    else {
      setDraft({ ...draft, modelsText: r.models!.join('\n') })
      setFormMsg({ text: t('已获取 {n} 个模型', { n: r.models!.length }), bad: false })
    }
  }

  /** 某个模型的接入参数：编辑过的取草稿值，没编辑过的用默认 */
  function cfgOf(id: string): ModelCfg {
    return draft?.cfgs[id] ?? { id, ...defaultModelCfg() }
  }

  // ===== 模型编辑二级弹窗 =====
  //
  // 列表里只显示「名称 + 输入 + 编辑/删除」，参数全收进弹窗。这里所有操作都只动 draft.cfgs，
  // 点提供商弹窗的「保存」才落盘——与其它字段一致，中途取消整份丢弃。

  /** 打开编辑：把当前生效的参数（草稿优先，其次默认值）拍成一份独立草稿 */
  function openModelForm(mid: string, index: number) {
    const c = cfgOf(mid)
    setModelForm({
      index,
      isNew: false,
      id: mid,
      context: c.context,
      output: c.output,
      input: [...c.input],
      thinking: c.thinking ?? 'toggle',
      gen: c.gen ?? 'auto'
    })
  }

  /** 打开新增：给一份空表单，模型名待填 */
  function openNewModelForm(total: number) {
    const d = defaultModelCfg()
    setModelForm({
      index: total,
      isNew: true,
      id: '',
      context: d.context,
      output: d.output,
      input: [...d.input],
      thinking: 'toggle',
      gen: 'auto'
    })
  }

  /**
   * 提交模型表单：新增时插到 modelsText 末尾，编辑时就地替换（可改名）。
   *
   * 只改草稿——提供商弹窗的「保存」才真正落盘，中途取消整份丢弃。
   * 新增的 index 记的是「提交那一刻列表长度」，所以连点两次添加不会互相插队。
   */
  function commitModelForm() {
    const f = modelForm
    if (!draft || !f) return
    const mid = f.id.trim()
    if (!mid) return
    // 不许重名：编辑时改的是自己，跳过同下标；拿不到下标（理论上不会）就拦下来别静默出错
    const ids = parseModels(draft.modelsText)
    if (ids.some((x, i) => x === mid && i !== f.index)) return
    const cfg: ModelCfg = {
      id: mid,
      context: f.context,
      output: f.output,
      input: [...f.input],
      thinking: f.thinking,
      gen: f.gen
    }
    // 新增：插到下标处；编辑：就地替换（含改名——否则 modelsText 仍留旧名，列表就不动）
    const nextIds = f.isNew
      ? [...ids.slice(0, f.index), mid, ...ids.slice(f.index)]
      : ids.map((x, i) => (i === f.index ? mid : x))
    // 改名时把旧名字的配置一并清掉，不然 cfgs 里会留一条永远用不到的孤儿配置
    const cfgs = { ...draft.cfgs }
    if (!f.isNew && ids[f.index] !== mid) delete cfgs[ids[f.index]]
    cfgs[mid] = cfg
    setDraft({ ...draft, modelsText: nextIds.join('\n'), cfgs })
    setModelForm(null)
  }

  function delModel(mid: string, index: number) {
    if (!draft) return
    const ids = parseModels(draft.modelsText)
    const cfgs = { ...draft.cfgs }
    delete cfgs[mid]
    setDraft({ ...draft, modelsText: ids.filter((_, i) => i !== index).join('\n'), cfgs })
    setModelDel(null)
  }

  /** 列表里显示的「输入」摘要：按 MODALITY_LABELS 的顺序，与弹窗内勾选顺序无关 */
  function inputSummary(c: ModelCfg): Modality[] {
    return MODALITY_LABELS.map((m) => m.key).filter((k) => c.input.includes(k))
  }

  /**
   * 列表里显示的「生成」标签：它干什么用（出文本 / 出图 / 配音 / 听写）。
   * 与「输入」并列展示——输入回答「它吃什么」，生成回答「它做什么」，两件事都别省。
   *
   * 'none' 是「强制按对话模型处理」，对话模型产出恒为文本，直接显示「文本」比「对话」更贴切；
   * 其余角色取 GEN_LABELS 的标签（图片 / 视频 / 语音 / 音乐 / 识别）。
   */
  function roleLabel(role: GenRole): string {
    if (role === 'none') return t('文本')
    const lab = GEN_LABELS.find((g) => g.key === role)?.label
    return lab ? t(lab) : role
  }

  /**
   * 提供商 ID：界面不再让用户填（名称已经够看了），首次保存时按名称生成，之后**冻结不变**。
   *
   * 冻结很重要：这个 ID 是提供商的机器身份 —— opencode.json 的 provider ID、密钥环境变量
   * （QN_KEY_<ID>）、以及「永久允许调用」清单里的 `provider/model` 都按它认，跟着名称变的话，
   * 改个名就会让用户攒下的授权记录与内核配置一起失效。同名两家自动加数字后缀，
   * 不必再让用户自己想一个。
   */
  function uniqueProviderId(raw: string, name: string, selfIndex: number): string {
    const taken = new Set(providers.filter((_, i) => i !== selfIndex).map((p) => p.id))
    const base = (raw.trim() || slugify(name)).toLowerCase()
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) {
      const cand = `${base}-${n}`
      if (!taken.has(cand)) return cand
    }
  }

  async function saveDraft() {
    if (!draft || busySelf) return
    const id = uniqueProviderId(draft.id, draft.name, draft.index)
    if (!draft.baseURL.trim()) {
      setFormMsg({ text: t('请填写 Base URL'), bad: true })
      return
    }
    if (providers.some((x, i) => x.id === id && i !== draft.index)) {
      setFormMsg({ text: t('提供商 ID 已存在：') + id, bad: true })
      return
    }
    // 同名两家由 uniqueProviderId 加后缀避开了，走不到上面那句；留着当兜底
    const cfg: ProviderCfg = {
      id,
      name: draft.name.trim() || id,
      baseURL: draft.baseURL.trim(),
      apiKey: draft.apiKey.trim(),
      enabled: draft.isNew ? true : providers[draft.index].enabled,
      models: parseModels(draft.modelsText).map((mid) => draft.cfgs[mid] ?? { id: mid, ...defaultModelCfg() })
    }
    const list = draft.isNew ? [...providers, cfg] : providers.map((x, i) => (i === draft.index ? cfg : x))
    // 关弹窗放 finally：保存失败时表单要留住（让用户改完再试），但绝不能卡在「保存中」不动
    setBusySelf(true)
    try {
      await p.onSave({ ...p.settings, providers: list })
      closeProviderModal()
    } finally {
      setBusySelf(false)
    }
  }

  async function toggle(i: number) {
    applySettings(
      { ...p.settings, providers: providers.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)) },
      { note: t(providers[i].enabled ? '将停用「{name}」。' : '将启用「{name}」。', { name: providers[i].name }) }
    )
  }

  async function doRemove() {
    if (!confirmDel || busySelf) return
    // 关弹窗一定要放 finally：p.onSave 内部会重启内核，重启失败（或主进程拒绝）时若把
    // setConfirmDel(null) 留在 await 之后，弹窗会一直挂在屏幕上——用户看到的就是「点了删除没反应」。
    const id = confirmDel.id
    setBusySelf(true)
    try {
      await p.onSave({ ...p.settings, providers: providers.filter((x) => x.id !== id) })
    } finally {
      setBusySelf(false)
      setConfirmDel(null)
    }
  }

  // ---------- MCP ----------

  async function saveMcpDraft() {
    if (!mcpDraft) return
    const name = mcpDraft.name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!name) {
      setFormMsg({ text: t('请填写 MCP 名称'), bad: true })
      return
    }
    if (mcpDraft.type === 'local' && !mcpDraft.command.trim()) {
      setFormMsg({ text: t('请填写启动命令（如 npx -y @modelcontextprotocol/server-xxx）'), bad: true })
      return
    }
    if (mcpDraft.type === 'remote' && !mcpDraft.url.trim()) {
      setFormMsg({ text: t('请填写服务地址'), bad: true })
      return
    }
    if (name === 'playwright') {
      setFormMsg({ text: t('playwright 为内置浏览器保留名，请换一个'), bad: true })
      return
    }
    const list = p.settings.mcps
    if (list.some((x, i) => x.name === name && i !== mcpDraft.index)) {
      setFormMsg({ text: t('同名 MCP 已存在：') + name, bad: true })
      return
    }
    const cfg: McpCfg = {
      name,
      type: mcpDraft.type,
      command: mcpDraft.command.trim(),
      url: mcpDraft.url.trim(),
      enabled: mcpDraft.isNew ? true : list[mcpDraft.index].enabled
    }
    const next = mcpDraft.isNew ? [...list, cfg] : list.map((x, i) => (i === mcpDraft.index ? cfg : x))
    // 同 saveDraft：关弹窗放 finally，失败时表单留住但不卡在「保存中」
    setBusySelf(true)
    try {
      await p.onSave({ ...p.settings, mcps: next })
      setMcpDraft(null)
      setFormMsg(null)
    } finally {
      setBusySelf(false)
    }
  }

  async function toggleMcp(i: number) {
    const m = p.settings.mcps[i]
    applySettings(
      { ...p.settings, mcps: p.settings.mcps.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)) },
      { note: t(m.enabled ? '将停用 MCP「{name}」。' : '将启用 MCP「{name}」。', { name: m.name }) }
    )
  }

  async function removeMcp(i: number) {
    const m = p.settings.mcps[i]
    applySettings(
      { ...p.settings, mcps: p.settings.mcps.filter((_, k) => k !== i) },
      { note: t('将删除 MCP「{name}」。', { name: m.name }) }
    )
  }

  // ---------- 技能（Skills）----------
  // 技能 = 磁盘上的 <技能名>/SKILL.md。模型只看到 name + description 两行，
  // 判断需要时才读全文，所以不占常驻上下文；改完即时生效，不用重启内核。

  const refreshSkills = useCallback(async () => {
    setSkills(await window.qingniao.listSkills(p.projectPath))
  }, [p.projectPath])

  useEffect(() => {
    if (tab === 'skills') void refreshSkills()
  }, [tab, refreshSkills])

  // 进「模型」页时拉一次永久授权清单（授权可能在别处刚发生过，不能拿挂载时那份旧快照）
  const refreshAuthGrants = useCallback(async () => {
    setAuthGrants(await window.qingniao.modelAuthList())
  }, [])

  useEffect(() => {
    if (tab === 'providers') void refreshAuthGrants()
  }, [tab, refreshAuthGrants])

  /** 撤销一条永久授权（会话级授权一并失效）；key 省略＝清空全部 */
  async function revokeGrant(key?: string) {
    setAuthGrants(await window.qingniao.revokeModelAuth(key))
  }

  function newSkill(scope: SkillScope) {
    setFormMsg(null)
    setSkDraft({ isNew: true, scope, originalName: '', name: '', description: '', body: '' })
  }

  async function openSkill(s: SkillItem) {
    setFormMsg(null)
    const d = await window.qingniao.readSkill({ scope: s.scope, projectPath: p.projectPath, name: s.name })
    setSkDraft({
      isNew: false,
      scope: s.scope,
      originalName: s.name,
      name: d.name || s.name,
      description: d.description,
      body: d.body
    })
  }

  async function saveSkillForm() {
    if (!skDraft || skBusy) return
    setSkBusy(true)
    try {
      const r = await window.qingniao.saveSkill({
        scope: skDraft.scope,
        projectPath: p.projectPath,
        originalName: skDraft.isNew ? undefined : skDraft.originalName,
        name: skDraft.name,
        description: skDraft.description,
        body: skDraft.body
      })
      if (r.error) {
        setFormMsg({ text: r.error, bad: true })
        return
      }
      setSkDraft(null)
      setFormMsg(null)
      await refreshSkills()
    } finally {
      setSkBusy(false)
    }
  }

  async function doRemoveSkill() {
    if (!skDel || skBusy) return
    setSkBusy(true)
    try {
      await window.qingniao.removeSkill({ scope: skDel.scope, projectPath: p.projectPath, name: skDel.name })
      setSkDel(null)
      await refreshSkills()
    } finally {
      setSkBusy(false)
    }
  }

  /** 技能分组：内置随安装包分发（只读），全局对所有项目生效，项目级只在当前项目下被内核发现 */
  function skillGroup(kind: 'builtin' | SkillScope, title: string, hint: string) {
    const usable = kind !== 'builtin' && (kind === 'global' || !!p.projectPath)
    const list = skills.filter((s) => (kind === 'builtin' ? s.builtin && s.scope === 'global' : s.scope === kind && !s.builtin))
    return (
      <div className="sk-sec" key={kind}>
        <div className="sk-head">
          <span className="sk-title">{t(title)}</span>
          {hint && <span className="sk-hint">{hint}</span>}
          <span className="spacer" />
          {kind !== 'builtin' && (
            <>
              <button className="ghost" disabled={!usable} onClick={() => void window.qingniao.openSkillsDir({ scope: kind, projectPath: p.projectPath })}>
                <FolderOpen size={13} /> {t('打开目录')}
              </button>
              <button className="ghost" disabled={!usable} onClick={() => newSkill(kind === 'global' ? 'global' : 'project')}>
                <Plus size={13} /> {t('新建')}
              </button>
            </>
          )}
        </div>
        {!usable && kind !== 'builtin' && <div className="plist-empty">{t('未打开项目')}</div>}
        {usable && list.length === 0 && (
          <div className="plist-empty hint">
            {kind === 'global' ? t('还没有全局技能') : t('「{name}」下还没有技能', { name: p.projectName ?? t('当前项目') })}
          </div>
        )}
        {kind === 'builtin' && list.length === 0 && <div className="plist-empty hint">{t('没有内置技能')}</div>}
        {list.map((s) => (
          <div key={s.scope + s.name} className={'prow' + (s.error ? ' bad' : '')}>
            <span className="prow-ico">
              <Sparkles size={15} />
            </span>
            <div className="prow-main">
              <div className="prow-name">
                {s.name}
                <span className="chip">{t(kind === 'builtin' ? '内置' : kind === 'global' ? '全局' : '项目')}</span>
                {s.error && <span className="chip bad">{t('不可用')}</span>}
              </div>
              <div className="sk-desc">{s.error ?? s.description}</div>
            </div>
            {kind !== 'builtin' && (
              <>
                <button className="icon-btn" title={t('编辑')} onClick={() => void openSkill(s)}>
                  <Pencil size={15} />
                </button>
                <button className="icon-btn danger" title={t('删除')} onClick={() => setSkDel(s)}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <main className="main settings">
      <div className="set-layout">
        <nav className="set-menu">
          {tabs.map((tb) => (
            <button
              type="button"
              key={tb.id}
              className={'set-item' + (tab === tb.id ? ' on' : '')}
              onClick={() => setTab(tb.id)}
            >
              <tb.icon size={15} /> {t(tb.label)}
            </button>
          ))}
        </nav>
        <div className="setbody" ref={body}>
        {tab === 'theme' && (
        <>
        <section>
          <h3>
            <Layers size={15} /> {t('通用')}
          </h3>
          <h4 className="sub-title">{t('语言')}</h4>
          <p className="sec-tip">{t('切换后整个界面的文案随之更新。')}</p>
          <div className="acct-tabs">
            {LANGS.map((l) => (
              <button
                type="button"
                key={l.id}
                className={'seg-btn' + (p.lang === l.id ? ' on' : '')}
                onClick={() => p.onLang(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <h4 className="sub-title">{t('聊天宽度')}</h4>
          <p className="sec-tip">{t('仅影响非代码模式下的聊天内容宽度，默认使用较宽布局。')}</p>
          <div className="chat-width-setting">
            <input
              type="range"
              min={640}
              max={1100}
              step={20}
              value={p.normalChatWidth}
              onChange={(e) => p.onNormalChatWidth(Number(e.target.value))}
            />
            <span>{p.normalChatWidth}px</span>
            {/* 与 App.tsx 里 normalChatWidth 的默认值保持一致 */}
            <button type="button" className="ghost sm" onClick={() => p.onNormalChatWidth(960)}>
              {t('恢复默认')}
            </button>
          </div>
          <h4 className="sub-title">{t('消息导航锚点')}</h4>
          <p className="sec-tip">
            {t('对话内容左侧显示一列「-」定位图标，每条用户消息对应一个，点击立即跳到那条消息；适合长对话快速回看。默认关闭。')}
          </p>
          <div className="switch-row">
            <Switch checked={p.userAnchors} onChange={p.onUserAnchors} />
            <span>{p.userAnchors ? t('已启用') : t('未启用')}</span>
          </div>
          <h4 className="sub-title">{t('访问权限')}</h4>
          <p className="sec-tip">
            {t('AI 在本机动文件的权限档位，全局生效。默认：改动文件、执行命令前先弹窗问你；完全控制：不再询问，直接读写文件、跑命令。')}
          </p>
          <div className="acct-tabs">
            <button
              type="button"
              className={'seg-btn' + (!fullAccess ? ' on' : '')}
              onClick={() => p.onAccess('default')}
            >
              {t('默认权限')}
            </button>
            <button
              type="button"
              className={'seg-btn' + (fullAccess ? ' on' : '')}
              onClick={() => p.onAccess('full')}
            >
              {t('完全控制')}
            </button>
          </div>
          <h4 className="sub-title">{t('项目文件夹排序')}</h4>
          <p className="sec-tip">{t('默认按最近任务先后排列，也可以固定顺序后手动调整。')}</p>
          <div className="acct-tabs">
            <button
              type="button"
              className={'seg-btn' + (p.projectSortMode === 'activity' ? ' on' : '')}
              onClick={() => p.onProjectSortMode('activity')}
            >
              {t('自动（按任务先后）')}
            </button>
            <button
              type="button"
              className={'seg-btn' + (p.projectSortMode === 'fixed' ? ' on' : '')}
              onClick={() => p.onProjectSortMode('fixed')}
            >
              {t('固定顺序')}
            </button>
          </div>
          {p.projectSortMode === 'fixed' && (
            <p className="sec-tip">{t('固定后可在左侧直接拖动项目文件夹调整顺序；内置「任务」目录始终置顶。')}</p>
          )}
          <h4 className="sub-title">{t('代码风格')}</h4>
          <p className="sec-tip">{t('统一应用于代码编辑器、聊天代码块与工具详情；随当前主题自动适配明暗。')}</p>
          <div className="code-style-grid">
            {CODE_STYLES.map((style) => {
              const preview = CODE_STYLE_PREVIEWS[style.id]
              const on = p.codeStyle === style.id
              return (
                <button
                  type="button"
                  key={style.id}
                  className={'code-style-card' + (on ? ' on' : '')}
                  onClick={() => p.onCodeStyle(style.id)}
                >
                  <span className="code-style-preview" style={{ background: preview.bg, color: preview.fg }}>
                    <b style={{ color: preview.keyword }}>const</b>{' '}
                    <span style={{ color: preview.string }}>answer</span>{' '}
                    <i>=</i> <em>42</em>
                  </span>
                  <span className="code-style-name">{t(style.name)}</span>
                  <span className="code-style-desc">{t(style.desc)}</span>
                  {on && <span className="theme-mark"><Check size={11} strokeWidth={3} /></span>}
                </button>
              )
            })}
          </div>
        </section>
        <section>
          <h4 className="sub-title">{t('主题')}</h4>
          <p className="sec-tip">
            {t('内置配色即时切换，实时应用到整个界面；选择「自定义」可用四种基础色自由搭配。')}
          </p>
          <div className="theme-grid">
            {getThemeList().map((th) => {
              // 预览色：内置为 [侧栏 / 内容底 / 主色]，自定义取当前四色
              const [side, body, accent] = th.id === CUSTOM_ID
                ? [p.custom.sideBg, p.custom.bg, p.custom.accent]
                : [th.swatches[0], th.swatches[2], th.swatches[1]]
              const on = p.theme === th.id
              return (
                <button
                  type="button"
                  key={th.id}
                  className={'theme-card' + (on ? ' on' : '')}
                  onClick={() => p.onTheme(th.id)}
                >
                  <span className="theme-preview">
                    <i className="pv-side" style={{ background: side }} />
                    <i className="pv-body" style={{ background: body }}>
                      <b style={{ background: accent }} />
                    </i>
                  </span>
                  <span className="theme-name">{t(th.name)}</span>
                  {on && <span className="theme-mark"><Check size={11} strokeWidth={3} /></span>}
                </button>
              )
            })}
          </div>
          {p.theme === CUSTOM_ID && (
            <div className="custom-editor">
              {CUSTOM_FIELDS.map((f) => (
                <label key={f.key} className="cc-row">
                  <span>{f.label}</span>
                  <input
                    type="color"
                    value={p.custom[f.key]}
                    onChange={(e) => p.onCustom(f.key, e.target.value)}
                  />
                  <span className="cc-val">{p.custom[f.key]}</span>
                </label>
              ))}
              <button type="button" className="ghost cc-reset" onClick={p.onResetCustom}>
                重置
              </button>
            </div>
          )}
          <h4 className="sub-title">{t('主题背景图')}</h4>
          <p className="sec-tip">
            {t('给界面配上自己的壁纸：「整屏一张」整个窗口铺同一幅；「左右分开」左侧栏与右侧内容区各铺一张。图片会复制一份存到应用目录，原文件删除后不受影响。')}
          </p>
          <div className="acct-tabs">
            <button
              type="button"
              className={'seg-btn' + (p.themeBg.mode === 'none' ? ' on' : '')}
              onClick={() => p.onThemeBgMode('none')}
            >
              {t('不使用')}
            </button>
            <button
              type="button"
              className={'seg-btn' + (p.themeBg.mode === 'full' ? ' on' : '')}
              onClick={() => p.onThemeBgMode('full')}
            >
              {t('整屏一张')}
            </button>
            <button
              type="button"
              className={'seg-btn' + (p.themeBg.mode === 'split' ? ' on' : '')}
              onClick={() => p.onThemeBgMode('split')}
            >
              {t('左右分开')}
            </button>
          </div>
          {p.themeBg.mode === 'full' && (
            <div className="bg-slots">
              <BgSlot
                label={t('整屏')}
                url={p.themeBg.full ? p.bgUrls[p.themeBg.full] : ''}
                onPick={() => p.onThemeBgPick('full')}
                onClear={() => p.onThemeBgClear('full')}
              />
            </div>
          )}
          {p.themeBg.mode === 'split' && (
            <div className="bg-slots">
              <BgSlot
                label={t('左侧栏')}
                url={p.themeBg.left ? p.bgUrls[p.themeBg.left] : ''}
                onPick={() => p.onThemeBgPick('left')}
                onClear={() => p.onThemeBgClear('left')}
              />
              <BgSlot
                label={t('右侧内容区')}
                url={p.themeBg.right ? p.bgUrls[p.themeBg.right] : ''}
                onPick={() => p.onThemeBgPick('right')}
                onClear={() => p.onThemeBgClear('right')}
              />
            </div>
          )}
        </section>
        </>
        )}

        {tab === 'providers' && (
        <>
        <section>
          <h3>
            {t('模型提供商')}
            <span className="spacer" />
            <button className="ghost" onClick={openNew}>
              <Plus size={14} /> {t('添加提供商')}
            </button>
          </h3>
          <p className="sec-tip">
            {t('填写任意 OpenAI Chat 兼容端点的 Base URL 即可接入，一个提供商可挂多个模型；保存后自动重启内核生效，API Key 仅存于本机 ~/.qingniaoai/settings.json。')}
            <br />
            {t('拖动左侧手柄可调整顺序，这个顺序决定模型选择器里各提供商分组的先后。')}
          </p>
          {providers.length === 0 && <div className="plist-empty">{t('还没有自定义提供商，点击右上角添加')}</div>}
          {providers.length > 0 && (
            <div className="plist">
              {providers.map((c, i) => (
                <div
                  key={c.id}
                  className={
                    'prow' +
                    (c.enabled ? '' : ' off') +
                    (provSort.dragIdx === i ? ' dragging' : '') +
                    (provSort.overIdx === i && provSort.dragIdx !== null && provSort.dragIdx !== i
                      ? ' dragover ' + provSort.overPos
                      : '')
                  }
                  {...provSort.rowProps(i)}
                >
                  <span className="prow-grip" title={t('拖动调整顺序')} {...provSort.handleProps(i)}>
                    <GripVertical size={14} />
                  </span>
                  <Switch checked={c.enabled} onChange={() => toggle(i)} />
                  <div className="prow-main">
                    <div className="prow-name">
                      {c.name}
                      <span className="chip">{t('{n} 个模型', { n: c.models.length })}</span>
                      {/* ID 不让用户填了，但列在这儿：改名后还能对上号，内核配置与授权记录都按它认 */}
                      <span className="prow-id" title={t('内部标识：内核配置与「永久允许」清单按它认，创建后不再变化')}>
                        {c.id}
                      </span>
                    </div>
                    <div className="prow-url">{c.baseURL}</div>
                  </div>
                  <button className="icon-btn" title={t('编辑')} onClick={() => openEdit(i)}>
                    <Pencil size={15} />
                  </button>
                  <button className="icon-btn danger" title={t('删除')} onClick={() => setConfirmDel(c)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <h3>
            {t('其他模型调用授权')}
            <span className="spacer" />
            {authGrants.length > 0 && (
              <button className="ghost danger-text" onClick={() => void revokeGrant()}>
                {t('全部撤销')}
              </button>
            )}
          </h3>
          <p className="sec-tip">
            {t('除当前对话模型外，AI 在识图、生成图片/视频/音乐、配音、语音识别时会调用别的模型。')}
            {fullAccess ? (
              <>
                {t('当前是')}<strong>{t('完全控制')}</strong>{t('：这一档是总权限闸，这类调用')}
                <strong>{t('一律直接放行、不再弹授权卡')}</strong>{t('，下面的清单只是历史记录（撤销它也拦不住）。想恢复成每次询问，把访问权限切回「默认权限」。')}
              </>
            ) : (
              <>
                {t('每次调用前都会弹一张授权卡，你选「永久允许」的目标会记在这里——想恢复成每次询问就撤销它。')}
                <br />
                {t('撤销会同时清掉本次运行内的会话级授权：留着它会让「撤销了却还在调」看起来像没生效。')}
              </>
            )}
          </p>
          {authGrants.length === 0 && (
            <div className="plist-empty">
              {fullAccess
                ? t('还没有永久允许的目标；当前是完全控制，这类调用本来也不会再问你')
                : t('还没有永久允许的目标，AI 每次调用其他模型都会先问你')}
            </div>
          )}
          {authGrants.length > 0 && (
            <div className="plist">
              {authGrants.map((k) => {
                const [role, id] = k.split('|')
                const rl = MODEL_ROLE_LABEL[role]
                return (
                  <div key={k} className="prow">
                    <Cpu size={15} />
                    <div className="prow-main">
                      <div className="prow-name">{rl ? t(rl) : role || t('调用模型')}</div>
                      <div className="prow-url">{id || k}</div>
                    </div>
                    <button className="icon-btn danger" title={t('撤销这条永久授权')} onClick={() => void revokeGrant(k)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>
        </>
        )}

        {tab === 'mcp' && (
        <section>
          <h3>
            {t('浏览器与扩展（MCP）')}
            <span className="spacer" />
            <button
              className="ghost"
              onClick={() => {
                setFormMsg(null)
                setMcpDraft({ isNew: true, index: -1, name: '', type: 'local', command: '', url: '' })
              }}
            >
              <Plus size={14} /> {t('添加 MCP')}
            </button>
          </h3>
          <p className="sec-tip">
            {t('也可以添加任意本地命令型 / 远程 URL 型 MCP 服务器扩展工具能力。变更需重启内核生效（保存时自动完成）。')}
          </p>
          <div className="mcp-list">
          {p.settings.mcps.length === 0 && <div className="plist-empty hint">{t('还没有添加 MCP 服务器，可添加本地命令型（stdio）或远程 URL 型（HTTP/SSE）')}</div>}
          {p.settings.mcps.map((m, i) => (
            <div key={m.name} className="prow">
              <Switch checked={m.enabled} onChange={() => toggleMcp(i)} />
              <span className="prow-ico">
                {m.type === 'remote' ? <Link2 size={15} /> : <Terminal size={15} />}
              </span>
              <div className="prow-main">
                <div className="prow-name">
                  {m.name}
                  <span className={'chip kind-' + m.type}>{t(m.type === 'remote' ? '远程' : '本地')}</span>
                </div>
                <div className="prow-url">{m.type === 'remote' ? m.url : m.command}</div>
              </div>
              <button
                className="icon-btn"
                title={t('编辑')}
                onClick={() => {
                  setFormMsg(null)
                  setMcpDraft({ isNew: false, index: i, name: m.name, type: m.type, command: m.command, url: m.url })
                }}
              >
                <Pencil size={15} />
              </button>
              <button className="icon-btn danger" title={t('删除')} onClick={() => removeMcp(i)}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          </div>
        </section>
        )}

        {tab === 'skills' && (
        <section>
          <h3>
            {t('技能（Skills）')}
          </h3>
          {skillGroup('builtin', t('内置技能'), '')}
          {skillGroup('global', t('全局技能'), '~/.qingniaoai/opencode/skills')}
          {skillGroup('project', t('项目技能'), p.projectName ? `${p.projectName} · .opencode/skills` : `${t('<项目>')}/.opencode/skills`)}
        </section>
        )}

        {tab === 'usage' && <UsagePanel />}

        {tab === 'about' && <UpdatePanel />}

        {tab === 'account' && (
          <AccountPanel
            loggedIn={!!p.platform?.loggedIn}
            platformBusy={p.platformBusy}
            baseUrl={p.platform?.baseUrl ?? ''}
            onLogin={p.onLogin}
            onLogout={p.onLogout}
            onSetBaseUrl={p.onSetBaseUrl}
            onSubmitCode={p.onSubmitCode}
          />
        )}

        </div>
      </div>

      {draft && (
        <Modal title={draft.isNew ? t('添加提供商') : t('编辑提供商')} wide onClose={closeProviderModal}>
          {draft.isNew && (
            <div className="preset-row">
              <span className="preset-lab">{t('快速填充')}</span>
              {PROVIDER_PRESETS.map((pr) => (
                <button
                  type="button"
                  key={pr.id}
                  className={'preset-chip' + (draft.id === pr.id ? ' on' : '')}
                  onClick={() => applyPreset(pr.id)}
                >
                  {pr.name}
                </button>
              ))}
              <button
                type="button"
                className="preset-chip"
                onClick={() => setDraft({ ...draft, name: '', id: '', baseURL: '', apiKey: '', modelsText: '', cfgs: {} })}
              >
                {t('手动填写')}
              </button>
            </div>
          )}
          <label>
            {t('名称')}
            <input
              value={draft.name}
              placeholder={t('如 DeepSeek')}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Base URL
            <input
              value={draft.baseURL}
              placeholder="https://api.deepseek.com"
              onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
            />
          </label>
          <label>
            API Key
            <div className="pw-wrap">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                placeholder="sk-..."
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
              <button
                type="button"
                className="pw-eye"
                title={showKey ? t('隐藏') : t('显示')}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </label>
          {/* 模型列表：只展示「名称 / 生成 / 操作」，接入参数按需弹窗编辑。
              原先每行摊开上下文窗口、最大输出、输入、思考、生成五组控件，一屏放不下两个模型，
              现在列表用来扫全貌，参数收进弹窗。 */}
          <div className="model-cfgs">
            <div className="model-cfgs-tip">{t('拖动左侧手柄可调整顺序')}</div>
            {(() => {
              const ids = parseModels(draft.modelsText)
              if (!ids.length) {
                return <div className="model-empty">{t('还没有模型，点下方「添加」填一个')}</div>
              }
              return ids.map((mid, mi) => {
                const c = cfgOf(mid)
                const ins = inputSummary(c)
                const role = genRoleOf(c)
                return (
                  <div
                    className={
                      'model-row' +
                      (modelSort.dragIdx === mi ? ' dragging' : '') +
                      (modelSort.overIdx === mi && modelSort.dragIdx !== null && modelSort.dragIdx !== mi
                        ? ' dragover ' + modelSort.overPos
                        : '')
                    }
                    key={mid}
                    {...modelSort.rowProps(mi)}
                  >
                    <span className="model-row-grip" title={t('拖动调整顺序')} {...modelSort.handleProps(mi)}>
                      <GripVertical size={14} />
                    </span>
                    <span className="model-row-name" title={mid}>
                      {mid}
                    </span>
                    {/* 两格都要看得到，别只留一个：
                        「输入」= 它吃什么（能不能读图/看视频），排查「发图它不懂」看这格；
                        「生成」= 它干什么用（配音/出图/听写），排查「配音工具说找不到模型」看这格。
                        输入取模态摘要，生成取角色标签。 */}
                    <span className="model-row-io" title={t('输入：{v}', { v: ins.length ? ins.map((k) => modalityLabel(k)).join(' / ') : t('未设置') })}>
                      <span className="model-row-io-lab">{t('输入')}</span>
                      {ins.length ? (
                        ins.map((k) => (
                          <span className="iochip on sm" key={k}>
                            {modalityLabel(k)}
                          </span>
                        ))
                      ) : (
                        <span className="model-row-none">{t('未设置')}</span>
                      )}
                    </span>
                    <span className="model-row-io sep" title={t('生成：{v}', { v: roleLabel(role) })}>
                      <span className="model-row-io-lab">{t('生成')}</span>
                      <span className={'iochip sm' + (role === 'none' ? '' : ' on')}>{roleLabel(role)}</span>
                    </span>
                    <span className="model-row-acts">
                      <button className="ghost sm" title={t('编辑这个模型的接入参数')} onClick={() => openModelForm(mid, mi)}>
                        <Pencil size={13} /> {t('编辑')}
                      </button>
                      <button className="icon-btn danger" title={t('删除这个模型')} onClick={() => setModelDel(mid)}>
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>
                )
              })
            })()}
            <div className="model-foot">
              <button className="ghost model-add" onClick={() => openNewModelForm(parseModels(draft.modelsText).length)}>
                <Plus size={14} /> {t('添加')}
              </button>
              <span className="model-foot-right">
                {formMsg && <span className={'form-msg' + (formMsg.bad ? ' bad' : '')}>{formMsg.text}</span>}
                <button className="ghost" onClick={fetchModels} disabled={fetching}>
                  <RefreshCw size={14} className={fetching ? 'spin' : undefined} /> {t('自动获取模型')}
                </button>
              </span>
            </div>
          </div>
          <div className="actions">
            <button className="ghost" onClick={closeProviderModal}>{t('取消')}</button>
            <button className="primary" disabled={busySelf} onClick={saveDraft}>
              {busySelf ? t('保存并重启内核…') : t('保存')}
            </button>
          </div>
        </Modal>
      )}

      {/* 模型编辑弹窗：二级弹窗，盖在提供商弹窗之上（.mask 同为 fixed，后渲染的在上）。
          新增与编辑共用一套表单——用户要的「编辑时弹出里面表单里面要全就行了」就是这里：
          模型名、上下文窗口、最大输出、输入、思考、生成，一个不少。 */}
      {modelForm && (
        <Modal
          title={modelForm.isNew ? t('添加模型') : t('编辑模型')}
          onClose={() => setModelForm(null)}
          narrow
        >
          <div className="mform">
            <label>
              {t('模型名')}
              <input
                value={modelForm.id}
                placeholder={t('调用时填的 model 字段，如 deepseek-chat')}
                autoFocus
                onChange={(e) => {
                  const id = e.target.value
                  // 新增时才按名字自动猜生成角色与输入类型（用户手改过的不覆盖）：
                  // 名字里带 asr / music / tts 之类的，预勾好省得用户再去翻文档
                  if (!modelForm.isNew) return setModelForm({ ...modelForm, id })
                  const ids = draft ? parseModels(draft.modelsText) : []
                  const dup = ids.some((x, i) => x === id.trim() && i !== modelForm.index)
                  const patch = presetModelPatch(id.trim())
                  setModelForm({
                    ...modelForm,
                    id,
                    gen: dup ? modelForm.gen : patch.gen ?? 'auto',
                    input: dup ? modelForm.input : [...patch.input]
                  })
                }}
              />
              {(() => {
                const mid = modelForm.id.trim()
                if (!mid) return null
                const ids = draft ? parseModels(draft.modelsText) : []
                if (!ids.some((x, i) => x === mid && i !== modelForm.index)) return null
                return <span className="form-msg bad">{t('这个模型名已经有了')}</span>
              })()}
            </label>
            <div className="mform-row">
              <label>
                {t('上下文窗口')}
                <input
                  type="number"
                  min={1}
                  value={modelForm.context || ''}
                  onChange={(e) => setModelForm({ ...modelForm, context: e.target.valueAsNumber || 0 })}
                />
              </label>
              <label>
                {t('最大输出 Token')}
                <input
                  type="number"
                  min={1}
                  value={modelForm.output || ''}
                  onChange={(e) => setModelForm({ ...modelForm, output: e.target.valueAsNumber || 0 })}
                />
              </label>
            </div>
            <div className="mform-group">
              <span className="mform-lab">{t('输入')}</span>
              <div className="mform-chips">
                {MODALITY_LABELS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className={'iochip' + (modelForm.input.includes(m.key) ? ' on' : '')}
                    title={m.tip ? t(m.tip) : undefined}
                    onClick={() =>
                      setModelForm({
                        ...modelForm,
                        input: modelForm.input.includes(m.key)
                          ? modelForm.input.filter((x) => x !== m.key)
                          : [...modelForm.input, m.key]
                      })
                    }
                  >
                    {t(m.label)}
                  </button>
                ))}
              </div>
            </div>
            <div className="mform-group">
              <span className="mform-lab">{t('思考')}</span>
              <div className="mform-chips">
                {THINK_LABELS.map((tk) => (
                  <button
                    key={tk.key}
                    type="button"
                    className={'iochip' + ((modelForm.thinking ?? 'toggle') === tk.key ? ' on' : '')}
                    title={t(tk.tip)}
                    onClick={() => setModelForm({ ...modelForm, thinking: tk.key })}
                  >
                    {t(tk.label)}
                  </button>
                ))}
              </div>
            </div>
            <div className="mform-group">
              <span className="mform-lab">{t('生成')}</span>
              <div className="mform-chips">
                {GEN_LABELS.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    className={'iochip' + ((modelForm.gen ?? 'auto') === g.key ? ' on' : '')}
                    title={t(g.tip)}
                    onClick={() => setModelForm({ ...modelForm, gen: g.key })}
                  >
                    {t(g.label)}
                  </button>
                ))}
              </div>
            </div>
            <div className="actions">
              <button className="ghost" onClick={() => setModelForm(null)}>{t('取消')}</button>
              <button
                className="primary"
                disabled={!modelForm.id.trim() || !modelForm.context || !modelForm.output}
                onClick={commitModelForm}
              >
                {modelForm.isNew ? t('添加') : t('确定')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modelDel && (
        <Modal title={t('删除模型')} onClose={() => setModelDel(null)}>
          <div className="mform">
            <div className="del-text">
              {t('从提供商里移除「')}<b>{modelDel}</b>{t('」？此操作只改草稿，点提供商弹窗的「保存」才正式生效。')}
            </div>
            <div className="actions">
              <button className="ghost" onClick={() => setModelDel(null)}>{t('取消')}</button>
              <button
                className="primary danger-btn"
                onClick={() => delModel(modelDel, parseModels(draft?.modelsText ?? '').indexOf(modelDel))}
              >
                {t('删除')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {mcpDraft && (
        <Modal title={mcpDraft.isNew ? t('添加 MCP 服务器') : t('编辑 MCP 服务器')} onClose={() => setMcpDraft(null)}>
          <div className="mcp-form">
            <div className="mcp-type">
              <button
                type="button"
                className={'seg' + (mcpDraft.type === 'local' ? ' on' : '')}
                onClick={() => { setMcpDraft({ ...mcpDraft, type: 'local' }); setFormMsg(null) }}
              >
                <Terminal size={14} />
                <div className="seg-txt">
                  <b>{t('本地命令（stdio）')}</b>
                  <i>{t('在本机启动进程，如 npx 拉起的 MCP 服务')}</i>
                </div>
              </button>
              <button
                type="button"
                className={'seg' + (mcpDraft.type === 'remote' ? ' on' : '')}
                onClick={() => { setMcpDraft({ ...mcpDraft, type: 'remote' }); setFormMsg(null) }}
              >
                <Link2 size={14} />
                <div className="seg-txt">
                  <b>{t('远程地址（HTTP/SSE）')}</b>
                  <i>{t('连接已部署的 MCP 服务端点 URL')}</i>
                </div>
              </button>
            </div>

            <label>
              {t('名称')}
              <span className="lab-tip">{t('唯一标识，自动转小写，如 context7')}</span>
              <input
                value={mcpDraft.name}
                placeholder="context7"
                spellCheck={false}
                onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })}
              />
            </label>

            {mcpDraft.type === 'local' ? (
              <label>
                {t('启动命令')}
                <span className="lab-tip">{t('命令与参数用空格分隔，整行填入')}</span>
                <textarea
                  rows={3}
                  className="mono"
                  value={mcpDraft.command}
                  placeholder={'npx -y @modelcontextprotocol/server-everything'}
                  spellCheck={false}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, command: e.target.value })}
                />
              </label>
            ) : (
              <label>
                {t('服务地址')}
                <span className="lab-tip">{t('MCP 端点的完整 URL')}</span>
                <input
                  className="mono"
                  value={mcpDraft.url}
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })}
                />
              </label>
            )}

            {formMsg && (
              <p className={'form-msg block' + (formMsg.bad ? ' bad' : '')}>
                {formMsg.bad ? <AlertCircle size={14} /> : <Check size={14} />}
                {formMsg.text}
              </p>
            )}

            <div className="actions">
              <button className="ghost" onClick={() => setMcpDraft(null)}>{t('取消')}</button>
              <button className="primary" disabled={busySelf} onClick={saveMcpDraft}>
                {busySelf ? t('保存并重启内核…') : t('保存')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {skDraft && (
        <Modal
          title={skDraft.isNew ? t('新建技能') : t('编辑技能 · ') + t(skDraft.scope === 'global' ? '全局' : '项目')}
          onClose={() => setSkDraft(null)}
        >
          <div className="mcp-form">
            {skDraft.isNew && (
              <div className="mcp-type">
                <button
                  type="button"
                  className={'seg' + (skDraft.scope === 'global' ? ' on' : '')}
                  onClick={() => {
                    setSkDraft({ ...skDraft, scope: 'global' })
                    setFormMsg(null)
                  }}
                >
                  <Globe size={14} />
                  <div className="seg-txt">
                    <b>{t('全局技能')}</b>
                    <i>{t('所有项目都生效，适合通用规范')}</i>
                  </div>
                </button>
                <button
                  type="button"
                  className={'seg' + (skDraft.scope === 'project' ? ' on' : '')}
                  disabled={!p.projectPath}
                  onClick={() => {
                    setSkDraft({ ...skDraft, scope: 'project' })
                    setFormMsg(null)
                  }}
                >
                  <FolderOpen size={14} />
                  <div className="seg-txt">
                    <b>{t('项目技能')}</b>
                    <i>{p.projectName ? t('只在「{name}」下生效', { name: p.projectName }) : t('需先打开一个项目')}</i>
                  </div>
                </button>
              </div>
            )}

            <label>
              {t('名称')}
              <span className="lab-tip">{t('小写字母、数字与连字符，须与目录名一致，如 git-commit-zh')}</span>
              <input
                className="mono"
                value={skDraft.name}
                placeholder="git-commit-zh"
                spellCheck={false}
                onChange={(e) => setSkDraft({ ...skDraft, name: e.target.value })}
              />
            </label>

            <label>
              {t('描述')}
              <span className="lab-tip">{t('模型靠它判断何时加载——写清「做什么」和「什么场景下用」')}</span>
              <textarea
                rows={3}
                value={skDraft.description}
                placeholder={t('用中文撰写 git 提交信息并完成提交、推送。当用户说「写 git 日志」「提交」「push」时使用。')}
                onChange={(e) => setSkDraft({ ...skDraft, description: e.target.value })}
              />
            </label>

            <label>
              {t('正文（Markdown）')}
              <span className="lab-tip">{t('frontmatter 由上面两个字段自动生成，这里只写正文')}</span>
              <textarea
                rows={12}
                className="mono"
                value={skDraft.body}
                spellCheck={false}
                placeholder={t('## 何时使用\n\n...\n\n## 具体做法\n\n- ...')}
                onChange={(e) => setSkDraft({ ...skDraft, body: e.target.value })}
              />
            </label>

            {formMsg && (
              <p className={'form-msg block' + (formMsg.bad ? ' bad' : '')}>
                {formMsg.bad ? <AlertCircle size={14} /> : <Check size={14} />}
                {formMsg.text}
              </p>
            )}

            <div className="actions">
              <button className="ghost" onClick={() => setSkDraft(null)}>{t('取消')}</button>
              <button className="primary" disabled={skBusy} onClick={saveSkillForm}>
                {skBusy ? t('保存并重启内核…') : t('保存')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {skDel && (
        <Modal title={t('删除技能')} onClose={() => setSkDel(null)}>
          <p className="confirm-text">
            {t('确定删除「')}{skDel.name}{t('」吗？会连同')} <b>{skDel.path}</b> {t('整个目录一起删掉，不可恢复。')}
          </p>
          <div className="actions">
            <button className="ghost" onClick={() => setSkDel(null)}>{t('取消')}</button>
            <button className="primary danger-btn" disabled={skBusy} onClick={doRemoveSkill}>
              {skBusy ? t('删除并重启内核…') : t('删除')}
            </button>
          </div>
        </Modal>
      )}

      {confirmDel && (
        <Modal title={t('删除提供商')} onClose={() => !busySelf && setConfirmDel(null)}>
          <p className="confirm-text">
            {t('确定删除「{name}」及其 {n} 个模型吗？内核会重启，正在使用该提供商的会话将不可继续。', { name: confirmDel.name, n: confirmDel.models.length })}
          </p>
          <div className="actions">
            <button className="ghost" disabled={busySelf} onClick={() => setConfirmDel(null)}>{t('取消')}</button>
            <button className="primary danger-btn" disabled={busySelf} onClick={doRemove}>
              {busySelf ? t('删除并重启内核…') : t('删除')}
            </button>
          </div>
        </Modal>
      )}

      {/* 保存设置 = 重启内核：跑着的任务会一起结束，先让用户确认；不想现在重启的可以「稍后再说」 */}
      {pending && (
        <Modal
          title={t('保存并重启内核')}
          onClose={() => {
            const back = pending.keepTab
            setPending(null)
            if (back) setTab(back)
          }}
        >
          <p className="confirm-text">
            {pending.note}{t('保存会重启内核，')}<b>{t('正在处理的任务会一同结束')}</b>{t('。确定现在保存吗？')}
          </p>
          <div className="actions">
            <button
              className="ghost"
              onClick={() => {
                const back = pending.keepTab
                setPending(null)
                if (back) setTab(back)
              }}
            >
              {t('稍后再说')}
            </button>
            <button
              className="primary"
              disabled={busySelf}
              onClick={() => {
                const next = pending.next
                setPending(null)
                void p.onSave(next)
              }}
            >
              {t('保存并重启')}
            </button>
          </div>
        </Modal>
      )}
    </main>
  )
}
