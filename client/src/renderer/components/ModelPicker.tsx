import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, LoaderCircle, Sparkles } from 'lucide-react'
import { t } from '../i18n'

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
  /**
   * Zen 免 KEY 免费模型。
   *
   * 与 `free` 分开：`free` 是平台计费口径的「限免」（要登录、要算积分），
   * 这个是「压根不需要 Key、不过平台」。所以标签文案也不同，见 Tag()。
   */
  zenFree?: boolean
}

export interface ModelGroup {
  id: string
  label: string
  models: ModelGroupModel[]
}

function shortModelName(name: string): string {
  const i = name.lastIndexOf('/')
  return i >= 0 ? name.slice(i + 1) : name
}

interface Props {
  groups: ModelGroup[]
  /** 'providerID/modelID' */
  value: string
  onChange: (v: string) => void
  /** 点击「去配置模型」跳转到设置页 */
  onOpenSettings?: () => void
  /** 代码模式右侧较窄，只显示模型名；普通模式显示 provider/model */
  codeMode?: boolean
  /**
   * 展开某个分组时触发（只在「从收起到展开」那一下调）。
   * 平台「内置模型」靠它按需刷新计价——限免/折扣是平台随时会改的，不能拿旧快照当事实。
   */
  onExpandGroup?: (id: string) => void
  /** 正在后台刷新的分组 id：行尾转个圈，列表照旧显示旧值（无感，不清空、不阻塞） */
  refreshingGroup?: string
  /**
   * 面板被点开的那一刻触发（只在「从收起变展开」那一下）。
   *
   * 给 opencode 限免分组用：它的清单要向内核问，所以推迟到用户真的要用模型时才同步，
   * 免得每次启动都为一批可能用不上的模型多问一次、多等一会儿。
   */
  onOpen?: () => void
}

/** 二级级联模型菜单：默认只显示一级提供商，点击后展开二级模型列 */
export function ModelPicker({ groups, value, onChange, onOpenSettings, codeMode, onExpandGroup, refreshingGroup, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const sub = useRef<HTMLDivElement>(null)
  /** 二级列顶边相对面板顶边的偏移 = 被点中那一行的位置（见下方 useLayoutEffect 说明） */
  const [subTop, setSubTop] = useState(0)
  /** 夹回窗口内的二次修正量：长列表展开后可能顶出屏幕上下沿 */
  const [subShift, setSubShift] = useState(0)
  const [panelShift, setPanelShift] = useState(0)
  /**
   * 面板展开的「瞬时动作」快照：只在面板从收起变展开的那一下做（点开面板 / 收起再点开），
   * 用 ref 存、与渲染解耦，避免父组件因 settings 刷新产生的新回调引用把面板状态反复复位。
   *
   * 背景（2026-10-09）：打开面板会同步 opencode 限免清单（onOpen），清单异步回来后
   * p.onSettings 触顶重渲染，父组件每轮都传新的 `onOpen` 引用；若把它放进 deps，
   * useEffect 会跟着重跑，里面的 setExpanded('')/setSubTop(0) 等无条件复位把用户已展开的
   * 二级列顶回收起 → 面板「闪一下」。所以这里只在 open 由 false→true 的瞬间做，其余渲染一律不碰。
   */
  const prevOpen = useRef(false)
  const lastOnOpen = useRef(onOpen)
  lastOnOpen.current = onOpen // 每次渲染都更新，回调里取的就是最新版

  useEffect(() => {
    const justOpened = open && !prevOpen.current
    prevOpen.current = open
    if (!open) return
    if (justOpened) {
      setExpanded('')
      setSubTop(0)
      setSubShift(0)
      setPanelShift(0)
      lastOnOpen.current?.()
    }
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
      ? codeMode
        ? shortModelName(curModel.name || curModel.mid)
        : value
      : i > 0
        ? codeMode
          ? shortModelName(value)
          : value
        : t('选择模型')
  const active = groups.find((g) => g.id === expanded)

  /** 代码模式右侧聊天变窄时，模型菜单也不能从窗口边缘溢出去。 */
  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let shift = 0
    if (r.left < pad) shift = pad - r.left
    if (r.right + shift > window.innerWidth - pad) shift = window.innerWidth - pad - r.right
    setPanelShift((current) => Math.abs(current - shift) > 0.5 ? shift : current)
  }, [open, expanded])

  /**
   * 二级模型列**浮在面板左侧**，顶边必须跟被点中的一级行对齐：
   * 写死 top:0 会让它永远贴着列表顶部——选中的提供商在下面几行时，模型列就飘到老远的地方去了。
   * 对齐后再夹一次：面板是向上展开的，模型一多容易顶出窗口上/下沿。
   */
  useLayoutEffect(() => {
    const el = sub.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let d = 0
    if (r.bottom > window.innerHeight - pad) d = window.innerHeight - pad - r.bottom
    if (r.top + d < pad) d = pad - r.top
    if (Math.abs(d) > 0.5) setSubShift((s) => s + d)
  }, [expanded, active?.models.length])

  return (
    <div className="menu-wrap mp" ref={wrap}>
      <button type="button" className="menu-trigger mp" onClick={() => setOpen((v) => !v)}>
        <Sparkles size={14} />
        <span className="menu-label">{display}</span>
        <ChevronDown size={14} className={'chev' + (open ? ' up' : '')} />
      </button>
      {open && (
        <div className="menu-panel mp up" ref={panel} style={{ transform: `translateX(calc(-50% + ${panelShift}px))` }}>
          <div className="mp-col">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                className={'mp-item' + (g.id === active?.id || g.id === curGroup?.id ? ' on' : '')}
                onClick={(e) => {
                  const willExpand = active?.id !== g.id
                  const p = panel.current
                  // 用 rect 差值而不是 offsetTop：offsetParent 与 padding 的口径容易算错，rect 是屏幕实测值
                  setSubTop(
                    willExpand && p ? e.currentTarget.getBoundingClientRect().top - p.getBoundingClientRect().top : 0
                  )
                  setSubShift(0)
                  setExpanded(willExpand ? g.id : '')
                  if (willExpand) onExpandGroup?.(g.id)
                }}
              >
                <span className="mp-name">{t(g.label)}</span>
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
              <span className="mp-name">{t('配置模型')}</span>
            </button>
          </div>
          {active && active.models.length > 0 && (
            <div className="mp-col2-float" ref={sub} style={{ top: subTop + subShift }}>
              {active.models.map((m) => (
                <button
                  key={m.mid}
                  type="button"
                  className={'mp-item mp-model' + (`${active.id}/${m.mid}` === value ? ' on' : '')}
                  onClick={() => {
                    onChange(`${active.id}/${m.mid}`)
                    setOpen(false)
                  }}
                >
                  <span className="mi-check">{`${active.id}/${m.mid}` === value && <Check size={13} />}</span>
                  <span className="mp-name">{shortModelName(m.name || m.mid)}</span>
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
 *
 * `zenFree`（opencode 限免分组）与平台 `free`（限免）都渲染成「限免」——
 * 用户视角都是"这段时间不花钱"。但字段仍要分开存：前者不经过平台计费、也没有倍率，
 * 后者要登录且受平台计费口径约束，混成一个字段迟早会在某个分支上判错。
 */
function Tag({ m }: { m: ModelGroupModel }) {
  if (m.zenFree) return <span className="mp-tag free">{t('限免')}</span>
  if (isFree(m)) return <span className="mp-tag free">{t('限免')}</span>
  if (m.discount) return <span className="mp-tag off">{t('折扣')}</span>

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
