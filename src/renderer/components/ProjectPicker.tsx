import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, FolderPlus, KeyRound, Search, ShieldCheck } from 'lucide-react'
import { fuzzyMatch, splitByRanges } from '../lib/fuzzy'
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
  const [query, setQuery] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /** 关面板就清空查询：下次打开是干净的全部列表，而不是上次搜剩的几条 */
  useEffect(() => {
    if (!open) setQuery('')
    else searchRef.current?.focus()
  }, [open])

  const cur = value ? projects.find((p) => p.id === value) : undefined
  const display = cur ? cur.name : '选择项目'
  /**
   * 「任务」目录（builtin）恒居首位：与左栏同一套规则（排序放在渲染层是唯一能保证
   * 「永远在最上面」的地方）。项目数组的默认顺序是「最近活动优先」，所以这里必须显式再排一次。
   */
  const ordered = [...projects].sort((a, b) => Number(b.builtin ? 1 : 0) - Number(a.builtin ? 1 : 0))

  /**
   * 模糊搜索：名字与路径同时参与，取更高分。
   *
   * 路径也进匹配是因为重名目录太常见（好几个 `test`），光看名字分不出是哪个，
   * 但用户脑子里记的往往是「d 盘那个 test」——敲 `dtest` 就该筛出来。
   * 命中后按分数重排，最相关的顶到最上面；不命中则退回原来的顺序（不搜就是全列表）。
   */
  const q = query.trim()
  const matched = useMemo(() => {
    if (!q) return ordered.map((p) => ({ p, nameRanges: null as null | ReturnType<typeof splitByRanges> }))
    const scored: { p: Project; score: number; nameRanges: ReturnType<typeof splitByRanges> | null }[] = []
    for (const p of ordered) {
      const byName = fuzzyMatch(p.name, q)
      const byPath = fuzzyMatch(p.path, q)
      // 名字命中优先于路径命中：用户找的是「那个文件夹」，名字才是它给人的印象
      if (byName) {
        scored.push({ p, score: byName.score + 10, nameRanges: splitByRanges(p.name, byName.ranges) })
      } else if (byPath) {
        scored.push({ p, score: byPath.score, nameRanges: null })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored
  }, [ordered, q])

  return (
    <div className="menu-wrap pp" ref={wrap}>
      <button type="button" className="menu-trigger pp" onClick={() => setOpen((v) => !v)}>
        <Folder size={14} />
        <span className="menu-label">{display}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && (
        <div className="menu-panel pp up">
          {/* 搜索框常显（项目少时也不藏）：藏起来用户就不知道有这个能力，等于没做 */}
          <div className="pp-search">
            <Search size={13} className="pp-search-ico" />
            <input
              ref={searchRef}
              className="pp-search-input"
              value={query}
              placeholder="搜索文件夹"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // 输入框里按 Esc 先清空/关闭，不然会穿透到外层把窗口带偏
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  if (query) setQuery('')
                  else setOpen(false)
                }
                // 回车开第一个：搜到唯一目标时不必再用鼠标点
                if (e.key === 'Enter' && matched[0]) {
                  onChange(matched[0].p.id)
                  setOpen(false)
                }
              }}
            />
          </div>
          <div className="pp-list">
            {matched.map(({ p, nameRanges }) => (
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
                {/* 名字按命中位置分段高亮；命中在路径上时名字不拆，避免标错地方 */}
                <span className="pp-name">
                  {nameRanges
                    ? nameRanges.map((seg, i) =>
                        seg.hit ? <mark key={i} className="pp-hit">{seg.text}</mark> : <span key={i}>{seg.text}</span>
                      )
                    : p.name}
                </span>
              </button>
            ))}
            {q && matched.length === 0 && <div className="pp-empty">没找到匹配的文件夹</div>}
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
