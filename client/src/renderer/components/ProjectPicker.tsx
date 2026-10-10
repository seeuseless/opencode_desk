import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, FolderPlus, Search } from 'lucide-react'
import { fuzzyMatch, splitByRanges } from '../lib/fuzzy'
import { t } from '../i18n'
import type { Project } from './Sidebar'

interface Props {
  projects: Project[]
  value?: string
  onChange: (id: string) => void
  onPickDir: () => void
  /** 全局访问权限档位（权限对所有文件夹生效，不跟项目走） */
  access: 'default' | 'full'
  onAccess: (level: 'default' | 'full') => void
}

/**
 * 项目级联下拉：按钮显示当前项目，面板里是项目列表 + 底部「选择文件夹」+「访问权限」。
 *
 * 访问权限 2026-09-27 曾移到 设置 → 通用 作全局配置，后又移回聊天里、
 * 放在「选择文件夹」下方（与上次不同：这次固定在项目面板底部，常显当前档位）。
 */
export function ProjectPicker({ projects, value, onChange, onPickDir, access, onAccess }: Props) {
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
  const display = cur ? cur.name : t('选择项目')
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
      {/* 极窄栏时标签会被容器查询藏掉只留图标，title 兜底说明 */}
      <button type="button" className="menu-trigger pp" title={t('切换项目文件夹')} onClick={() => setOpen((v) => !v)}>
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
              placeholder={t('搜索文件夹')}
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
            {q && matched.length === 0 && <div className="pp-empty">{t('没找到匹配的文件夹')}</div>}
            <button
              type="button"
              className="pp-item pp-pick"
              onClick={() => {
                setOpen(false)
                onPickDir()
              }}
            >
              <FolderPlus size={14} className="pp-ico" />
              <span className="pp-name">{t('选择文件夹')}</span>
            </button>
            <label className="pp-access">
              <span className="pp-access-tip">{t('访问权限')}</span>
              <select
                className="pp-access-select"
                value={access}
                onChange={(e) => onAccess(e.target.value as 'default' | 'full')}
              >
                <option value="default">{t('默认权限')}</option>
                <option value="full">{t('完全控制')}</option>
              </select>
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

