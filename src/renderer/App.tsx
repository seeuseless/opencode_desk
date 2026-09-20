import { useEffect, useRef, useState } from 'react'
import { FolderPlus, Settings } from 'lucide-react'
import { Sidebar, type Project } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SettingsView } from './components/SettingsView'
import { Titlebar } from './components/Titlebar'
import { Modal } from './components/Modal'
import { oc, chatProviders, type DeskStatus, type PlatformStatus, type ProviderCfg, type Session, type SettingsCfg } from './oc'
import { load, save } from './store'
import { CUSTOM_ID, THEMES } from './theme'
import { DEFAULT_CUSTOM, DERIVED_KEYS, deriveVars, type CustomColors } from './themeColors'

type View = 'chat' | 'settings'

/** 设置页当前的标签页：由 App 持有，左栏「账号」入口才能直接跳到账号那一页 */
export type SettingsTab = 'theme' | 'providers' | 'skills' | 'mcp' | 'usage' | 'account'

/**
 * 外部（对话框里的「配置模型」等）请求打开设置页时带的目标页。
 *
 * tick 必须自增：用户可能本来就停在模型页，再点一次「配置模型」时 tab 值没变，
 * 只看 tab 判别不出"又点了一次"；tick 一变就一定会重新定位。
 */
type SettingsReq = { tab: SettingsTab; tick: number }

const sortSessions = (list: Session[]) =>
  [...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))

/** 兼容旧存档：未知/已删除的主题回落默认「简约浅」；自定义主题单独放行 */
function loadTheme(): string {
  const t = load<string>('qingniao.theme', 'light')
  if (t === CUSTOM_ID) return CUSTOM_ID
  return THEMES.some((x) => x.id === t) ? t : 'light'
}

