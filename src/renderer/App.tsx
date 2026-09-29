import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { FolderPlus, Settings, X } from 'lucide-react'
import { Sidebar, type AccessLevel, type Project } from './components/Sidebar'
import { moveItem } from './components/useDragSort'
import { ChatView } from './components/ChatView'
import { CodeWorkspace, type CodeControls } from './components/CodeWorkspace'
import { SchedulesView } from './components/SchedulesView'
import { SettingsView } from './components/SettingsView'
import { Titlebar, type CodeTitleInfo, type TitleInfo } from './components/Titlebar'
import { Modal } from './components/Modal'
import { oc, chatProviders, type DeskStatus, type PlatformStatus, type ProviderCfg, type Session, type SettingsCfg } from './oc'
import { getLang, setLang, t, type Lang } from './i18n'
import { load, save } from './store'
import { CUSTOM_ID, THEMES, DEFAULT_THEME_BG, type ThemeBgCfg, type ThemeBgSlot, type ThemeBgMode } from './theme'
import { DEFAULT_CUSTOM, DERIVED_KEYS, deriveVars, type CustomColors } from './themeColors'
import { CODE_STYLES, type CodeStyle } from './codeStyle'

type View = 'chat' | 'settings' | 'schedules'

/** 设置页当前的标签页：由 App 持有，左栏「账号」入口才能直接跳到账号那一页 */
export type SettingsTab = 'theme' | 'providers' | 'skills' | 'mcp' | 'usage' | 'account' | 'about'
export type ProjectSortMode = 'activity' | 'fixed'

/**
 * 外部（对话框里的「配置模型」等）请求打开设置页时带的目标页。
 *
 * tick 必须自增：用户可能本来就停在模型页，再点一次「配置模型」时 tab 值没变，
 * 只看 tab 判别不出"又点了一次"；tick 一变就一定会重新定位。
 */
type SettingsReq = { tab: SettingsTab; tick: number }

type ProjectFiles = { files: string[]; active: string }

const sortSessions = (list: Session[]) =>
  [...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))

/** 兼容旧存档：未知/已删除的主题回落默认「简约浅」；自定义主题单独放行 */
function loadTheme(): string {
  const t = load<string>('qingniao.theme', 'light')
  if (t === CUSTOM_ID) return CUSTOM_ID
  return THEMES.some((x) => x.id === t) ? t : 'light'
}

function isDarkColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return false
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return r * 299 + g * 587 + b * 114 < 140000
}

