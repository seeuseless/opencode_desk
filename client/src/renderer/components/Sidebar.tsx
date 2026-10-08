import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleUser,
  Code2,
  FileCode2,
  FilePlus2,
  Folder,
  FolderPlus,
  FolderOpen,
  LoaderCircle,
  ListTodo,
  LogIn,
  MessageSquarePlus,
  RefreshCw,
  Settings,
  Smartphone,
  Timer,
  Trash2
} from 'lucide-react'
import { Modal } from './Modal'
import { useDragSort } from './useDragSort'
import { Switch } from './Switch'
import { t } from '../i18n'
import { isScheduleSession, fmtYmd } from '../oc'
import type { ProjectSortMode } from '../App'
import type { DeskStatus, PlatformStatus, Session } from '../oc'

/** 项目的访问权限档位（定义在主进程 types.ts，这里 re-export 给渲染层各处引用） */
export type { AccessLevel } from '../../../electron/main/types'

export interface Project {
  id: string
  path: string
  name: string
  /** 添加时间，作为排序兜底 */
  added?: number
  /**
   * 内置的「任务」目录：内核自己的 workspace（`~/.qingniaoai/workspace`）。
   * 它由主进程创建、始终可用，所以**不提供移除**——列表被清空后只剩它一个落脚点，
   * 否则用户会把目录全删光、连「往哪放东西」都没了。
   * 恒排在最前（渲染时单独摘出来先画，见下方 render 注释）。
   */
  builtin?: boolean
}

const COLLAPSE_AT = 5

interface WorkspaceNode {
  name: string
  path: string
  type: 'directory' | 'file'
}

/**
 * 是不是内置的「任务」目录（列表面板与右键菜单共用同一判据）。
 * 既认 builtin 标记，也认 id —— 标记万一在存档里丢了（手改存档、旧版本写过），
 * 这里仍然认得出它，**不会误露「从列表移除」**。
 * 只影响「任务」这一个目录；用户自己加的文件夹一律 `false`，移除入口照旧保留。
 */
function isBuiltinProj(proj: Project): boolean {
  return !!proj.builtin || proj.id === 'builtin'
}

interface Props {
  projects: Project[]
  activeId: string
  expanded: Record<string, boolean>
  sessionsMap: Record<string, Session[]>
  sessionId: string
  /** 处理中的会话集合（sid → true）：对应任务行显示加载图标，多任务并行各自转圈 */
  busyIds: Record<string, boolean>
  /** 正在拉取历史的会话集合（sid → true）：点击当帧高亮，不用等数据回来 */
  loadingSids: Record<string, boolean>
  view: 'chat' | 'settings' | 'schedules'
  /** 普通项目展开区显示代码目录树；内置任务仍显示会话 */
  codeMode: boolean
  width: number
  selectedFile: string
  onToggleCodeMode: () => void
  onPickFile: (proj: Project, filePath: string) => void
  onToggleProject: (id: string) => void
  onRemoveProject: (id: string) => void
  onNewSession: (id: string) => void
  /**
   * 顶部「新建任务」：在**默认的「任务」目录**里开一个新任务。
   *
   * 单独一个入口而不是复用 onNewSession：用户点顶部这个按钮时脑子里想的是
   * 「我要开个活」，而不是「我要在某个具体文件夹里开」——落到内置的任务目录，
   * 不确定放哪儿的东西就有了统一去处（真要放到别的目录，点那个目录行上的「添加任务」）。
   */
  onNewTask: () => void
  onAddProject: () => void
  onPickSession: (proj: Project, sid: string) => void
  onDeleteSession: (proj: Project, sid: string) => void
  onOpenSettings: () => void
  /** 在系统文件管理器里打开项目目录（右键菜单第一项，为了快速定位项目文件夹） */
  onOpenFolder: (proj: Project) => void
  projectSortMode: ProjectSortMode
  onReorderProjects: (from: number, to: number) => void
  /** 移动端接入状态；null = 还没问过主进程 */
  mobile: DeskStatus | null
  mobileBusy: boolean
  onMobileToggle: (on: boolean) => void
  onMobileRotate: () => void
  /** 平台登录态；null = 还没问过主进程 */
  platform: PlatformStatus | null
  platformBusy: boolean
  /** 未登录时点它 → 打开平台登录页（系统浏览器） */
  onLogin: () => void
  /** 已登录时点它 → 进设置页的「账号」（账号信息 / 积分 / 流水 / 退出） */
  onOpenAccount: () => void
  /**
   * 全局是否启用「远程服务」。
   * 关掉时底下两个入口（登录/账号、手机）整块不渲染——它们全依赖平台接口，
   * 留着只会点了报错。此时底栏只剩「设置」。
   */
  remote: boolean
  /** 打开「计划任务」列表页（内容区整页，左栏只留一个入口） */
  onOpenSchedules: () => void
}