export default function App() {
  const [theme, setTheme] = useState<string>(loadTheme)
  const [custom, setCustom] = useState<CustomColors>(() => load('qingniao.themeColors', DEFAULT_CUSTOM))
  const [view, setView] = useState<View>('chat')
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState('')
  /** 每个文件夹独立的展开状态（用户自己点出来的，切视图不影响） */
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => load('qingniao.expanded', {}))
  /** 项目路径 → 会话列表（展开过的项目才有数据） */
  const [sessionsMap, setSessionsMap] = useState<Record<string, Session[]>>({})
  /** 项目 id → 最近活动时间（最后一条会话的更新时间，用于左栏排序） */
  const [lastActive, setLastActive] = useState<Record<string, number>>({})
  /** 自增计数：触发 ChatView 聚焦输入框 */
  const [focusTick, setFocusTick] = useState(0)
  /** 自增计数：标题栏「内置浏览器」按钮开/关右侧面板 */
  const [browserSignal, setBrowserSignal] = useState(0)
  /** 自增计数：浏览器打开时标题栏最大化按钮接管面板放大/还原 */
  const [browserMaxSignal, setBrowserMaxSignal] = useState(0)
  /** 自增计数：全屏浏览时标题栏「AI 对话」按钮收起/展开右下角浮动对话卡 */
  const [floatSignal, setFloatSignal] = useState(0)
  /** 浏览器面板开合/放大/浮动对话卡/对话彻底隐藏（ChatView 上报），驱动标题栏按钮行为与图标 */
  const [browserUi, setBrowserUi] = useState({ open: false, max: false, float: false, chatHidden: false })
  const [sessionId, setSessionId] = useState('')
  /** 处理中的会话集合（切走也保留，侧栏对应任务行各自显示加载图标；多个任务并行互不覆盖） */
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({})
  const [settings, setSettings] = useState<SettingsCfg>({
    providers: [],
    mcps: [],
    remote: false,
    mobile: false,
    platform: { baseUrl: '', token: '', user: null, models: [], device: null }
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

  useEffect(() => save('qingniao.themeColors', custom), [custom])

  useEffect(() => save('qingniao.model', model), [model])

  useEffect(() => save('qingniao.expanded', expanded), [expanded])

  // App 级 SSE 监听：busy 事实源与 ChatView 生命周期解耦。
  // ChatView 卸载（切走/切设置页）后 side 加载图标仍能正确更新，不残留。
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
  // 不预设任何默认项目：新用户左栏为空，由「+」或空态引导自己添加
  useEffect(() => {
    ;(async () => {
      // 会话列表的「已展开条数」已改为每次启动从 5 重新开始，旧存档留着只会误导，清掉
      localStorage.removeItem('qingniao.sessShown')
      const info = await window.qingniao.info()
      workspaceRef.current = info.workspace
      const ps = load<Project[]>('qingniao.projects', []).filter((x) => x.id !== 'workbench')
      setProjects(ps)
      const stored = load<string>('qingniao.activeProject', '')
      const act = ps.some((x) => x.id === stored) ? stored : (ps[0]?.id ?? '')
      setActiveId(act)
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

  // 项目数据按需加载：首次展开才拉
  useEffect(() => {
    const proj = projects.find((x) => x.id === activeId)
    if (proj && expanded[proj.id] && !(proj.path in sessionsMap)) loadProjectSessions(proj)
  }, [projects, expanded, activeId])

  const activeProject = projects.find((x) => x.id === activeId)

  /**
   * 打开设置页并定位到某一页（对话框里的「配置模型」、左栏账号入口都走这里）。
   *
   * 设置页是盖在内容区之上的覆盖层，而左侧任务列表始终可点：用户点任务想回对话，
   * 若只切了内容区、覆盖层还留着，看着就像"点了没反应"——所以下面所有要进对话的动作
   * 都走 toChat()，顺手把这条定位请求清掉。
   */
  function openSettingsAt(t: SettingsTab) {
    setSettingsTab(t)
    setSettingsReq((r) => ({ tab: t, tick: (r?.tick ?? 0) + 1 }))
    setView('settings')
  }

  /** 进对话：收起设置覆盖层（点任务 / 点项目 / 新建会话都用它） */
  function toChat() {
    setSettingsReq(null)
    setView('chat')
  }

  /**
   * 点击文件夹：切换展开状态；点到别的项目时同步激活并进草稿态——
   * 否则右侧还挂着旧项目的会话（sessionId 未清），发消息会串进别的任务里。
   */
  function toggleProject(id: string) {
    const willExpand = !expanded[id]
    setExpanded((e) => ({ ...e, [id]: willExpand }))
    const proj = projects.find((x) => x.id === id)
    if (proj && !(proj.path in sessionsMap)) loadProjectSessions(proj)
    if (id !== activeId) {
      setActiveId(id)
      save('qingniao.activeProject', id)
      setSessionId('')
      toChat()
    }
  }

  /** 项目行「新会话」：进草稿态（不创建内核会话），右侧开聊 */
  function newSessionFor(id: string) {
    const proj = projects.find((x) => x.id === id)
    if (!proj) return
    setActiveId(id)
    save('qingniao.activeProject', id)
    setExpanded((e) => ({ ...e, [id]: true }))
    setSessionId('')
    toChat()
    setFocusTick((t) => t + 1)
  }

  /** 点任务行：打开该会话（跨项目也先激活其项目），右侧切回对话 */
  function pickSessionFor(proj: Project, sid: string) {
    setActiveId(proj.id)
    save('qingniao.activeProject', proj.id)
    setSessionId(sid)
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

  async function addProject() {
    const path = await window.qingniao.pickDir()
    if (!path || projects.some((x) => x.path === path)) return
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
    const proj: Project = { id: 'p' + Date.now(), path, name, added: Date.now() }
    setProjectsPersisted([...projects, proj])
    setActiveId(proj.id)
    save('qingniao.activeProject', proj.id)
    setExpanded((e) => ({ ...e, [proj.id]: true }))
    setSessionId('')
    toChat()
  }

  /** 移除项目：允许移除到空列表（不再兜底造一个「工作台」） */
  function removeProject(id: string) {
    const next = projects.filter((x) => x.id !== id)
    setProjectsPersisted(next)
    setExpanded((e) => {
      const { [id]: _drop, ...rest } = e
      return rest
    })
    if (activeId === id) {
      const nid = next[0]?.id ?? ''
      setActiveId(nid)
      save('qingniao.activeProject', nid)
      setSessionId('')
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
      // 主进程写 ~/.qingniaoai 并重启内核后返回，配置即刻生效
      await window.qingniao.saveSettings(next)
    } catch (e) {
      // 重启失败/超时：回读磁盘上的真实设置，并弹窗说清原因——不然按钮一转就再没下文，
      // 用户只能对着转圈的「保存并重启内核…」干等
      const msg = e instanceof Error ? e.message : String(e)
      setSettings(await window.qingniao.getSettings())
      setNotice(`设置已写入，但内核没能重启成功：${msg}。可以重新保存一次，或重启本应用。`)
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

  // 展示顺序：最近有对话活动的文件夹排最前
  const orderedProjects = [...projects].sort(
    (a, b) => (lastActive[b.id] ?? b.added ?? 0) - (lastActive[a.id] ?? a.added ?? 0)
  )

  return (
    <div className="shell">
      <Titlebar
        onToggleBrowser={() => setBrowserSignal((v) => v + 1)}
        browserOpen={browserUi.open}
        browserMax={browserUi.max}
        chatHidden={browserUi.chatHidden}
        onBrowserMax={() => setBrowserMaxSignal((v) => v + 1)}
        onToggleFloat={() => setFloatSignal((v) => v + 1)}
      />
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
          onToggleProject={toggleProject}
          onRemoveProject={removeProject}
          onNewSession={newSessionFor}
          onAddProject={addProject}
          onPickSession={pickSessionFor}
          onDeleteSession={deleteSessionOf}
          onOpenSettings={() => openSettingsAt('providers')}
          onOpenFolder={openFolder}
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
        />
        <div className="content">
        {/* 模型清单走 chatProviders()：平台「内置模型」固定排最前，用户自建提供商接在后面 */}
        {activeProject ? (
          <ChatView
            project={activeProject}
            projects={orderedProjects}
            sessionId={sessionId}
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
            floatToggleSignal={floatSignal}
            onBrowserUi={setBrowserUi}
            onOpenSettings={() => openSettingsAt('providers')}
            onPickDir={addProject}
            onSwitchProject={(id) => {
              if (id === activeId) return
              setActiveId(id)
              save('qingniao.activeProject', id)
              setSessionId('')
              toChat()
              setFocusTick((t) => t + 1)
            }}
          />
        ) : (
          <Welcome onAddProject={addProject} onOpenSettings={() => openSettingsAt('providers')} />
        )}
        {view === 'settings' && (
          <SettingsView
            settings={settings}
            onSave={saveSettingsAll}
            saving={saving}
            theme={theme}
            onTheme={setTheme}
            custom={custom}
            onCustom={(k, v) => setCustom((c) => ({ ...c, [k]: v }))}
            onResetCustom={() => setCustom(DEFAULT_CUSTOM)}
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
        )}
        </div>
      </div>

      {notice && (
        <Modal title="操作没成功" onClose={() => setNotice('')}>
          <p className="confirm-text">{notice}</p>
          <div className="actions">
            <button className="primary" onClick={() => setNotice('')}>
              知道了
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
          <h2>先添加一个项目文件夹</h2>
          <p>
            选择要干活的目录，会话与文件操作都在该目录内进行。
            <br />
            还没有配置模型的话，先去设置里添一个提供商。
          </p>
          <div className="welcome-acts">
            <button className="primary" onClick={onAddProject}>
              <FolderPlus size={15} /> 添加项目
            </button>
            <button className="ghost" onClick={onOpenSettings}>
              <Settings size={15} /> 打开设置
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