export default function App() {
  const [lang, setLangState] = useState<Lang>(getLang)
  // 切语言必须先把 i18n 模块变量拨过去再触发重渲染：t() 在渲染期读模块变量，
  // 若只 setState（模块变量在 effect 里才更新），重渲染那一帧整树仍按旧语言渲染，
  // 界面就"点了没反应、再点一下才变"。
  function changeLang(l: Lang) {
    setLang(l)
    setLangState(l)
  }
  const [theme, setTheme] = useState<string>(loadTheme)
  const [custom, setCustom] = useState<CustomColors>(() => load('qingniao.themeColors', DEFAULT_CUSTOM))
  // 主题背景图（设置 → 通用 → 主题背景图）：持久化 themes 目录里的图片路径，data URL 按需经主进程读出
  const [themeBg, setThemeBg] = useState<ThemeBgCfg>(() => {
    const cfg = load<Partial<ThemeBgCfg>>('qingniao.themeBg', DEFAULT_THEME_BG)
    const mode: ThemeBgMode = cfg.mode === 'full' || cfg.mode === 'split' ? cfg.mode : 'none'
    return { mode, full: typeof cfg.full === 'string' ? cfg.full : null, left: typeof cfg.left === 'string' ? cfg.left : null, right: typeof cfg.right === 'string' ? cfg.right : null }
  })
  /** 图片路径 → data URL（SettingsView 缩略图与 CSS 变量共用，路径没变就不重读） */
  const [bgUrls, setBgUrls] = useState<Record<string, string>>({})
  const [codeStyle, setCodeStyle] = useState<CodeStyle>(() => {
    const value = load<string>('qingniao.codeStyle', 'github')
    return CODE_STYLES.some((x) => x.id === value) ? value as CodeStyle : 'github'
  })
  const [view, setView] = useState<View>('chat')
  /** 标题栏左侧的会话标题（首条用户信息）：由 ChatView 上报，切走时它自己清空 */
  const [head, setHead] = useState<TitleInfo | null>(null)
  const [codeInfo, setCodeInfo] = useState<CodeTitleInfo | null>(null)
  const [codeControls, setCodeControls] = useState<CodeControls | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectSortMode, setProjectSortMode] = useState<ProjectSortMode>(() => {
    const value = load<string>('qingniao.projectSortMode', 'activity')
    return value === 'fixed' ? 'fixed' : 'activity'
  })
  /** 对话左侧「-」用户消息导航锚点条显隐：默认不启用，设置 → 通用里开 */
  const [userAnchors, setUserAnchors] = useState<boolean>(() => load('qingniao.userAnchors', false))
  const [projectOrder, setProjectOrder] = useState<string[]>(() => load<string[]>('qingniao.projectOrder', []))
  const [activeId, setActiveId] = useState('')
  /** 每个文件夹独立的展开状态（用户自己点出来的，切视图不影响） */
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => load('qingniao.expanded', {}))
  /** 项目路径 → 会话列表（展开过的项目才有数据） */
  const [sessionsMap, setSessionsMap] = useState<Record<string, Session[]>>({})
  /** 代码模式：普通项目展开后显示文件树，并把编辑器放在对话左侧 */
  const [codeMode, setCodeMode] = useState<boolean>(() => load('qingniao.codeMode', false))
  const [codeFiles, setCodeFiles] = useState<Record<string, ProjectFiles>>(() => load('qingniao.codeFiles', {}))
  const [selectedFile, setSelectedFile] = useState('')
  const [sidebarWidths, setSidebarWidths] = useState(() => {
    const legacy = load<number>('qingniao.sidebarWidth', 260)
    const clampWidth = (value: number) => Math.max(200, Math.min(value, 420))
    return {
      normal: clampWidth(load<number>('qingniao.sidebarWidth.normal', legacy)),
      code: clampWidth(load<number>('qingniao.sidebarWidth.code', legacy))
    }
  })
  const sidebarWidth = sidebarWidths[codeMode ? 'code' : 'normal']
  const [normalChatWidth, setNormalChatWidth] = useState(() => {
    const value = load<number>('qingniao.normalChatWidth', 960)
    return Math.max(640, Math.min(value, 1100))
  })
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = load<number | null>('qingniao.chatWidth', null)
    return typeof saved === 'number'
      ? Math.max(320, saved)
      : Math.max(320, Math.round((window.innerWidth - sidebarWidth - 24) * 0.36))
  })
  const [codeHeadWidth, setCodeHeadWidth] = useState(0)
  /** 项目 id → 最近活动时间（最后一条会话的更新时间，用于左栏排序） */
  const [lastActive, setLastActive] = useState<Record<string, number>>({})
  /** 自增计数：触发 ChatView 聚焦输入框 */
  const [focusTick, setFocusTick] = useState(0)
  /** 自增计数：标题栏「内置浏览器」按钮开/关右侧面板 */
  const [browserSignal, setBrowserSignal] = useState(0)
  /** 自增计数：浏览器打开时标题栏最大化按钮接管面板放大/还原 */
  const [browserMaxSignal, setBrowserMaxSignal] = useState(0)
  /** 浏览器面板开合/放大（ChatView 上报），驱动标题栏浏览器按钮的行为与图标 */
  const [browserUi, setBrowserUi] = useState({ open: false, max: false })
  const [sessionId, setSessionId] = useState('')
  /** 处理中的会话集合（切走也保留，侧栏对应任务行各自显示加载图标；多个任务并行互不覆盖） */
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({})
  const [settings, setSettings] = useState<SettingsCfg>({
    providers: [],
    mcps: [],
    remote: false,
    mobile: false,
    platform: { baseUrl: '', token: '', user: null, models: [], device: null },
    // access 'default' = 写操作要确认（与主进程 DEFAULT_SETTINGS 一致）
    access: 'default',
    // 「永久允许调用其他模型」清单：默认空，AI 每次要调别的模型都会先问
    modelAuth: []
  })
  const [settingsReady, setSettingsReady] = useState(false)
  const [model, setModel] = useState<string>(() => load('qingniao.model', ''))
  /** 设置页标签：放在 App 里，左栏账号入口才能一键跳到「账号」 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('theme')
  /** 外部请求的定位（带自增 tick，重复点同一个入口也能重新跳） */
  const [settingsReq, setSettingsReq] = useState<SettingsReq | null>(null)
  /** 平台登录态：左下角账号入口与账号页共用一份，登录/退出后由主进程推更新 */
  const [platformSt, setPlatformSt] = useState<PlatformStatus | null>(null)
  /** 登录/退出进行中（按钮转圈，避免重复点） */
  const [platformBusy, setPlatformBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const workspaceRef = useRef('')
  /** sessionsMap 的最新镜像：App 级 SSE 监听（只注册一次）里查"某 busy 会话属于哪个目录"用，避免闭包拿到旧值 */
  const sessionsMapRef = useRef(sessionsMap)
  sessionsMapRef.current = sessionsMap
  /** 正在拉取历史的会话 id：点击当帧就标记，会话行高亮不必等数据回来 */
  const [loadingSids, setLoadingSids] = useState<Record<string, boolean>>({})
  /** 移动端接入服务状态（开关/局域网地址/二维码/已配对设备），由主进程持有，左栏手机面板展示 */
  const [mobile, setMobile] = useState<DeskStatus | null>(null)
  const [mobileBusy, setMobileBusy] = useState(false)
  /** 操作失败提示（如「打开文件夹」找不到目录），用自绘弹窗而非原生 alert */
  const [notice, setNotice] = useState('')
  /**
   * 待确认的权限升级：用户点了「完全控制」后先存这里，弹确认框，点确认才真落盘。
   *
   * 为什么不直接切：完全控制意味着 AI 不再问一声就能改**任何文件夹**里的文件。
   * 这是个**后果不可逆且会长期生效**的选择，值得挡一道——用户点错的成本远高于多点一下。
   * 降级到「默认权限」不拦（收权限本来就是安全方向，趁机再确认纯属添乱）。
   */
  const [accessAsk, setAccessAsk] = useState<{ level: AccessLevel } | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    save('qingniao.theme', theme)
    const el = document.documentElement
    if (theme === CUSTOM_ID) {
      // 自定义主题：内联派生变量权重最高，覆盖所有样式表配色
      for (const [k, v] of Object.entries(deriveVars(custom))) el.style.setProperty(k, v)
    } else {
      // 离开自定义主题：清掉内联覆盖，回到内置主题样式表
      for (const k of DERIVED_KEYS) el.style.removeProperty(k)
    }
  }, [theme, custom])

  // 主题背景图：持久化 + 把 themes 目录里的图片路径解析成 data URL 写进 CSS 变量
  // （--side-bg-image 铺到左侧栏，--content-bg-image 铺到右侧内容区；整屏一张时两处同图）
  useEffect(() => { save('qingniao.themeBg', themeBg) }, [themeBg])

  useEffect(() => {
    const el = document.documentElement
    el.dataset.themeBg = themeBg.mode
    let alive = true
    void (async () => {
      // 路径没变就吃缓存，不重复读盘
      const next: Record<string, string> = {}
      for (const slot of ['full', 'left', 'right'] as ThemeBgSlot[]) {
        const path = themeBg[slot]
        if (!path || bgUrls[path]) continue
        const url = await window.qingniao.readThemeBg(path)
        if (!alive) return
        if (url) next[path] = url
      }
      if (!alive) return
      const urls = { ...bgUrls, ...next }
      const imgVar = (path: string | null): string | null => (path && urls[path] ? `url("${urls[path]}")` : null)
      // 整屏一张：左右两块铺同一幅；左右分开：各铺各的；不使用：两侧都不铺
      const sideImg = themeBg.mode === 'split' ? imgVar(themeBg.left) : themeBg.mode === 'full' ? imgVar(themeBg.full) : null
      const contentImg = themeBg.mode === 'full' ? imgVar(themeBg.full) : themeBg.mode === 'split' ? imgVar(themeBg.right) : null
      for (const [k, v] of [['--side-bg-image', sideImg], ['--content-bg-image', contentImg]] as const) {
        if (v) el.style.setProperty(k, v)
        else el.style.removeProperty(k)
      }
      // 右列铺了图才把各层面转半透明（图在 .rightcol 自身，层面不透明就全被盖住）；
      // 左右分开时若只配了左侧，这里保持 off，右列仍是原来的实底色
      el.dataset.bgContent = contentImg ? 'on' : 'off'
      if (Object.keys(next).length) setBgUrls((prev) => ({ ...prev, ...next }))
    })()
    return () => { alive = false }
  }, [themeBg, bgUrls])

  /** 设置 → 通用 → 主题背景图：挑图（主进程复制进 themes 目录）落到对应槽位，data URL 先行用于即时预览 */
  async function pickThemeBg(slot: ThemeBgSlot) {
    try {
      const r = await window.qingniao.pickThemeBg()
      if (!r) return
      setBgUrls((prev) => ({ ...prev, [r.path]: r.url }))
      setThemeBg((c) => ({ ...c, [slot]: r.path }))
    } catch { /* 对话框失败静默 */ }
  }
  function clearThemeBg(slot: ThemeBgSlot) {
    setThemeBg((c) => ({ ...c, [slot]: null }))
  }
  function setThemeBgMode(mode: ThemeBgMode) {
    setThemeBg((c) => ({ ...c, mode }))
  }

  // 语言：模块变量已在事件里拨过（见 changeLang），这里只同步 <html lang>
  useEffect(() => {
    document.documentElement.lang = lang === 'tw' ? 'zh-TW' : lang === 'en' ? 'en' : 'zh-CN'
  }, [lang])

  useEffect(() => save('qingniao.themeColors', custom), [custom])

  useEffect(() => save('qingniao.model', model), [model])

  useEffect(() => save('qingniao.expanded', expanded), [expanded])

  useEffect(() => save('qingniao.projectSortMode', projectSortMode), [projectSortMode])

  useEffect(() => save('qingniao.userAnchors', userAnchors), [userAnchors])

  useEffect(() => save('qingniao.projectOrder', projectOrder), [projectOrder])

  useEffect(() => save('qingniao.codeMode', codeMode), [codeMode])

  useEffect(() => save('qingniao.codeFiles', codeFiles), [codeFiles])

  useEffect(() => {
    document.documentElement.dataset.codeStyle = codeStyle
    const dark = theme === CUSTOM_ID
      ? isDarkColor(custom.bg)
      : THEMES.some((x) => x.id === theme && x.dark)
    document.documentElement.dataset.codeDark = dark ? 'true' : 'false'
    save('qingniao.codeStyle', codeStyle)
  }, [codeStyle, theme, custom.bg])

  useEffect(() => save('qingniao.sidebarWidth.normal', sidebarWidths.normal), [sidebarWidths.normal])

  useEffect(() => save('qingniao.sidebarWidth.code', sidebarWidths.code), [sidebarWidths.code])

  useEffect(() => save('qingniao.normalChatWidth', normalChatWidth), [normalChatWidth])

  useEffect(() => save('qingniao.chatWidth', chatWidth), [chatWidth])

  useEffect(() => {
    if (!codeMode || view !== 'chat') {
      setCodeHeadWidth(0)
      return
    }
    const pane = document.querySelector<HTMLElement>('.code-pane')
    if (!pane) return
    const update = () => setCodeHeadWidth(pane.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [codeMode, view, activeId])

  useEffect(() => {
    if (view !== 'settings' && view !== 'schedules') return
    const close = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSettingsReq(null)
      setView('chat')
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [view])

  // App 级 SSE 监听：busy 事实源与 ChatView 内部事件处理解耦。
  // 侧栏加载图标直接由这里的会话级状态更新，不依赖 ChatView 重新挂载。
  useEffect(() => {
    const off = window.qingniao.onEvent((raw) => {
      const e = raw as { type: string; properties: Record<string, unknown> }
      if (e.type === 'message.part.delta') {
        // 任务在跑：任何 delta 都说明对应会话正在处理
        const pr = e.properties as { sessionID?: string }
        if (pr.sessionID) setBusyIds((m) => (m[pr.sessionID!] ? m : { ...m, [pr.sessionID!]: true }))
      } else if (e.type === 'session.idle' || e.type === 'session.error') {
        const pr = e.properties as { sessionID?: string }
        if (pr.sessionID) {
          setBusyIds((m) => {
            if (!(pr.sessionID! in m)) return m
            const { [pr.sessionID!]: _drop, ...rest } = m
            return rest
          })
          // 一轮对话正常结束：自动把要点追加到项目当日记忆文件（实现「自动记忆」）
          if (e.type === 'session.idle') void autoLogMemory(pr.sessionID)
        }
      } else if (e.type === 'qingniao.sse.reconnected') {
        // SSE 断线重连：断开期间可能漏掉 session.idle，对仍标记 busy 的会话做一次轻量重同步
        // ——仅清"已确实完成"的（最后一条助手消息已有完整文本），绝不凭数据补记 busy。
        setBusyIds((cur) => {
          if (Object.keys(cur).length === 0) return cur
          for (const sid of Object.keys(cur)) {
            const path = Object.keys(sessionsMapRef.current).find((p) =>
              sessionsMapRef.current[p].some((s) => s.id === sid)
            )
            if (!path) continue
            oc.messages(sid, path)
              .then((list) => {
                const last = [...list].reverse().find(
                  (x) => x.info.role === 'assistant' && x.parts.some((pt) => pt.type === 'text' && pt.text)
                )
                if (last) {
                  setBusyIds((m) => {
                    if (!(sid in m)) return m
                    const { [sid]: _drop, ...rest } = m
                    return rest
                  })
                }
              })
              .catch(() => { /* 拉取失败不处理，下次重连再对账 */ })
          }
          return cur
        })
      }
    })
    return off
  }, [])

  // 初始加载：项目 + 本地设置；激活项目默认展开（仅首次无存档时）
  // 不预设任何普通项目，但**始终种一个「任务」目录**（内核 workspace，主进程已创建）：
  // 列表永不为空，用户任何时候都有落脚点；它不可移除（builtin 标记），且恒排在最前
  useEffect(() => {
    ;(async () => {
      // 会话列表的「已展开条数」已改为每次启动从 5 重新开始，旧存档留着只会误导，清掉
      localStorage.removeItem('qingniao.sessShown')
      const info = await window.qingniao.info()
      workspaceRef.current = info.workspace
      const builtin: Project = {
        id: 'builtin',
        path: info.workspace,
        // 名字固定「任务」：它是内置的落脚点，不是用户选的某个文件夹，
        // 叫「默认」反而像"某个默认文件夹"，叫「任务」才点明「这里是放任务的」
        name: t('任务'),
        added: 0,
        builtin: true
      }
      const ps = [
        builtin,
        // 老存档里可能还留着旧名字（曾叫「默认」）与失效的 builtin 标记，一律以这里种下的为准
        ...load<Project[]>('qingniao.projects', [])
          .filter((x) => x.id !== 'workbench' && x.id !== builtin.id && x.path !== builtin.path)
          .map((x) => (x.builtin ? { ...x, builtin: undefined } : x))
      ]
      setProjects(ps)
      if (projectSortMode === 'fixed' && projectOrder.length === 0) {
        setProjectOrder(ps.filter((x) => !x.builtin && x.id !== 'builtin').map((x) => x.id))
      }
      const stored = load<string>('qingniao.activeProject', '')
      const act = ps.some((x) => x.id === stored) ? stored : builtin.id
      setActiveId(act)
      const activePath = ps.find((x) => x.id === act)?.path ?? ''
      setSelectedFile(codeFiles[activePath]?.active ?? '')
      const exp = load<Record<string, boolean>>('qingniao.expanded', {})
      if (!Object.keys(exp).length && act) setExpanded({ [act]: true })
      setSettings(await window.qingniao.getSettings())
      setSettingsReady(true)
    })()
  }, [])

  async function loadProjectSessions(proj: Project): Promise<void> {
    try {
      const list = sortSessions(await oc.sessions(proj.path))
      setSessionsMap((m) => ({ ...m, [proj.path]: list }))
      touchActive(proj, list)
    } catch { /* 项目未展开时静默失败 */ }
  }

  /** 记录项目最近活动时间 = 最新会话更新时间（无会话则回退添加时间） */
  function touchActive(proj: Project, list: Session[]) {
    const t = list.length ? (list[0].time?.updated ?? 0) : 0
    setLastActive((a) => ({ ...a, [proj.id]: Math.max(t, a[proj.id] ?? 0, proj.added ?? 0) }))
  }

  // 启动/项目变化时全量扫一遍活动时间（决定侧栏排序）
  useEffect(() => {
    ;(async () => {
      for (const proj of projects) {
        try {
          touchActive(proj, sortSessions(await oc.sessions(proj.path)))
        } catch { /* 忽略单个项目失败 */ }
      }
    })()
  }, [projects])

  // 项目会话按需加载；代码树由 Sidebar 在普通项目展开时独立懒加载
  useEffect(() => {
    const proj = projects.find((x) => x.id === activeId)
    if (proj && expanded[proj.id] && !(proj.path in sessionsMap)) void loadProjectSessions(proj)
  }, [projects, expanded, activeId])

  const activeProject = projects.find((x) => x.id === activeId)

  /**
   * 打开设置页并定位到某一页（对话框里的「配置模型」、左栏账号入口都走这里）。
   *
   * 设置用居中浮层展示，背后对话保持挂载；关闭统一走 toChat()，顺手清掉定位请求。
   */
  function openSettingsAt(t: SettingsTab) {
    setSettingsTab(t)
    setSettingsReq((r) => ({ tab: t, tick: (r?.tick ?? 0) + 1 }))
    setView('settings')
  }

  /** 进对话：关闭设置浮层与计划任务列表页（关闭设置 / 点任务 / 点项目 / 新建会话都用它） */
  function toChat() {
    setSettingsReq(null)
    setView('chat')
  }

  function toggleCodeMode() {
    const next = !codeMode
    setCodeMode(next)
    toChat()
    if (!next) return
    const proj = projects.find((x) => x.id === activeId)
    if (!proj) return
    setExpanded((e) => ({ ...e, [proj.id]: true }))
  }

  function startColumnResize(e: ReactPointerEvent<HTMLDivElement>, target: 'sidebar' | 'chat'): void {
    e.preventDefault()
    const resizer = e.currentTarget
    const pointerId = e.pointerId
    resizer.setPointerCapture(pointerId)
    const shield = document.createElement('div')
    shield.className = 'drag-shield'
    document.body.appendChild(shield)
    const startX = e.clientX
    const mode = codeMode ? 'code' : 'normal'
    const startWidth = target === 'sidebar' ? sidebarWidths[mode] : chatWidth
    const content = document.querySelector<HTMLElement>('.content')
    const contentWidth = content?.getBoundingClientRect().width ?? window.innerWidth
    const move = (ev: PointerEvent) => {
      const delta = ev.clientX - startX
      if (target === 'sidebar') {
        setSidebarWidths((current) => ({
          ...current,
          [mode]: Math.max(200, Math.min(startWidth + delta, 420))
        }))
      } else {
        setChatWidth(Math.max(320, Math.min(startWidth - delta, contentWidth - 260)))
      }
    }
    const stop = (ev: PointerEvent) => {
      resizer.removeEventListener('pointermove', move)
      resizer.removeEventListener('pointerup', stop)
      resizer.removeEventListener('pointercancel', stop)
      if (resizer.hasPointerCapture(ev.pointerId)) resizer.releasePointerCapture(ev.pointerId)
      shield.remove()
    }
    resizer.addEventListener('pointermove', move)
    resizer.addEventListener('pointerup', stop)
    resizer.addEventListener('pointercancel', stop)
  }

  function rememberFile(projectPath: string, filePath: string) {
    setCodeFiles((current) => {
      const previous = current[projectPath] ?? { files: [], active: '' }
      const files = previous.files.includes(filePath) ? previous.files : [...previous.files, filePath]
      return { ...current, [projectPath]: { files, active: filePath } }
    })
  }

  function selectCodeFile(filePath: string) {
    setSelectedFile(filePath)
    if (activeProject) {
      setCodeFiles((current) => {
        const previous = current[activeProject.path] ?? { files: [], active: '' }
        const files = filePath && !previous.files.includes(filePath)
          ? [...previous.files, filePath]
          : previous.files
        return { ...current, [activeProject.path]: { files, active: filePath } }
      })
    }
  }

  function setProjectFiles(projectPath: string, files: string[], active: string) {
    setCodeFiles((current) => ({ ...current, [projectPath]: { files, active } }))
  }

  function pickFile(proj: Project, filePath: string) {
    setActiveId(proj.id)
    save('qingniao.activeProject', proj.id)
    rememberFile(proj.path, filePath)
    setSelectedFile(filePath)
    toChat()
  }

  /**
   * 点击文件夹：切换展开状态；点到别的项目时同步激活并进草稿态——
   * 否则右侧还挂着旧项目的会话（sessionId 未清），发消息会串进别的任务里。
   */
  function toggleProject(id: string) {
    const willExpand = !expanded[id]
    setExpanded((e) => ({ ...e, [id]: willExpand }))
    const proj = projects.find((x) => x.id === id)
    if (proj && !(proj.path in sessionsMap)) void loadProjectSessions(proj)
    if (id !== activeId) {
      setActiveId(id)
      save('qingniao.activeProject', id)
      setSessionId('')
      setSelectedFile(proj ? codeFiles[proj.path]?.active ?? '' : '')
      toChat()
    }
  }

  /**
   * 左栏顶部「新建任务」：固定落在内置的「任务」目录。
   *
   * 它跟项目行的「添加任务」是同一个动作（进草稿态，真正的内核会话等第一条消息才创建），
   * 只是目标目录恒为默认那个——用户点顶上的按钮时并没有挑目录。
   * 另外它**不展开**目录：手已经落在输入框上了，摊开一长串历史会话只是挡视线。
   */
  function newTask() {
    newSessionFor(projects.find((x) => x.builtin)?.id ?? 'builtin', false)
  }

  /**
   * 项目行「新会话」：进草稿态（不创建内核会话），右侧开聊。
   *
   * @param expand 是否顺手展开该目录。**两种入口不一样**：
   *   项目行上的「添加任务」要展开——用户正盯着这个目录，摊开列表才能看见刚建的活；
   *   顶部「新建任务」不展开——他只是说"我要开个活"，被摊开的一长串历史会话反而占视线，
   *   要看列表时自己点一下「任务」那一行即可。
   */
  function newSessionFor(id: string, expand = true) {
    const proj = projects.find((x) => x.id === id)
    if (!proj) return
    setActiveId(id)
    save('qingniao.activeProject', id)
    // 不展开时连 setExpanded 都不调用：给个同值新对象也会触发一次存档写入，没意义
    if (expand) setExpanded((e) => ({ ...e, [id]: true }))
    setSessionId('')
    if (id !== activeId) setSelectedFile(codeFiles[proj.path]?.active ?? '')
    toChat()
    setFocusTick((t) => t + 1)
  }

  /** 点任务行：打开该会话（跨项目也先激活其项目），右侧切回对话 */
  function pickSessionFor(proj: Project, sid: string) {
    setActiveId(proj.id)
    save('qingniao.activeProject', proj.id)
    setSessionId(sid)
    if (proj.id !== activeId) setSelectedFile(codeFiles[proj.path]?.active ?? '')
    toChat()
    setFocusTick((t) => t + 1)
    const projList = sessionsMap[proj.path]
    if (!projList?.some((s) => s.id === sid)) {
      // 会话历史尚未拉回：先标记加载中让左侧立即高亮，拉回后解除
      setLoadingSids((m) => ({ ...m, [sid]: true }))
      loadProjectSessions(proj).then(() =>
        setLoadingSids((m) => {
          const { [sid]: _drop, ...rest } = m
          return rest
        })
      )
    }
  }

  /** 计划任务启动后只展开左侧「任务」目录，不切换当前会话窗口 */
  function showScheduleSessionInSidebar() {
    const proj = projects.find((x) => x.builtin) ?? projects.find((x) => x.id === 'builtin')
    if (proj) setExpanded((e) => ({ ...e, [proj.id]: true }))
  }

  async function deleteSessionOf(proj: Project, sid: string) {
    try {
      await oc.deleteSession(sid, proj.path)
    } catch { /* 内核已无此会话时忽略 */ }
    if (sid === sessionId) setSessionId('')
    loadProjectSessions(proj)
  }

  function setProjectsPersisted(ps: Project[]) {
    setProjects(ps)
    save('qingniao.projects', ps)
  }

  function changeProjectSortMode(mode: ProjectSortMode) {
    setProjectSortMode(mode)
    if (mode === 'fixed' && projectOrder.length === 0) {
      setProjectOrder(projects.filter((x) => !x.builtin && x.id !== 'builtin').map((x) => x.id))
    }
  }

  async function addProject() {
    // 允许访问的范围由系统权限对话框决定（macOS 在那里勾「完全访问」即可；Windows/Linux
    // 的 showOpenDialog 本身就是完整授权），所以这里不做二次校验、也不因为"访问受限"就拒绝加入——
    // 加了但读不到时，报错由内核在真正读写时给出，比在这里猜更准确。
    let path: string | null
    try {
      path = await window.qingniao.pickDir()
    } catch (e) {
      // 对话框本身没弹出来（极少见）：必须说一声，否则点完毫无动静像卡死
      setNotice(t('没能打开选择文件夹对话框：{msg}', { msg: e instanceof Error ? e.message : String(e) }))
      return
    }
    if (!path) return // 用户取消
    // 已在列表里：不重复添加，但要**切过去**——用户点它就是想用它，
    // 静默 return 会让人以为没点动（尤其是已存在的目录在列表下方时）
    const exist = projects.find((x) => x.path === path)
    if (exist) {
      setActiveId(exist.id)
      save('qingniao.activeProject', exist.id)
      setExpanded((e) => ({ ...e, [exist.id]: true }))
      setSessionId('')
      if (exist.id !== activeId) setSelectedFile(codeFiles[exist.path]?.active ?? '')
      toChat()
      setFocusTick((t) => t + 1)
      return
    }
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
    const proj: Project = { id: 'p' + Date.now(), path, name, added: Date.now() }
    // 新加的项目要顶到最前（仅次「任务」目录），所以 added 得压过现有项目的活动时间：
    // 用 now 与「已有最大活动时间 + 1」取大值，避免刚加完就被一个刚聊过的老项目挤下去
    const top = Math.max(Date.now(), ...projects.map((x) => lastActive[x.id] ?? x.added ?? 0)) + 1
    proj.added = top
    if (projectSortMode === 'fixed') {
      setProjectOrder((order) => [proj.id, ...order.filter((id) => id !== proj.id)])
    }
    setProjectsPersisted([...projects, proj])
    setLastActive((a) => ({ ...a, [proj.id]: top }))
    setActiveId(proj.id)
    save('qingniao.activeProject', proj.id)
    setExpanded((e) => ({ ...e, [proj.id]: true }))
    setSessionId('')
    setSelectedFile('')
    toChat()
  }

  /**
   * 移除项目：允许移除到「只剩任务目录」。
   * 任务目录（builtin）是内核 workspace，也是列表最后的落脚点，**直接拒绝移除**——
   * 否则用户能把目录清空，之后连往哪干活都没了（UI 侧右键菜单里根本不显示这一项，
   * 这里再兜一次；id 一并认，标记万一丢了也不会被误删）。
   */
  function removeProject(id: string) {
    const target = projects.find((x) => x.id === id)
    if (!target || target.builtin || target.id === 'builtin') return
    const next = projects.filter((x) => x.id !== id)
    setProjectOrder((order) => order.filter((x) => x !== id))
    setProjectsPersisted(next)
    setExpanded((e) => {
      const { [id]: _drop, ...rest } = e
      return rest
    })
    setCodeFiles((current) => {
      const { [target.path]: _drop, ...rest } = current
      return rest
    })
    if (activeId === id) {
      const nid = next[0]?.id ?? 'builtin'
      const nextProject = next.find((x) => x.id === nid)
      setActiveId(nid)
      save('qingniao.activeProject', nid)
      setSessionId('')
      setSelectedFile(nextProject ? codeFiles[nextProject.path]?.active ?? '' : '')
    }
  }

  /** 草稿首发：内核会话此刻才创建，进列表并打开 */
  function onDraftCreated(s: Session) {
    const path = activeProject?.path
    if (!path) return
    setSessionId(s.id)
    setSessionsMap((m) => ({ ...m, [path]: sortSessions([s, ...(m[path] ?? [])]) }))
    setExpanded((e) => ({ ...e, [activeId]: true }))
    setLastActive((a) => ({ ...a, [activeId]: Date.now() }))
  }

  function refreshSessions() {
    const proj = activeProject
    if (!proj) return
    // 任务完成后的刷新只补充新会话，不整表覆盖：内核偶发漏返回/排序延迟时，
    // 不能把用户已在看的任务行清掉；真正删除会话仍走 loadProjectSessions 的权威同步。
    oc.sessions(proj.path)
      .then((raw) => {
        const list = sortSessions(raw)
        setSessionsMap((m) => {
          const existing = m[proj.path] ?? []
          const merged = [...existing]
          for (const s of list) if (!merged.some((x) => x.id === s.id)) merged.push(s)
          return { ...m, [proj.path]: sortSessions(merged) }
        })
        touchActive(proj, list)
      })
      .catch(() => {})
  }

  /** 一轮对话正常结束：把要点追加到项目当日记忆文件（<项目>/.qingniao/memory/YYYY-MM-DD.md），实现「自动记忆」；
   *  长期记忆 MEMORY.md 由 AI 在工作过程中自行维护（新对话会注入维护指引）。 */
  async function autoLogMemory(sid: string) {
    const path = Object.keys(sessionsMapRef.current).find((p) =>
      sessionsMapRef.current[p].some((s) => s.id === sid)
    )
    if (!path) return
    try {
      const list = await oc.messages(sid, path)
      const lastUser = [...list].reverse().find((m) => m.info.role === 'user')
      const lastAsst = [...list].reverse().find((m) => m.info.role === 'assistant')
      const u = lastUser ? lastUser.parts.filter((x) => x.type === 'text').map((x) => x.text).join('').slice(0, 200) : ''
      const a = lastAsst ? lastAsst.parts.filter((x) => x.type === 'text').map((x) => x.text).join('').slice(0, 300) : ''
      if (!u && !a) return
      await window.qingniao.appendMemory(path, `**用户**：${u}\n\n**AI**：${a}`)
    } catch {
      /* 记忆写入失败不影响对话 */
    }
  }

  async function saveSettingsAll(next: SettingsCfg) {
    setSaving(true)
    // 先落 UI 状态：开关即刻翻转（乐观更新），内核重启在后台完成
    setSettings(next)
    try {
      // 主进程写 ~/.qingniaoai 即返回（内核重启转后台进行，通常数秒）；
      // 重启完成的界面刷新走 qingniao.kernel.started / kernel.unhealthy 事件桥
      await window.qingniao.saveSettings(next)
    } catch (e) {
      // 重启失败/超时：回读磁盘上的真实设置，并弹窗说清原因——不然按钮一转就再没下文，
      // 用户只能对着转圈的「保存并重启内核…」干等
      const msg = e instanceof Error ? e.message : String(e)
      setSettings(await window.qingniao.getSettings())
      setNotice(t('设置已写入，但内核没能重启成功：{msg}。可以重新保存一次，或重启本应用。', { msg }))
      throw e
    } finally {
      setSaving(false)
    }
  }

  // 移动端接入：服务/设备身份都在主进程，这里只负责展示与开关。
  // 启动读一次状态；之后设备注册完成、通道报错都由主进程推过来（登录后二维码就靠这条推上来的）。
  useEffect(() => {
    void window.qingniao
      .mobileStatus()
      .then(setMobile)
      .catch(() => undefined)

    return window.qingniao.onMobileChanged(setMobile)
  }, [])

  // 项目列表要推给主进程：移动端服务读不到渲染层 localStorage，没这份清单就不知道能操作哪些目录
  useEffect(() => {
    void window.qingniao.mobileSetProjects(projects.map((x) => ({ id: x.id, path: x.path, name: x.name })))
  }, [projects])

  // 计划任务在后台（托盘驻留时）到点执行：主进程推过来后，补拉内置「任务」目录的会话列表，
  // 新出现的「[计划] xxx」会话展开目录即可见（与 refreshSessions 同样的只补不覆盖合并）；
  // 同时自增 tick 让计划任务列表页重读一次，「上次执行/失败」不会停在旧值。
  // 补跑那次的辨识靠会话标题里的「[补跑]…（原定 …）」，不在这里弹窗打扰（notice 是阻塞式 Modal）。
  const [schedTick, setSchedTick] = useState(0)
  useEffect(() => {
    const off = window.qingniao.onScheduleRan(() => {
      setSchedTick((t) => t + 1)
      const path = workspaceRef.current
      if (!path) return
      oc.sessions(path)
        .then((raw) => {
          const list = sortSessions(raw)
          setSessionsMap((m) => {
            const merged = [...(m[path] ?? [])]
            for (const s of list) if (!merged.some((x) => x.id === s.id)) merged.push(s)
            return { ...m, [path]: sortSessions(merged) }
          })
        })
        .catch(() => {})
    })
    return off
  }, [])

  async function mobileAction(fn: () => Promise<DeskStatus>): Promise<void> {
    setMobileBusy(true)
    try {
      setMobile(await fn())
    } finally {
      setMobileBusy(false)
    }
  }

  // 平台登录态：启动读一次；登录/退出的变化由主进程推过来（协议回调发生在主进程，渲染层看不到）。
  // 登录态一变，模型清单跟着变（「内置模型」分组要靠它），设备身份也一起变（二维码跟着变），所以都回读一遍。
  useEffect(() => {
    void window.qingniao
      .platformStatus()
      .then(setPlatformSt)
      .catch(() => undefined)

    return window.qingniao.onPlatformChanged((s) => {
      setPlatformSt(s)
      void window.qingniao.getSettings().then(setSettings)
      void window.qingniao.mobileStatus().then(setMobile).catch(() => undefined)
    })
  }, [])

  async function platformAction(fn: () => Promise<PlatformStatus>): Promise<void> {
    setPlatformBusy(true)
    try {
      setPlatformSt(await fn())
      setSettings(await window.qingniao.getSettings())
      setMobile(await window.qingniao.mobileStatus())
    } finally {
      setPlatformBusy(false)
    }
  }

  /** 左栏右键「打开文件夹」：在系统文件管理器里定位项目目录，失败时用自绘弹窗说明原因 */
  async function openFolder(proj: Project): Promise<void> {
    const err = await window.qingniao.openFolder(proj.path)
    if (err) setNotice(err)
  }

  /** 全局访问权限档位（权限对所有文件夹生效，不跟项目走） */
  const access: AccessLevel = settings.access === 'full' ? 'full' : 'default'

  /**
   * 拨访问权限档位。
   *
   * 升级到「完全控制」先弹确认（见 accessAsk 注释），降级直接生效。
   * 落盘后立刻回读设置——权限写的是 `settings.access`，不回读的话 UI 上的选中态
   * 要等下一次整体刷新才跟着变，看着像没点动。
   * 生效需要重载内核配置，这一步由主进程在落盘后自动重启内核完成（用户不需要手动做什么）。
   */
  async function setAccess(level: AccessLevel) {
    if (level === 'full' && access !== 'full') {
      setAccessAsk({ level })
      return
    }
    setSettings(await window.qingniao.setAccess(level))
  }

  /** 确认框点「确认」：真正落盘，主进程会自动重启内核让权限生效 */
  async function applyAccess() {
    const ask = accessAsk
    setAccessAsk(null)
    if (!ask) return
    setSettings(await window.qingniao.setAccess(ask.level))
    setNotice(t('已切换为「完全控制」：AI 读写文件、执行命令、调用其他模型都不再询问（对所有文件夹生效）。'))
  }

  // 展示顺序：自动模式按最近有对话活动的文件夹排最前，固定模式按用户拖拽的顺序；
  // 「任务」目录（builtin）无论哪种模式都永远钉在最上面。
  const codeWorkspaceVisible = view === 'chat' && codeMode && !!activeProject && !activeProject.builtin
  const projectOrderIndex = new Map(projectOrder.map((id, i) => [id, i]))

  const orderedProjects = [...projects].sort((a, b) => {
    const builtin = Number(!!b.builtin || b.id === 'builtin') - Number(!!a.builtin || a.id === 'builtin')
    if (builtin) return builtin
    if (projectSortMode === 'fixed') {
      return (projectOrderIndex.get(a.id) ?? projectOrder.length) - (projectOrderIndex.get(b.id) ?? projectOrder.length)
    }
    return (lastActive[b.id] ?? b.added ?? 0) - (lastActive[a.id] ?? a.added ?? 0)
  })

  function reorderProjects(from: number, to: number) {
    if (projectSortMode !== 'fixed') return
    const current = orderedProjects.filter((x) => !x.builtin && x.id !== 'builtin').map((x) => x.id)
    setProjectOrder(moveItem(current, from, to))
  }
  const rightcolStyle = codeWorkspaceVisible
    ? ({ '--code-head-width': `${codeHeadWidth}px` } as CSSProperties)
    : undefined
  const chatPaneStyle = codeWorkspaceVisible
    ? { flex: `0 1 ${chatWidth}px`, width: chatWidth, minWidth: 320 }
    : ({ '--chat-content-width': `${normalChatWidth}px` } as CSSProperties)

  return (
    <div className="shell">
      <div className="app">
        <Sidebar
          projects={orderedProjects}
          activeId={activeId}
          expanded={expanded}
          sessionsMap={sessionsMap}
          sessionId={sessionId}
          busyIds={busyIds}
          loadingSids={loadingSids}
          view={view}
          codeMode={codeMode}
          width={sidebarWidth}
          selectedFile={selectedFile}
          onToggleCodeMode={toggleCodeMode}
          onPickFile={pickFile}
          onToggleProject={toggleProject}
          onRemoveProject={removeProject}
          onNewSession={newSessionFor}
          onNewTask={newTask}
          onAddProject={addProject}
          onPickSession={pickSessionFor}
          onDeleteSession={deleteSessionOf}
          onOpenSettings={() => openSettingsAt('theme')}
          onOpenFolder={openFolder}
          projectSortMode={projectSortMode}
          onReorderProjects={reorderProjects}
          mobile={mobile}
          mobileBusy={mobileBusy}
          onMobileToggle={(on) => void mobileAction(() => window.qingniao.mobileSet(on))}
          onMobileRotate={() => void mobileAction(() => window.qingniao.mobileRotate())}
          platform={platformSt}
          platformBusy={platformBusy}
          onLogin={() => void platformAction(() => window.qingniao.platformLogin())}
          onOpenAccount={() => openSettingsAt('account')}
          /** 远程服务总开关（全局配置）：关掉后登录入口与手机图标一并消失 */
          remote={settings.remote}
          onOpenSchedules={() => setView('schedules')}
        />
        <div
          className="side-resizer"
          title={t('拖拽调整侧栏宽度')}
          onPointerDown={(e) => startColumnResize(e, 'sidebar')}
        />
        {/* 右列 = 标题栏 + 内容区：侧栏独占左侧全高，标题栏不再横贯整窗 */}
        <div className={'rightcol' + (codeWorkspaceVisible ? ' code-mode-layout' : '')} style={rightcolStyle}>
        <Titlebar
          title={view === 'chat' && !codeWorkspaceVisible ? head : null}
          onToggleBrowser={() => setBrowserSignal((v) => v + 1)}
          browserOpen={browserUi.open}
          browserMax={browserUi.max}
          showBrowser={!codeMode}
          codeInfo={codeWorkspaceVisible ? codeInfo : null}
          codeControls={codeWorkspaceVisible ? codeControls : null}
          onBrowserMax={() => setBrowserMaxSignal((v) => v + 1)}
        />
        <div className="content">
          {codeWorkspaceVisible && activeProject ? (
            <CodeWorkspace
              key={activeProject.id}
              project={activeProject}
              filePath={selectedFile}
              openFiles={codeFiles[activeProject.path]?.files ?? []}
              onActiveFile={selectCodeFile}
              onStatusChange={setCodeInfo}
              onControlsChange={setCodeControls}
              onOpenFilesChange={(paths) => {
                const active = paths.includes(selectedFile) ? selectedFile : paths[paths.length - 1] ?? ''
                setProjectFiles(activeProject.path, paths, active)
              }}
            />
          ) : null}
          {codeWorkspaceVisible && (
            <div
              className="work-resizer"
              title={t('拖拽调整代码与对话宽度')}
              onPointerDown={(e) => startColumnResize(e, 'chat')}
            />
          )}
          <div
            className="chat-pane"
            style={chatPaneStyle}
          >
            {/* 模型清单走 chatProviders()：平台「内置模型」固定排最前，用户自建提供商接在后面 */}
            {activeProject ? (
              <ChatView
                project={activeProject}
                projects={orderedProjects}
                sessionId={sessionId}
                session={activeProject ? sessionsMap[activeProject.path]?.find((s) => s.id === sessionId) : undefined}
                model={model}
                onModelChange={setModel}
                settings={chatProviders(settings)}
                settingsReady={settingsReady}
                onDraftCreated={onDraftCreated}
                onRefreshSessions={refreshSessions}
                onBusy={(sid, running) =>
                  setBusyIds((m) => {
                    if (running) return { ...m, [sid]: true }
                    if (!(sid in m)) return m
                    const { [sid]: _drop, ...rest } = m
                    return rest
                  })
                }
                focusSignal={focusTick}
                browserToggleSignal={browserSignal}
                browserMaxSignal={browserMaxSignal}
                codeMode={codeMode}
                showUserAnchors={userAnchors}
                onBrowserUi={setBrowserUi}
                onHead={setHead}
                onOpenSettings={() => openSettingsAt('providers')}
                onPickDir={addProject}
                onSwitchProject={(id) => {
                  if (id === activeId) return
                  setActiveId(id)
                  save('qingniao.activeProject', id)
                  setSessionId('')
                  const nextProject = projects.find((x) => x.id === id)
                  setSelectedFile(nextProject ? codeFiles[nextProject.path]?.active ?? '' : '')
                  toChat()
                  setFocusTick((t) => t + 1)
                }}
              />
            ) : (
              <Welcome onAddProject={addProject} onOpenSettings={() => openSettingsAt('providers')} />
            )}
          </div>
        </div>
        </div>
      </div>

      {view === 'schedules' && (
        <div
          className="settings-mask"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setView('chat')
          }}
        >
          <div className="schedules-layer" role="dialog" aria-modal="true" aria-label={t('计划任务')}>
            <SchedulesView
              refreshSignal={schedTick}
              onTaskSessionCreated={showScheduleSessionInSidebar}
              onNotice={setNotice}
              onClose={() => setView('chat')}
            />
          </div>
        </div>
      )}

      {view === 'settings' && (
        <div
          className="settings-mask"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) toChat()
          }}
        >
          <div className="settings-layer" role="dialog" aria-modal="true" aria-label={t('设置')}>
            <header className="settings-head">
              <h3>{t('设置')}</h3>
              <button className="icon-btn" onClick={toChat} title={t('关闭')}>
                <X size={17} />
              </button>
            </header>
            <SettingsView
              settings={settings}
              onSave={saveSettingsAll}
              saving={saving}
              theme={theme}
              onTheme={setTheme}
              custom={custom}
              onCustom={(k, v) => setCustom((c) => ({ ...c, [k]: v }))}
              onResetCustom={() => setCustom(DEFAULT_CUSTOM)}
              themeBg={themeBg}
              bgUrls={bgUrls}
              onThemeBgPick={pickThemeBg}
              onThemeBgClear={clearThemeBg}
              onThemeBgMode={setThemeBgMode}
              codeStyle={codeStyle}
              onCodeStyle={setCodeStyle}
               normalChatWidth={normalChatWidth}
               onNormalChatWidth={setNormalChatWidth}
              projectSortMode={projectSortMode}
              onProjectSortMode={changeProjectSortMode}
              userAnchors={userAnchors}
              onUserAnchors={setUserAnchors}
              onAccess={setAccess}
              lang={lang}
              onLang={changeLang}
               projectPath={activeProject?.path ?? null}
              projectName={activeProject?.name ?? null}
              model={model}
              tab={settingsTab}
              onTab={setSettingsTab}
              req={settingsReq}
              platform={platformSt}
              platformBusy={platformBusy}
              onLogin={() => void platformAction(() => window.qingniao.platformLogin())}
              onLogout={() => void platformAction(() => window.qingniao.platformLogout())}
              onSetBaseUrl={(url) => void platformAction(() => window.qingniao.platformSetBaseUrl(url))}
              onSubmitCode={(code) => void platformAction(() => window.qingniao.platformSubmitCode(code))}
            />
          </div>
        </div>
      )}

      {notice && (
        <Modal title={t('操作没成功')} onClose={() => setNotice('')}>
          <p className="confirm-text">{notice}</p>
          <div className="actions">
            <button className="primary" onClick={() => setNotice('')}>
              {t('知道了')}
            </button>
          </div>
        </Modal>
      )}

      {/* 切「完全控制」前的确认：把后果说清（不再询问、影响所有文件夹），让用户明确点一下 */}
      {accessAsk && (
        <Modal title={t('切换为完全控制？')} onClose={() => setAccessAsk(null)}>
          <p className="confirm-text">
            {t('访问权限将改为')}<strong>{t('完全控制')}</strong>{t('：AI 之后读写文件、执行命令都')}
            <strong>{t('不再先问你')}</strong>{t('，直接动手。')}
          </p>
          <p className="confirm-text">
            {t('这一档也是')}<strong>{t('总权限闸')}</strong>{t('：识图、生图/视频、配音、语音识别这类「调用别的模型」同样')}
            <strong>{t('不再弹授权卡')}</strong>{t('——你给的已经是全部权限了。')}
          </p>
          <p className="confirm-text hint">
            {t('这条权限对所有文件夹生效，不是只对当前项目。如果只是想让它改一次，保持「默认权限」、在弹确认时点「仅这一次」更稳妥。')}
          </p>
          <div className="actions">
            <button className="ghost" onClick={() => setAccessAsk(null)}>
              {t('取消')}
            </button>
            <button className="primary danger-btn" onClick={() => void applyAccess()}>
              {t('确认切换')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** 左栏没有项目时的引导页：不预设默认项目，让用户自己挑工作目录 */
function Welcome({ onAddProject, onOpenSettings }: { onAddProject: () => void; onOpenSettings: () => void }) {
  return (
    <main className="main">
      <div className="welcome">
        <div className="welcome-inner">
          <h2>{t('先添加一个项目文件夹')}</h2>
          <p>
            {t('选择要干活的目录，会话与文件操作都在该目录内进行。')}
            <br />
            {t('还没有配置模型的话，先去设置里添一个提供商。')}
          </p>
          <div className="welcome-acts">
            <button className="primary" onClick={onAddProject}>
              <FolderPlus size={15} /> {t('添加项目')}
            </button>
            <button className="ghost" onClick={onOpenSettings}>
              <Settings size={15} /> {t('打开设置')}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