export function Sidebar(p: Props) {
  /**
   * 每个文件夹「已显示会话条数」，点「显示更多会话」每次 +5。
   *
   * **刻意不持久化**：会话列表是「最近几条」的用途，展开状态属于当下这一次浏览的心智，
   * 存到磁盘的后果是——用户某次点开看多了的目录，下次重启还是长长一列，
   * 而他要的是「一打开就只看到最近 5 个」。所以每次启动都从 5 开始。
   */
  const [shownCount, setShownCount] = useState<Record<string, number>>({})
  /** 项目路径 + 目录相对路径 → 该层节点；根目录用空字符串 */
  const [treeMap, setTreeMap] = useState<Record<string, WorkspaceNode[]>>({})
  const [treeLoading, setTreeLoading] = useState<Record<string, boolean>>({})
  const [treeError, setTreeError] = useState<Record<string, string>>({})
  /** 每个项目单独记住已展开目录 */
  const [openDirs, setOpenDirs] = useState<Record<string, string[]>>({})
  const [confirmDel, setConfirmDel] = useState<Project | null>(null)
  const [confirmDelSess, setConfirmDelSess] = useState<{ proj: Project; sess: Session } | null>(null)
  /** 项目行右键菜单（自绘，位置跟鼠标）；记录坐标与目标项目 */
  const [menu, setMenu] = useState<{ x: number; y: number; proj: Project } | null>(null)
  /** 文件树节点右键菜单：目标项目 + 被右键的节点 */
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; proj: Project; node: WorkspaceNode } | null>(null)
  /** 删除文件/文件夹前的确认弹窗 */
  const [confirmDelNode, setConfirmDelNode] = useState<{ proj: Project; node: WorkspaceNode } | null>(null)
  /** 「新建文件夹」命名输入弹窗（目标是所在目录） */
  const [newDirAsk, setNewDirAsk] = useState<{ proj: Project; parent: string } | null>(null)
  const [delNodeBusy, setDelNodeBusy] = useState(false)
  const projectSort = useDragSort((from, to) => p.onReorderProjects(from, to))

  const treeKey = (projectPath: string, dirPath: string): string => `${projectPath}\0${dirPath}`

  /** 把主进程抛出的错误剥掉「Error invoking remote method ...」前缀，只留真正含义 */
  function errText(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e)
    const m = /(?:Error invoking remote method '\w+': (Error: )?)?([\s\S]+)$/.exec(raw.replace(/\r\n/g, '\n'))
    return (m?.[2] ?? raw).trim().replace(/\n.*$/, '')
  }
  /** 项目目录是否已被删除/移走（主进程统一兜底的错误文案） */
  function isDirMissing(msg: string): boolean {
    return /被删除或移走/.test(msg) || /ENOENT/.test(msg)
  }

  async function loadDir(proj: Project, dirPath = ''): Promise<void> {
    const key = treeKey(proj.path, dirPath)
    if (treeLoading[key]) return
    setTreeLoading((m) => ({ ...m, [key]: true }))
    setTreeError((m) => ({ ...m, [key]: '' }))
    try {
      const nodes = await window.qingniao.workspaceList(proj.path, dirPath)
      setTreeMap((m) => ({ ...m, [key]: nodes }))
    } catch (e) {
      setTreeError((m) => ({ ...m, [key]: errText(e) }))
    } finally {
      setTreeLoading((m) => ({ ...m, [key]: false }))
    }
  }

  function toggleDir(proj: Project, dirPath: string): void {
    const opened = openDirs[proj.id] ?? []
    const isOpen = opened.includes(dirPath)
    setOpenDirs((m) => ({
      ...m,
      [proj.id]: isOpen ? opened.filter((x) => x !== dirPath) : [...opened, dirPath]
    }))
    if (!isOpen && !(treeKey(proj.path, dirPath) in treeMap)) void loadDir(proj, dirPath)
  }

  useEffect(() => {
    if (!p.codeMode) return
    for (const proj of p.projects) {
      if (isBuiltinProj(proj) || !p.expanded[proj.id] || treeKey(proj.path, '') in treeMap) continue
      void loadDir(proj)
    }
  }, [p.codeMode, p.projects, p.expanded])

  function renderTree(proj: Project, nodes: WorkspaceNode[], depth: number): React.ReactNode {
    const opened = openDirs[proj.id] ?? []
    // 文件夹行沿用原缩进（14px 起，每层 +14）；**文件行**统一再多缩 10px——
    // 文件夹下的文件要和文件夹行拉开层次，不贴着左缘
    return nodes.map((node) => {
      const rowStyle = node.type === 'file'
        ? { marginLeft: `${24 + depth * 14}px` }
        : { marginLeft: `${14 + depth * 14}px` }
      if (node.type === 'directory') {
        const isOpen = opened.includes(node.path)
        const key = treeKey(proj.path, node.path)
        return (
          <div key={node.path}>
            <div
              className="sess code-tree-row"
              style={rowStyle}
              onClick={() => toggleDir(proj, node.path)}
              onContextMenu={(e) => openTreeMenu(proj, node, e)}
              title={node.path}
            >
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {isOpen ? <FolderOpen size={14} className="code-file-ico" /> : <Folder size={14} className="code-file-ico" />}
              <span className="sess-title">{node.name}</span>
            </div>
            {isOpen && treeLoading[key] && <div className="code-list-empty" style={rowStyle}>{t('读取中…')}</div>}
            {isOpen && treeError[key] && <div className="code-list-error" style={rowStyle}>{treeError[key]}</div>}
            {isOpen && treeMap[key]?.length === 0 && <div className="code-list-empty" style={rowStyle}>{t('空目录')}</div>}
            {isOpen && treeMap[key] && renderTree(proj, treeMap[key], depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={node.path}
          className={'sess code-tree-row code-file' + (proj.id === p.activeId && node.path === p.selectedFile ? ' on' : '')}
          style={rowStyle}
          onClick={() => p.onPickFile(proj, node.path)}
          onContextMenu={(e) => openTreeMenu(proj, node, e)}
          title={node.path}
        >
          <FileCode2 size={13} className="code-file-ico" />
          <span className="sess-title">{node.name}</span>
        </div>
      )
    })
  }

  function openMenu(proj: Project, e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    // 贴边时往上/往左收，别让菜单跑到窗口外
    const w = 178
    const h = 128
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - w - 8),
      y: Math.min(e.clientY, window.innerHeight - h - 8),
      proj
    })
  }

  /** 打开文件树节点右键菜单：记录坐标与目标（文件/文件夹） */
  function openTreeMenu(proj: Project, node: WorkspaceNode, e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const w = 178
    const h = 136
    setTreeMenu({
      x: Math.min(e.clientX, window.innerWidth - w - 8),
      y: Math.min(e.clientY, window.innerHeight - h - 8),
      proj,
      node
    })
  }

  /** 刷新目录树某个目录层（新建/删除后重读内容） */
  async function refreshDir(proj: Project, dirPath: string): Promise<void> {
    const key = treeKey(proj.path, dirPath)
    setTreeLoading((m) => ({ ...m, [key]: true }))
    setTreeError((m) => ({ ...m, [key]: '' }))
    try {
      const nodes = await window.qingniao.workspaceList(proj.path, dirPath)
      setTreeMap((m) => ({ ...m, [key]: nodes }))
    } catch (e) {
      setTreeError((m) => ({ ...m, [key]: errText(e) }))
    } finally {
      setTreeLoading((m) => ({ ...m, [key]: false }))
    }
  }

  /** 删除文件/文件夹（确认弹窗里点「删除」触发）；删除后刷新所在层 */
  async function deleteTreeNode(proj: Project, node: WorkspaceNode): Promise<void> {
    setDelNodeBusy(true)
    try {
      await window.qingniao.workspaceDelete(proj.path, node.path)
      const parentDir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
      const isOpen = (openDirs[proj.id] ?? []).includes(node.path)
      if (node.type === 'directory' && isOpen) {
        setOpenDirs((m) => ({ ...m, [proj.id]: (m[proj.id] ?? []).filter((x) => x !== node.path) }))
      }
      await refreshDir(proj, parentDir)
    } catch (e) {
      setTreeError((m) => ({ ...m, [treeKey(proj.path, '')]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setDelNodeBusy(false)
    }
  }

  const mobileOn = !!p.mobile?.enabled
  /** 绿点只认「真有手机连着」，不认开关：开关开着但没人扫码时不该亮 */
  const mobileLinked = !!p.mobile?.mobileConnected
  const mobileTitle = !p.mobile?.loggedIn
    ? t('移动端')
    : mobileLinked
      ? t('移动端：手机已连接')
      : mobileOn
        ? t('移动端：已放行，等待手机扫码连接')
        : t('移动端：未放行')

  return (
    <>
      <aside className="side" style={{ width: p.width, minWidth: p.width }}>
        {/* 顶部工作区栏：名称固定，右侧两个动作分别是打开文件夹和添加任务。 */}
        <div className="side-workspace-head">
          <span>{t('工作区')}</span>
          <div className="workspace-actions">
            <button className="icon-btn" title={t('打开文件夹')} onClick={p.onAddProject}>
              <FolderOpen size={15} />
            </button>
            <button className="icon-btn" title={t('在「任务」目录里新建一个任务')} onClick={p.onNewTask}>
              <MessageSquarePlus size={15} />
            </button>
          </div>
        </div>
        <div className="projlist">
          {p.projects.length === 0 && (
            <div className="proj-empty">
              <FolderPlus size={22} />
              <span>{t('还没有项目')}</span>
            {!p.codeMode && (
              <button className="ghost pick-dir" onClick={p.onAddProject}>
                {t('选择文件夹')}
              </button>
            )}
            </div>
          )}
          {/*
            「任务」目录（builtin）恒居首位：渲染时先把它摘出来单独画，其余保持用户顺序。
            排序放在渲染层而不是 setProjects 时——存档里它本来就在最前，但用户若手动改过
            存档、或将来加了项目拖拽排序，渲染层这一句是唯一能保证「永远在最上面」的地方。
          */}
          {[...p.projects].sort((a, b) => Number(isBuiltinProj(b)) - Number(isBuiltinProj(a))).map((proj, projectIndex) => {
            const sortIndex = isBuiltinProj(proj) ? -1 : projectIndex - 1
            const sortRowProps = sortIndex >= 0 ? projectSort.rowProps(sortIndex) : {}
            const isOpen = !!p.expanded[proj.id]
            const list = p.sessionsMap[proj.path] ?? []
            const count = shownCount[proj.id] ?? COLLAPSE_AT
            const shown = list.slice(0, count)
            return (
              <div key={proj.id}>
                <div
                  className={
                    'proj' +
                    (isBuiltinProj(proj) ? ' builtin' : '') +
                    (p.projectSortMode === 'fixed' && sortIndex >= 0 && projectSort.dragIdx === sortIndex ? ' dragging' : '') +
                    (p.projectSortMode === 'fixed' && sortIndex >= 0 && projectSort.overIdx === sortIndex && projectSort.dragIdx !== sortIndex
                      ? ' dragover ' + projectSort.overPos
                      : '')
                  }
                  title={proj.path}
                  onClick={() => p.onToggleProject(proj.id)}
                  onContextMenu={(e) => openMenu(proj, e)}
                  {...sortRowProps}
                  {...(p.projectSortMode === 'fixed' && !isBuiltinProj(proj)
                    ? projectSort.handleProps(sortIndex)
                    : {})}
                >
                  {isBuiltinProj(proj)
                    ? <ListTodo size={15} className="proj-ico" />
                    : <FolderOpen size={15} className="proj-ico" />}
                  <span className="proj-name">{proj.name}</span>
                  {/* hover 只留「添加任务」一个：打开文件夹/从列表移除都归右键菜单，
                      图标堆在行右端反而容易点错 */}
                  <span className="proj-actions">
                    <button
                      className="icon-btn"
                      title={t('添加任务')}
                      onClick={(e) => {
                        e.stopPropagation()
                        p.onNewSession(proj.id)
                      }}
                    >
                      <MessageSquarePlus size={14} />
                    </button>
                  </span>
                </div>
                {isOpen && p.codeMode && !isBuiltinProj(proj) ? (
                  <>
                    {treeLoading[treeKey(proj.path, '')] && <div className="code-list-empty">{t('正在读取目录…')}</div>}
                    {/* 项目目录被删除/移走时静默隐藏，不打扰用户（显示空状态） */}
                    {treeError[treeKey(proj.path, '')] && !isDirMissing(treeError[treeKey(proj.path, '')]) && (
                      <div className="code-list-error" title={treeError[treeKey(proj.path, '')]}>
                        {treeError[treeKey(proj.path, '')]}
                      </div>
                    )}
                    {treeMap[treeKey(proj.path, '')]?.length === 0 && <div className="code-list-empty">{t('没有代码文件')}</div>}
                    {renderTree(proj, treeMap[treeKey(proj.path, '')] ?? [], 0)}
                  </>
                ) : isOpen && (
                  <>
                    {shown.map((s) => (
                      <div
                        key={s.id}
                        className={'sess' + (s.id === p.sessionId && proj.id === p.activeId || p.loadingSids[s.id] ? ' on' : '')}
                        onClick={() => p.onPickSession(proj, s.id)}
                        title={s.title}
                      >
                        <span className="sess-title">{s.title ?? s.id}</span>
                        {/* 计划会话（含补跑那一次）：同一条计划每天产一个会话，光看标题分不出是哪天跑的，标上日期 */}
                        {isScheduleSession(s.title) && s.time?.created && (
                          <span className="sess-date">{fmtYmd(s.time.created)}</span>
                        )}
                        {!!p.busyIds[s.id] && (
                          <span className="sess-busy" title={t('处理中')}>
                            <LoaderCircle size={13} className="spin" />
                          </span>
                        )}
                        <button
                          className="icon-btn sess-del"
                          title={t('删除会话')}
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmDelSess({ proj, sess: s })
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    {list.length > COLLAPSE_AT && (
                      <div
                        className="sess-more"
                        onClick={() =>
                          setShownCount((m) => ({
                            ...m,
                            [proj.id]:
                              (m[proj.id] ?? COLLAPSE_AT) < list.length
                                ? Math.min((m[proj.id] ?? COLLAPSE_AT) + 5, list.length)
                                : COLLAPSE_AT,
                          }))
                        }
                      >
                        {(shownCount[proj.id] ?? COLLAPSE_AT) < list.length ? (
                          <>
                            <ChevronRight size={13} />
                            {t('显示更多会话')}
                          </>
                        ) : (
                          <>
                            <ChevronDown size={13} />
                            {t('收起')}
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>

        {/* 底栏：账号入口与功能图标同一行靠右。远程服务关掉时账号入口与手机图标都不渲染。 */}
        <div className="side-foot">
          {p.remote && (p.platform?.loggedIn ? (
            <button
              type="button"
              className="foot-user on"
              title={`${p.platform.user?.name ?? t('已登录')}${p.platform.user?.email ? ' · ' + p.platform.user.email : ''}\n${t('点击查看账号、积分与用量')}`}
              onClick={p.onOpenAccount}
            >
              <CircleUser size={15} />
              <span className="fu-name">{p.platform.user?.name || t('已登录')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="foot-user login"
              title={p.platform?.error ? t('上次登录没成功：') + p.platform.error : t('登录平台账号后即可使用内置模型')}
              disabled={p.platformBusy}
              onClick={p.onLogin}
            >
              {p.platformBusy ? <LoaderCircle size={15} className="spin" /> : <LogIn size={15} />}
              <span className="fu-name">{t('登录')}</span>
            </button>
          ))}
          <div
            className={'foot-btn' + (p.codeMode ? ' on' : '')}
            title={p.codeMode ? t('关闭代码模式') : t('开启代码模式')}
            onClick={p.onToggleCodeMode}
          >
            <Code2 size={16} />
          </div>
          <div
            className={'foot-btn' + (p.view === 'schedules' ? ' on' : '')}
            title={t('计划任务')}
            onClick={p.onOpenSchedules}
          >
            <Timer size={16} />
          </div>
          <div
            className={'foot-btn' + (p.view === 'settings' ? ' on' : '')}
            title={t('设置')}
            onClick={p.onOpenSettings}
          >
            <Settings size={16} />
          </div>
          {/* 手机图标：远程服务关掉、或还没登录平台时，整块不渲染（设备身份是登录时登记的，没登录就没有码）。
              hover 出浮动面板（开关 + 二维码），纯 CSS 展开，鼠标离开自动收起。
              面板只放二维码一件事：域名、已连接设备数、说明文字一律不显示——
              要看的是「扫一下就能用」，多一行字都是干扰。 */}
          {p.remote && p.platform?.loggedIn && (
            <div className={'mobwrap' + (mobileOn ? ' on' : '')}>
              <div className={'foot-btn mobtrig' + (mobileOn ? ' on' : '')} title={mobileTitle}>
                <Smartphone size={16} />
                {mobileLinked && <span className="mob-dot" title={t('手机已连接')} />}
              </div>
              <div className="mobpop">
                <div className="mobpop-inner">
                  <div className="mp-head">
                    <span className="mp-title">{t('移动端连接')}</span>
                    {/* 换码按钮放标题行：二维码下面留白给码本身 */}
                    <button
                      className="mp-rot"
                      title={t('换一张二维码（旧码立即作废）')}
                      disabled={!p.mobile?.url || p.mobileBusy}
                      onClick={p.onMobileRotate}
                    >
                      <RefreshCw size={13} />
                    </button>
                    <Switch
                      checked={mobileOn}
                      onChange={(v) => !p.mobileBusy && p.onMobileToggle(v)}
                      disabled={p.mobileBusy}
                    />
                  </div>

                  {p.mobile?.qr ? (
                    <QrCode qr={p.mobile.qr} />
                  ) : (
                    <div className="mp-qrph">{p.mobile?.error ? t('二维码暂时取不到') : t('二维码生成中…')}</div>
                  )}

                  {p.mobile?.error && <p className="mp-err">{p.mobile.error}</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        {confirmDel && (
          <Modal title={t('移除项目')} onClose={() => setConfirmDel(null)}>
            <p className="confirm-text">
              {t('确定把「{name}」从项目列表移除吗？不会删除本地文件夹与历史记录。', { name: confirmDel.name })}
            </p>
            <div className="actions">
              <button className="ghost" onClick={() => setConfirmDel(null)}>
                {t('取消')}
              </button>
              <button
                className="primary danger-btn"
                onClick={() => {
                  p.onRemoveProject(confirmDel.id)
                  setConfirmDel(null)
                }}
              >
                {t('移除')}
              </button>
            </div>
          </Modal>
        )}

        {confirmDelSess && (
          <Modal title={t('删除会话')} onClose={() => setConfirmDelSess(null)}>
            <p className="confirm-text">
              {t('确定删除「{name}」吗？聊天记录将一并删除，不可恢复。', { name: confirmDelSess.sess.title ?? confirmDelSess.sess.id })}
            </p>
            <div className="actions">
              <button className="ghost" onClick={() => setConfirmDelSess(null)}>
                {t('取消')}
              </button>
              <button
                className="primary danger-btn"
                onClick={() => {
                  p.onDeleteSession(confirmDelSess.proj, confirmDelSess.sess.id)
                  setConfirmDelSess(null)
                }}
              >
                {t('删除')}
              </button>
            </div>
          </Modal>
        )}

        {/* 删除文件/文件夹确认：文件不可恢复，文件夹连同其下所有内容一起删 */}
        {confirmDelNode && (
          <Modal title={confirmDelNode.node.type === 'directory' ? t('删除文件夹') : t('删除文件')} onClose={() => setConfirmDelNode(null)}>
            <p className="confirm-text">
              {confirmDelNode.node.type === 'directory'
                ? t('确定删除文件夹「{name}」吗？里面所有文件会一并删除，不可恢复。', { name: confirmDelNode.node.name })
                : t('确定删除文件「{name}」吗？不可恢复。', { name: confirmDelNode.node.name })}
            </p>
            <div className="actions">
              <button className="ghost" onClick={() => setConfirmDelNode(null)} disabled={delNodeBusy}>
                {t('取消')}
              </button>
              <button
                className="primary danger-btn"
                disabled={delNodeBusy}
                onClick={() => {
                  void deleteTreeNode(confirmDelNode.proj, confirmDelNode.node)
                  setConfirmDelNode(null)
                }}
              >
                {delNodeBusy ? t('删除中…') : t('删除')}
              </button>
            </div>
          </Modal>
        )}

        {/* 新建文件夹命名输入 */}
        {newDirAsk && (
          <NewDirModal
            proj={newDirAsk.proj}
            parent={newDirAsk.parent}
            onClose={() => setNewDirAsk(null)}
            onCreated={async (path) => {
              await refreshDir(newDirAsk.proj, newDirAsk.parent)
              // 展开新目录所在层
              setOpenDirs((m) => {
                const opened = m[newDirAsk.proj.id] ?? []
                return opened.includes(newDirAsk.parent) ? m : { ...m, [newDirAsk.proj.id]: [...opened, newDirAsk.parent] }
              })
              setNewDirAsk(null)
            }}
          />
        )}
      </aside>

      {/* 项目右键菜单：自绘（与全局控件风格一致，不用原生菜单）。点空白处/Esc/滚动都收起 */}
      {menu && (
        <div
          className="ctx-mask"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu(null)
          }}
        >
          <div
            className="ctxmenu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              className="ctx-item"
              onClick={() => {
                p.onOpenFolder(menu.proj)
                setMenu(null)
              }}
            >
              <FolderOpen size={14} />
              {t('打开文件夹')}
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                p.onNewSession(menu.proj.id)
                setMenu(null)
              }}
            >
              <MessageSquarePlus size={14} />
              {t('添加任务')}
            </button>
            {/* 只有内置的「任务」目录不给「从列表移除」（连分隔线一起不画）：
                它由主进程创建、是列表清空后仅剩的落脚点，点了也移不掉。
                **其余用户自己加的文件夹一律保留这一项**，别顺手一起藏了。 */}
            {isBuiltinProj(menu.proj) ? null : (
              <>
                <div className="ctx-sep" />
                <button
                  className="ctx-item danger"
                  onClick={() => {
                    setConfirmDel(menu.proj)
                    setMenu(null)
                  }}
                >
                  <Trash2 size={14} />
                  {t('从列表移除')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 文件树节点右键菜单：文件夹支持新建文件/新建文件夹/删除，文件只有删除 */}
      {treeMenu && (
        <div
          className="ctx-mask"
          onMouseDown={() => setTreeMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setTreeMenu(null)
          }}
        >
          <div
            className="ctxmenu"
            style={{ left: treeMenu.x, top: treeMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {treeMenu.node.type === 'directory' && (
              <>
                <button
                  className="ctx-item"
                  onClick={() => {
                    // 新建文件：弹系统另存为对话框，默认落在该目录
                    window.qingniao
                      .workspaceNewFile(treeMenu.proj.path, treeMenu.node.path)
                      .then((r) => {
                        if (r) {
                          void refreshDir(treeMenu.proj, treeMenu.node.path)
                          p.onPickFile(treeMenu.proj, r.path)
                        }
                      })
                      .catch(() => {})
                    setTreeMenu(null)
                  }}
                >
                  <FilePlus2 size={14} />
                  {t('新建文件')}
                </button>
                <button
                  className="ctx-item"
                  onClick={() => {
                    setNewDirAsk({ proj: treeMenu.proj, parent: treeMenu.node.path })
                    setTreeMenu(null)
                  }}
                >
                  <FolderPlus size={14} />
                  {t('新建文件夹')}
                </button>
                <div className="ctx-sep" />
              </>
            )}
            <button
              className="ctx-item danger"
              onClick={() => {
                setConfirmDelNode({ proj: treeMenu.proj, node: treeMenu.node })
                setTreeMenu(null)
              }}
            >
              <Trash2 size={14} />
              {treeMenu.node.type === 'directory' ? t('删除文件夹') : t('删除文件')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/** 新建文件夹：输入名字后调用主进程创建，成功后回调 onCreated(相对路径) */
function NewDirModal({
  proj,
  parent,
  onClose,
  onCreated
}: {
  proj: Project
  parent: string
  onClose: () => void
  onCreated: (path: string) => Promise<void> | void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function submit() {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await window.qingniao.workspaceNewDir(proj.path, parent, n)
      await onCreated(r.path)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <Modal title={t('新建文件夹')} onClose={onClose}>
      <p className="confirm-text">{t('在「{dir}」下新建文件夹', { dir: parent || proj.name })}</p>
      <input
        autoFocus
        className="field-input"
        value={name}
        placeholder={t('文件夹名')}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onClose()
        }}
      />
      {err && <p className="confirm-text hint">{err}</p>}
      <div className="actions">
        <button className="ghost" onClick={onClose} disabled={busy}>
          {t('取消')}
        </button>
        <button className="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
          {busy ? t('创建中…') : t('创建')}
        </button>
      </div>
    </Modal>
  )
}

/** 二维码点阵画成内联 SVG：CSP 是 default-src 'self'，加载不了 data:/跨源图片 */
function QrCode({ qr, size = 156 }: { qr: { size: number; rows: number[][] }; size?: number }) {
  const margin = 3
  const total = qr.size + margin * 2
  let d = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.rows[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`
    }
  }
  return (
    <svg
      className="mp-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={t('移动端配对二维码')}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}
