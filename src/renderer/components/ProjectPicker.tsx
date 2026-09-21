import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, FolderPlus, KeyRound, ShieldCheck } from 'lucide-react'
import type { AccessLevel, Project } from './Sidebar'

interface Props {
  projects: Project[]
  value?: string
  onChange: (id: string) => void
  onPickDir: () => void
}

/**
 * 项目级联下拉：按钮显示当前项目，面板里是项目列表 + 底部「选择文件夹」。
 *
 * 访问权限**不在这里** —— 它是紧挨本按钮右侧的独立控件（AccessPicker）。
 * 早先把两档权限塞进这个面板的右栏，等于「想改权限得先打开项目下拉」，
 * 面板一关就看不见当前档位，用户根本意识不到有那么个开关。
 */
export function ProjectPicker({ projects, value, onChange, onPickDir }: Props) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const cur = value ? projects.find((p) => p.id === value) : undefined
  const display = cur ? cur.name : '选择项目'
  /**
   * 「任务」目录（builtin）恒居首位：与左栏同一套规则（排序放在渲染层是唯一能保证
   * 「永远在最上面」的地方）。项目数组的默认顺序是「最近活动优先」，所以这里必须显式再排一次。
   */
  const ordered = [...projects].sort((a, b) => Number(b.builtin ? 1 : 0) - Number(a.builtin ? 1 : 0))

  return (
    <div className="menu-wrap pp" ref={wrap}>
      <button type="button" className="menu-trigger pp" onClick={() => setOpen((v) => !v)}>
        <Folder size={14} />
        <span className="menu-label">{display}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && (
        <div className="menu-panel pp up">
          <div className="pp-list">
            {ordered.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'pp-item' + (p.id === value ? ' on' : '')}
                title={p.path}
                onClick={() => {
                  onChange(p.id)
                  setOpen(false)
                }}
              >
                <span className="pp-check">{p.id === value && <Check size={13} />}</span>
                <span className="pp-name">{p.name}</span>
              </button>
            ))}
            <button
              type="button"
              className="pp-item pp-pick"
              onClick={() => {
                setOpen(false)
                onPickDir()
              }}
            >
              <FolderPlus size={14} className="pp-ico" />
              <span className="pp-name">选择文件夹</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 访问权限选择：底部输入区里独立的一颗按钮，紧挨「选择文件夹」右侧。
 *
 * 为什么独立成一颗常显按钮：权限是「AI 能在本机动多狠」的状态，必须**随时可见**。
 * 埋在项目下拉面板里，关上面板就不知道现在是哪一档——用户会以为一直是昨晚那档。
 * 按钮上直接写档位名，选中态给亮色；「完全控制」额外常显亮色边框，因为它是高危档，
 * 不该跟「默认权限」长得一样而被划过去。
 *
 * **权限是全局一档，对所有文件夹生效**（与左右选哪个项目无关）。所以按钮旁边不出现
 * 任何项目名，面板标题也写成「访问权限（所有文件夹）」——避免被读成「当前项目的权限」。
 * 面板内给两档的完整说明（各一句「会怎样」），比按钮上的两字标签更能支撑决策。
 * 切到「完全控制」的二次确认由 App 负责，这里只负责发起请求。
 */
export function AccessPicker({
  access,
  onAccess
}: {
  /** 全局访问权限档位（'default' = 写操作要确认 / 'full' = 完全控制） */
  access: AccessLevel
  onAccess: (level: AccessLevel) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const full = access === 'full'

  /** 选中即关面板：档位只有一个维度，选完没有别的要填，留着面板反而挡视线 */
  const pick = (level: AccessLevel) => {
    setOpen(false)
    onAccess(level)
  }

  return (
    <div className="menu-wrap ap" ref={wrap}>
      <button
        type="button"
        className={'menu-trigger ap' + (full ? ' full' : '')}
        title={full ? '访问权限：完全控制（对所有文件夹生效）' : '访问权限：默认权限（对所有文件夹生效）'}
        onClick={() => setOpen((v) => !v)}
      >
        {full ? <ShieldCheck size={14} /> : <KeyRound size={14} />}
        <span className="menu-label">{full ? '完全控制' : '默认权限'}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && (
        <div className="menu-panel ap up">
          <button
            type="button"
            className={'ap-b' + (full ? '' : ' on')}
            onClick={() => pick('default')}
          >
            <KeyRound size={14} />
            <div className="ap-t">
              <b>默认权限</b>
              <i>改动文件、执行命令前先弹窗问你</i>
            </div>
          </button>
          <button type="button" className={'ap-b' + (full ? ' on' : '')} onClick={() => pick('full')}>
            <ShieldCheck size={14} />
            <div className="ap-t">
              <b>完全控制</b>
              <i>不再询问，直接读写文件、跑命令</i>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
