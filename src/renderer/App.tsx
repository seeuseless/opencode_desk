import { useEffect, useRef, useState } from 'react'
import { FolderPlus, Settings } from 'lucide-react'
import { Sidebar, type Project } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SettingsView } from './components/SettingsView'
import { Titlebar } from './components/Titlebar'
import { oc, type ProviderCfg, type Session, type SettingsCfg } from './oc'
import { load, save } from './store'
import { CUSTOM_ID, THEMES } from './theme'
import { DEFAULT_CUSTOM, DERIVED_KEYS, deriveVars, type CustomColors } from './themeColors'

type View = 'chat' | 'settings'

const sortSessions = (list: Session[]) =>
  [...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))

/** 兼容旧存档：已删除/改名的主题做迁移，未知值回落默认主题「简约浅」 */
function loadTheme(): string {
  const t = load<string>('qingniao.theme', 'light')
  if (t === 'qqblue') return 'skyblue'
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
  const [sessionId, setSessionId] = useState('')
  /** 处理中的会话集合（切走也保留，侧栏对应任务行各自显示加载图标；多个任务并行互不覆盖） */
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({})
  const [settings, setSettings] = useState<SettingsCfg>({ providers: [], mcps: [], browser: false })
  const [settingsReady, setSettingsReady] = useState(false)
  const [model, setModel] = useState<string>(() => load('qingniao.model', ''))
  const [saving, setSaving] = useState(false)
  const workspaceRef = useRef('')
  /** 正在拉取历史的会话 id：点击当帧就标记，会话行高亮不必等数据回来 */
  const [loadingSids, setLoadingSids] = useState<Record<string, boolean>>({})

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

  // 初始加载：项目 + 本地设置；激活项目默认展开（仅首次无存档时）
  // 不预设任何默认项目：新用户左栏为空，由「+」或空态引导自己添加
  useEffect(() => {
    ;(async () => {
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

  // 启动 / 项目数据变化时，对账"正在处理中"的会话：只清不加。
  // busy 的事实源是事件（session.idle / session.error / kernel.started / ChatView 上报）；
  // 数据扫描只负责兜底清漏——会话数据里已无 running part 时清掉 busy。
  // 绝不凭数据里的 running 补记 busy：主动中止（如断网暂停）的回合数据会残留 running，
  // 补记会让侧栏加载图标在任务结束后常驻。
  useEffect(() => {
    for (const [path, list] of Object.entries(sessionsMap)) {
      for (const s of list) {
        ;(async () => {
          try {
            const msgs = await oc.messages(s.id, path)
            if (msgs.some((m) => m.parts.some((pt) => pt.state?.status === 'running'))) return
            setBusyIds((m) => {
              if (!(s.id in m)) return m
              const { [s.id]: _drop, ...rest } = m
              return rest
            })
          } catch { /* 单个会话拉取失败不影响其他 */ }
        })()
      }
    }
    // 仅依赖列表与项目集合，避免每次渲染重发对账请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, sessionsMap])

  const activeProject = projects.find((x) => x.id === activeId)

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
      setView('chat')
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
    setView('chat')
    setFocusTick((t) => t + 1)
  }

  /** 点任务行：打开该会话（跨项目也先激活其项目），右侧切回对话 */
  function pickSessionFor(proj: Project, sid: string) {
    setActiveId(proj.id)
    save('qingniao.activeProject', proj.id)
    setSessionId(sid)
    setView('chat')
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
    setView('chat')
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
    if (activeProject) loadProjectSessions(activeProject)
  }

  async function saveSettingsAll(next: SettingsCfg) {
    setSaving(true)
    // 先落 UI 状态：开关即刻翻转（乐观更新），内核重启在后台完成
    setSettings(next)
    try {
      // 主进程写 ~/.qingniaoai 并重启内核后返回，配置即刻生效
      await window.qingniao.saveSettings(next)
    } catch (e) {
      // 重启失败：回读磁盘上的真实设置，别让 UI 显示没生效的状态
      setSettings(await window.qingniao.getSettings())
      throw e
    } finally {
      setSaving(false)
    }
  }

  // 展示顺序：最近有对话活动的文件夹排最前
  const orderedProjects = [...projects].sort(
    (a, b) => (lastActive[b.id] ?? b.added ?? 0) - (lastActive[a.id] ?? a.added ?? 0)
  )

  return (
    <div className="shell">
      <Titlebar onAddProject={addProject} />
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
          onOpenSettings={() => setView('settings')}
        />
        {view === 'settings' ? (
          <SettingsView
            settings={settings}
            onSave={saveSettingsAll}
            saving={saving}
            theme={theme}
            onTheme={setTheme}
            custom={custom}
            onCustom={(k, v) => setCustom((c) => ({ ...c, [k]: v }))}
            onResetCustom={() => setCustom(DEFAULT_CUSTOM)}
          />
        ) : activeProject ? (
          <ChatView
            project={activeProject}
            sessionId={sessionId}
            model={model}
            onModelChange={setModel}
            settings={settings.providers}
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
            onOpenSettings={() => setView('settings')}
          />
        ) : (
          <Welcome onAddProject={addProject} onOpenSettings={() => setView('settings')} />
        )}
      </div>
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
