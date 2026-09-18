import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, LoaderCircle, Sparkles } from 'lucide-react'

export interface ModelGroupModel {
  mid: string
  /** 展示名（一般与 mid 相同；平台模型的 mid 就是模型名） */
  name?: string
  /**
   * 以下四个只有平台的「内置模型」有：第三方 provider 的模型没有计价信息，
   * 遂不显示标签与倍率（栏目留白，不硬塞一个假倍率）。
   */
  /** 限免：活动期内不扣积分 */
  free?: boolean
  /** 折扣倍率（0.01–0.99）；null = 不打折 */
  discount?: number | null
  /** 原价倍率 */
  ratio?: number
  /** 实际扣费倍率：限免为 0，打折已乘折扣 */
  effRatio?: number
}

export interface ModelGroup {
  id: string
  label: string
  models: ModelGroupModel[]
}

interface Props {
  groups: ModelGroup[]
  /** 'providerID/modelID' */
  value: string
  onChange: (v: string) => void
  /** 点击「去配置模型」跳转到设置页 */
  onOpenSettings?: () => void
  /**
   * 展开某个分组时触发（只在「从收起到展开」那一下调）。
   * 平台「内置模型」靠它按需刷新计价——限免/折扣是平台随时会改的，不能拿旧快照当事实。
   */
  onExpandGroup?: (id: string) => void
  /** 正在后台刷新的分组 id：行尾转个圈，列表照旧显示旧值（无感，不清空、不阻塞） */
  refreshingGroup?: string
}

/** 二级级联模型菜单：默认只显示一级提供商，点击后展开二级模型列 */
export function ModelPicker({ groups, value, onChange, onOpenSettings, onExpandGroup, refreshingGroup }: Props) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState('')
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setExpanded('')
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const i = value.indexOf('/')
  const curGroup = i > 0 ? groups.find((g) => g.id === value.slice(0, i)) : undefined
  const curModel = curGroup && i > 0 ? curGroup.models.find((m) => m.mid === value.slice(i + 1)) : undefined
  // 列表尚未命中（如存档值待校正）时，直接按 'pid/mid' 原样显示，保证选中态始终是 模型/模型 格式
  const display =
    curGroup && curModel
      ? `${curGroup.label}/${curModel.mid}`
      : i > 0
        ? `${value.slice(0, i)}/${value.slice(i + 1)}`
        : '选择模型'
  const active = groups.find((g) => g.id === expanded)

  return (
    <div className="menu-wrap mp" ref={wrap}>
      <button type="button" className="menu-trigger mp" onClick={() => setOpen((v) => !v)}>
        <Sparkles size={14} />
        <span className="menu-label">{display}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && (
        <div className="menu-panel mp up">
          <div className="mp-col">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                className={'mp-item' + (g.id === active?.id ? ' on' : '')}
                onClick={() => {
                  const willExpand = active?.id !== g.id
                  setExpanded(willExpand ? g.id : '')
                  if (willExpand) onExpandGroup?.(g.id)
                }}
              >
                <span className="mp-name">{g.label}</span>
                {refreshingGroup === g.id ? (
                  <LoaderCircle size={13} className="mp-arrow spin" />
                ) : (
                  <ChevronRight size={13} className="mp-arrow" />
                )}
              </button>
            ))}
            <button
              type="button"
              className="mp-item mp-config"
              onClick={() => {
                setOpen(false)
                onOpenSettings?.()
              }}
            >
              <span className="mp-name">配置模型</span>
            </button>
          </div>
          {active && active.models.length > 0 && (
            <div className="mp-col2-float">
              {active.models.map((m) => (
                <button
                  key={m.mid}
                  type="button"
                  className="mp-item mp-model"
                  onClick={() => {
                    onChange(`${active.id}/${m.mid}`)
                    setOpen(false)
                  }}
                >
                  <span className="mi-check">{`${active.id}/${m.mid}` === value && <Check size={13} />}</span>
                  <span className="mp-name">{m.name || m.mid}</span>
                  <Tag m={m} />
                  <Rate m={m} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 计价标签：限免 / 折扣。
 * 只在平台模型上出现（第三方 provider 的模型压根没有这些字段）。
 */
function Tag({ m }: { m: ModelGroupModel }) {
  if (isFree(m)) return <span className="mp-tag free">限免</span>
  if (m.discount) return <span className="mp-tag off">折扣</span>

  return null
}

/**
 * 最右侧的倍率。
 *
 * 现在是活动价时把两个数都摆出来：前面是**实价**（限免即 0x），后面那个**原价划掉**——
 * 一句话告诉用户「本来要花钱，现在免费」，比只写一个 0x 更让人敢用。
 */
function Rate({ m }: { m: ModelGroupModel }) {
  const eff = effective(m)
  const list = m.ratio
  if (list === undefined) return <span className="mp-rate" />

  const cut = eff !== undefined && eff < list

  return (
    <span className="mp-rate">
      {cut ? (
        <>
          {/* 免费用绿色点一下，比单写一个 0x 更让人敢点 */}
          <b className={'mp-rate-now' + (eff === 0 ? ' free' : '')}>{fmtRate(eff!)}</b>
          <span className="mp-rate-old">{fmtRate(list)}</span>
        </>
      ) : (
        <span>{fmtRate(eff ?? list)}</span>
      )}
    </span>
  )
}

/** 限免与「实际倍率 0」是一回事：平台两种写法都认 */
function isFree(m: ModelGroupModel): boolean {
  return m.free === true || m.effRatio === 0
}

/** 实际扣费倍率：优先用它，缺了再按限免/折扣自己算一遍 */
function effective(m: ModelGroupModel): number | undefined {
  if (m.effRatio !== undefined) return m.effRatio
  if (isFree(m)) return 0
  if (m.ratio === undefined) return undefined

  return m.discount ? m.ratio * m.discount : m.ratio
}

/** 倍率写法：1 → 1x，0.2 → 0.2x（去掉多余的零，别写成 1.00x） */
function fmtRate(n: number): string {
  return `${Number(n.toFixed(2))}x`
}
