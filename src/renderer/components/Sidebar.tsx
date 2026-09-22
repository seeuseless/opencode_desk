import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleUser,
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  LogIn,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Settings,
  Smartphone,
  Trash2
} from 'lucide-react'
import { Modal } from './Modal'
import { Switch } from './Switch'
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
   * 内置的「任务」目录：内核自己的 workspace（`~/qingniaoai-workspace`）。
   * 它由主进程创建、始终可用，所以**不提供移除**——列表被清空后只剩它一个落脚点，
   * 否则用户会把目录全删光、连「往哪放东西」都没了。
   * 恒排在最前（渲染时单独摘出来先画，见下方 render 注释）。
   */
  builtin?: boolean
}

const COLLAPSE_AT = 5

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
  view: 'chat' | 'settings'
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
  const [confirmDel, setConfirmDel] = useState<Project | null>(null)
  const [confirmDelSess, setConfirmDelSess] = useState<{ proj: Project; sess: Session } | null>(null)
  /** 项目行右键菜单（自绘，位置跟鼠标）；记录坐标与目标项目 */
  const [menu, setMenu] = useState<{ x: number; y: number; proj: Project } | null>(null)

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

  const mobileOn = !!p.mobile?.enabled
  /** 绿点只认「真有手机连着」，不认开关：开关开着但没人扫码时不该亮 */
  const mobileLinked = !!p.mobile?.mobileConnected
  const mobileTitle = !p.mobile?.loggedIn
    ? '移动端'
    : mobileLinked
      ? '移动端：手机已连接'
      : mobileOn
        ? '移动端：已放行，等待手机扫码连接'
        : '移动端：未放行'

  return (
    <>
      <aside className="side">
        {/* 顶部常驻的「新建任务」：落在内置的「任务」目录（默认落脚点）。
            放在列表上方而不是塞进某一行里——它是全局动作，不属于任何单个文件夹。 */}
        <button
          className="side-newtask"
          title="在「任务」目录里新建一个任务"
          onClick={p.onNewTask}
        >
          <Plus size={15} />
          新建任务
        </button>
        <div className="projlist">
          {p.projects.length === 0 && (
            <div className="proj-empty">
              <FolderPlus size={22} />
              <span>还没有项目</span>
            <button className="ghost pick-dir" onClick={p.onAddProject}>
              选择文件夹
            </button>
            </div>
          )}
          {/*
            「任务」目录（builtin）恒居首位：渲染时先把它摘出来单独画，其余保持用户顺序。
            排序放在渲染层而不是 setProjects 时——存档里它本来就在最前，但用户若手动改过
            存档、或将来加了项目拖拽排序，渲染层这一句是唯一能保证「永远在最上面」的地方。
          */}
          {[...p.projects].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin)).map((proj) => {
            const isOpen = !!p.expanded[proj.id]
            const list = p.sessionsMap[proj.path] ?? []
            const count = shownCount[proj.id] ?? COLLAPSE_AT
            const shown = list.slice(0, count)
            return (
              <div key={proj.id}>
                <div
                  className={'proj' + (proj.builtin ? ' builtin' : '')}
                  title={proj.path}
                  onClick={() => p.onToggleProject(proj.id)}
                  onContextMenu={(e) => openMenu(proj, e)}
                >
                  <Folder size={15} className="proj-ico" />
                  <span className="proj-name">{proj.name}</span>
                  {/* hover 只留「添加任务」一个：打开文件夹/从列表移除都归右键菜单，
                      图标堆在行右端反而容易点错 */}
                  <span className="proj-actions">
                    <button
                      className="icon-btn"
                      title="添加任务"
                      onClick={(e) => {
                        e.stopPropagation()
                        p.onNewSession(proj.id)
                      }}
                    >
                      <MessageSquarePlus size={14} />
                    </button>
                  </span>
                </div>
                {isOpen && (
                  <>
                    {shown.map((s) => (
                      <div
                        key={s.id}
                        className={'sess' + (s.id === p.sessionId && proj.id === p.activeId || p.loadingSids[s.id] ? ' on' : '')}
                        onClick={() => p.onPickSession(proj, s.id)}
                        title={s.title}
                      >
                        {s.title ?? s.id}
                        {!!p.busyIds[s.id] && (
                          <span className="sess-busy" title="处理中">
                            <LoaderCircle size={13} className="spin" />
                          </span>
                        )}
                        <button
                          className="icon-btn sess-del"
                          title="删除会话"
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
                            显示更多会话
                          </>
                        ) : (
                          <>
                            <ChevronDown size={13} />
                            收起
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

        {/* 底栏：左侧是账号入口（未登录=登录，已登录=姓名），右侧两个图标只留图标一行靠右。
            远程服务关掉时左侧账号入口与右侧手机图标都不渲染，只剩「设置」——它们全依赖平台接口。 */}
        <div className="side-foot">
          {p.remote && (p.platform?.loggedIn ? (
            <button
              type="button"
              className="foot-user on"
              title={`${p.platform.user?.name ?? '已登录'}${p.platform.user?.email ? ' · ' + p.platform.user.email : ''}\n点击查看账号、积分与用量`}
              onClick={p.onOpenAccount}
            >
              <CircleUser size={15} />
              <span className="fu-name">{p.platform.user?.name || '已登录'}</span>
            </button>
          ) : (
            <button
              type="button"
              className="foot-user login"
              title={p.platform?.error ? '上次登录没成功：' + p.platform.error : '登录平台账号后即可使用内置模型'}
              disabled={p.platformBusy}
              onClick={p.onLogin}
            >
              {p.platformBusy ? <LoaderCircle size={15} className="spin" /> : <LogIn size={15} />}
              <span className="fu-name">登录</span>
            </button>
          ))}
          <div
            className={'foot-btn' + (p.view === 'settings' ? ' on' : '')}
            title="设置"
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
                {mobileLinked && <span className="mob-dot" title="手机已连接" />}
              </div>
              <div className="mobpop">
                <div className="mobpop-inner">
                  <div className="mp-head">
                    <span className="mp-title">移动端连接</span>
                    {/* 换码按钮放标题行：二维码下面留白给码本身 */}
                    <button
                      className="mp-rot"
                      title="换一张二维码（旧码立即作废）"
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
                    <div className="mp-qrph">{p.mobile?.error ? '二维码暂时取不到' : '二维码生成中…'}</div>
                  )}

                  {p.mobile?.error && <p className="mp-err">{p.mobile.error}</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        {confirmDel && (
          <Modal title="移除项目" onClose={() => setConfirmDel(null)}>
            <p className="confirm-text">
              确定把「{confirmDel.name}」从项目列表移除吗？不会删除本地文件夹与历史记录。
            </p>
            <div className="actions">
              <button className="ghost" onClick={() => setConfirmDel(null)}>
                取消
              </button>
              <button
                className="primary danger-btn"
                onClick={() => {
                  p.onRemoveProject(confirmDel.id)
                  setConfirmDel(null)
                }}
              >
                移除
              </button>
            </div>
          </Modal>
        )}

        {confirmDelSess && (
          <Modal title="删除会话" onClose={() => setConfirmDelSess(null)}>
            <p className="confirm-text">
              确定删除「{confirmDelSess.sess.title ?? confirmDelSess.sess.id}」吗？聊天记录将一并删除，不可恢复。
            </p>
            <div className="actions">
              <button className="ghost" onClick={() => setConfirmDelSess(null)}>
                取消
              </button>
              <button
                className="primary danger-btn"
                onClick={() => {
                  p.onDeleteSession(confirmDelSess.proj, confirmDelSess.sess.id)
                  setConfirmDelSess(null)
                }}
              >
                删除
              </button>
            </div>
          </Modal>
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
              打开文件夹
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                p.onNewSession(menu.proj.id)
                setMenu(null)
              }}
            >
              <MessageSquarePlus size={14} />
              添加任务
            </button>
            {menu.proj.builtin ? null : (
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
                  从列表移除
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
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
      aria-label="移动端配对二维码"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}
