import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderPlus, LoaderCircle, MessageSquarePlus, Settings, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { load, save } from '../store'
import type { Session } from '../oc'

export interface Project {
  id: string
  path: string
  name: string
  /** 添加时间，作为排序兜底 */
  added?: number
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
  view: 'chat' | 'settings'
  onToggleProject: (id: string) => void
  onRemoveProject: (id: string) => void
  onNewSession: (id: string) => void
  onAddProject: () => void
  onPickSession: (proj: Project, sid: string) => void
  onDeleteSession: (proj: Project, sid: string) => void
  onOpenSettings: () => void
}

export function Sidebar(p: Props) {
  /** 每个文件夹「显示全部会话」的展开状态——持久化，重启后记住 */
  const [expandAll, setExpandAll] = useState<Record<string, boolean>>(() => load('qingniao.sessExpand', {}))
  const [confirmDel, setConfirmDel] = useState<Project | null>(null)
  const [confirmDelSess, setConfirmDelSess] = useState<{ proj: Project; sess: Session } | null>(null)

  useEffect(() => save('qingniao.sessExpand', expandAll), [expandAll])

  return (
    <aside className="side">
      <div className="projlist">
        {p.projects.length === 0 && (
          <div className="proj-empty">
            <FolderPlus size={22} />
            <span>还没有项目</span>
            <button className="ghost" onClick={p.onAddProject}>
              添加项目文件夹
            </button>
          </div>
        )}
        {p.projects.map((proj) => {
          const isOpen = !!p.expanded[proj.id]
          const list = p.sessionsMap[proj.path] ?? []
          const all = !!expandAll[proj.id]
          const shown = all ? list : list.slice(0, COLLAPSE_AT)
          return (
            <div key={proj.id}>
              <div className="proj" title={proj.path} onClick={() => p.onToggleProject(proj.id)}>
                <Folder size={15} className="proj-ico" />
                <span className="proj-name">{proj.name}</span>
                <span className="proj-actions">
                  <button
                    className="icon-btn"
                    title="从列表移除"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDel(proj)
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="新会话"
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
                      className={'sess' + (s.id === p.sessionId && proj.id === p.activeId ? ' on' : '')}
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
                      onClick={() => setExpandAll((m) => ({ ...m, [proj.id]: !m[proj.id] }))}
                    >
                      {all ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      {all ? '收起' : `显示全部 ${list.length} 条会话`}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      <div className="side-foot">
        <div className={'sitem' + (p.view === 'settings' ? ' on' : '')} onClick={p.onOpenSettings}>
          <Settings size={16} /> 设置
        </div>
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
  )
}
