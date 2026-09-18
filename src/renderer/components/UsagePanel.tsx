import { useCallback, useEffect, useState } from 'react'
import { BarChart3, LoaderCircle, LogIn, RefreshCw } from 'lucide-react'
import { fmtNumber, fmtTokens, daysAgoYmd, ymd } from '../format'
import type { UsageSeries, UsageSummary } from '../oc'

interface Props {
  /** 平台登录态：未登录时整页只显示一句「先登录」 */
  loggedIn: boolean
  platformBusy: boolean
  onLogin: () => void
}

/**
 * 设置 → 使用量：总量 / 今日 / 昨日 + 各模型用量 + 趋势折线图 + 时间范围。
 *
 * 数据全部来自平台（/api/ide/usage/summary），本地不留缓存：
 * 用量是「平台记账」的事实，客户端自己攒一份迟早对不上。
 * 区间默认最近 30 天，跟后台概览同一口径。
 */
export function UsagePanel(p: Props) {
  const [from, setFrom] = useState(() => daysAgoYmd(29))
  const [to, setTo] = useState(() => ymd(new Date()))
  const [data, setData] = useState<UsageSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async (f: string, t: string) => {
    setBusy(true)
    setErr('')
    try {
      const d = await window.qingniao.platformUsage({ from: f, to: t })
      if (d) setData(d)
      else setErr('取不到用量数据，可能是登录已失效')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (p.loggedIn) void load(from, to)
  }, [p.loggedIn, load])

  if (!p.loggedIn) {
    return (
      <section>
        <h3>
          <BarChart3 size={15} /> 使用量
        </h3>
        <p className="sec-tip">用量记在平台账号下。登录后这里会显示总 token 量、今日与昨日用量，以及各模型的消耗明细。</p>
        <div className="plist-empty">
          <button className="ghost" disabled={p.platformBusy} onClick={p.onLogin}>
            {p.platformBusy ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />} 登录后查看
          </button>
        </div>
      </section>
    )
  }

  const maxModel = Math.max(1, ...(data?.models ?? []).map((m) => m.tokens))
  const series = data?.series
  /** 条形图与折线图同色：同一个模型在哪儿都是同一个颜色，两处对照着看不用回头找名字 */
  const colorOf = (label: string) => {
    const i = series?.models.findIndex((m) => m.label === label) ?? -1

    return i >= 0 ? LINE_COLORS[i % LINE_COLORS.length] : 'var(--fg2)'
  }

  return (
    <section>
      <h3>
        <BarChart3 size={15} /> 使用量
        <span className="spacer" />
        <button className="ghost" disabled={busy} onClick={() => void load(from, to)}>
          <RefreshCw size={13} className={busy ? 'spin' : undefined} /> 刷新
        </button>
      </h3>
      <p className="sec-tip">
        消耗积分 = 总 token 量 ÷ 1000 × 模型倍率（限免模型不计费、打折模型按折扣后的倍率算）。
        当前积分余额 <b>{data?.exempt ? '不限（管理员不参与计费）' : fmtNumber(data?.points)}</b>。
      </p>

      <div className="usage-cards">
        <UsageCard title="总量" tokens={data?.all.tokens} calls={data?.all.calls} points={data?.all.points} />
        <UsageCard title="今日" tokens={data?.today.tokens} calls={data?.today.calls} points={data?.today.points} />
        <UsageCard title="昨日" tokens={data?.yesterday.tokens} calls={data?.yesterday.calls} points={data?.yesterday.points} />
      </div>

      <div className="usage-range">
        <label>
          从
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          到
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="ghost" onClick={() => { setFrom(daysAgoYmd(6)); setTo(ymd(new Date())) }}>近 7 天</button>
        <button className="ghost" onClick={() => { setFrom(daysAgoYmd(29)); setTo(ymd(new Date())) }}>近 30 天</button>
        <button className="primary" disabled={busy} onClick={() => void load(from, to)}>查询</button>
        <span className="usage-range-tip">
          区间内 {fmtTokens(data?.range.tokens)} token · {fmtNumber(data?.range.calls)} 次 · {fmtNumber(data?.range.points)} 积分
        </span>
      </div>

      {err && <p className="form-msg block bad">{err}</p>}

      <div className="usage-sec">
        <div className="usage-sec-title">各模型用量</div>
        {(data?.models.length ?? 0) === 0 ? (
          <div className="plist-empty hint">这个区间里还没有调用记录</div>
        ) : (
          <div className="ubars">
            {data!.models.map((m) => (
              <div className="ubar" key={m.label}>
                <span className="ubar-dot" style={{ background: colorOf(m.label) }} />
                <span className="ubar-name" title={m.label}>{m.label}</span>
                <span className="ubar-track">
                  <i style={{ width: `${Math.max(2, (m.tokens / maxModel) * 100)}%`, background: colorOf(m.label) }} />
                </span>
                <span className="ubar-val">
                  {fmtTokens(m.tokens)}
                  <em>{fmtNumber(m.points)} 分</em>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="usage-sec">
        <div className="usage-sec-title">用量趋势</div>
        {!series || series.models.length === 0 ? (
          <div className="plist-empty hint">这个区间里还没有调用记录</div>
        ) : (
          <Trend series={series} />
        )}
      </div>
    </section>
  )
}

/** 一张口径卡：token 是主角，次数与积分作副信息 */
function UsageCard(p: { title: string; tokens?: number; calls?: number; points?: number }) {
  return (
    <div className="ucard">
      <div className="ucard-k">{p.title}</div>
      <div className="ucard-v">{fmtTokens(p.tokens)}</div>
      <div className="ucard-s">
        {fmtNumber(p.calls)} 次调用 · {fmtNumber(p.points)} 积分
      </div>
    </div>
  )
}

/** 折线配色：8 条线互不撞色，浅色主题下都压得住白底 */
const LINE_COLORS = ['#2563eb', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d']

/** 图画布尺寸（viewBox 坐标系，实际按容器宽度等比缩放） */
const W = 660
const H = 210
const PAD = { l: 48, r: 14, t: 12, b: 26 }

/**
 * 用量趋势折线图：一个模型一条线，横轴是区间内的每一天。
 *
 * 手绘 SVG 而不是引图表库：这里只有「几条折线 + 网格 + 悬浮读数」，
 * 引入一个几百 KB 的库只为这一处不划算，而且自带样式跟主题变量对不上。
 */
function Trend({ series }: { series: UsageSeries }) {
  const [hover, setHover] = useState<number | null>(null)

  const n = series.dates.length
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  // 纵轴上限取一个「整齐」的数，避免出现 3,847,201 这种刻度
  const max = niceMax(Math.max(1, ...series.models.flatMap((m) => m.points)))
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v: number) => PAD.t + ih - (v / max) * ih

  /** 横向网格（含 0 轴）：4 格足够读数，再多就成一堆线了 */
  const rows = [0, 0.25, 0.5, 0.75, 1]
  /** 横轴标签最多 6 个：区间拉长时按等距抽样，不然日期会糊成一片 */
  const step = Math.max(1, Math.ceil(n / 6))
  const ticks = series.dates.map((d, i) => ({ d, i })).filter((t) => t.i % step === 0 || t.i === n - 1)

  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = n <= 1 ? 0 : Math.round(((px - PAD.l) / iw) * (n - 1))
    setHover(Math.min(n - 1, Math.max(0, i)))
  }

  const at = hover === null ? null : series.dates[hover]
  const total = hover === null ? 0 : series.models.reduce((s, m) => s + (m.points[hover] ?? 0), 0)
  // 悬浮读数贴着竖线站：靠右边时向左收，免得被容器裁掉
  const hp = hover === null ? 0 : x(hover) / W
  const tipStyle: React.CSSProperties = {
    left: `${hp * 100}%`,
    transform: hp > 0.72 ? 'translateX(-100%)' : hp < 0.16 ? 'translateX(0)' : 'translateX(-50%)'
  }

  return (
    <div className="utrend">
      <svg
        className="utrend-svg"
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={pick}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="各模型用量趋势"
      >
        {rows.map((r) => {
          const gy = PAD.t + ih * r

          return (
            <g key={r}>
              <line className="utrend-grid" x1={PAD.l} y1={gy} x2={W - PAD.r} y2={gy} />
              <text className="utrend-ytick" x={PAD.l - 8} y={gy + 3.5} textAnchor="end">
                {fmtTokens(Math.round(max * (1 - r)))}
              </text>
            </g>
          )
        })}

        {ticks.map((t) => (
          <text key={t.d} className="utrend-xtick" x={x(t.i)} y={H - 8} textAnchor="middle">
            {t.d.slice(5)}
          </text>
        ))}

        {hover !== null && <line className="utrend-cursor" x1={x(hover)} y1={PAD.t} x2={x(hover)} y2={PAD.t + ih} />}

        {series.models.map((m, mi) => {
          const color = LINE_COLORS[mi % LINE_COLORS.length]
          const pts = m.points.map((v, i) => `${x(i)},${y(v)}`).join(' ')

          return (
            <g key={m.label}>
              {/* 只有一个数据点时折线画不出来（polyline 至少两点），改画一个点 */}
              {n > 1 && <polyline className="utrend-line" points={pts} stroke={color} />}
              {n === 1 && <circle cx={x(0)} cy={y(m.points[0] ?? 0)} r={3} fill={color} />}
              {hover !== null && <circle cx={x(hover)} cy={y(m.points[hover] ?? 0)} r={3.2} fill={color} />}
            </g>
          )
        })}
      </svg>

      {hover !== null && at && (
        <div className="utrend-tip" style={tipStyle}>
          <div className="utrend-tip-h">
            {at}
            <span>{fmtTokens(total)}</span>
          </div>
          {series.models
            .map((m, mi) => ({ m, mi, v: m.points[hover] ?? 0 }))
            .filter((r) => r.v > 0)
            .map((r) => (
              <div className="utrend-tip-r" key={r.m.label}>
                <span className="udot" style={{ background: LINE_COLORS[r.mi % LINE_COLORS.length] }} />
                <span className="utrend-tip-n" title={r.m.label}>{r.m.label}</span>
                <span className="utrend-tip-v">{fmtTokens(r.v)}</span>
              </div>
            ))}
          {total === 0 && <div className="utrend-tip-none">这天没有调用</div>}
        </div>
      )}

      <div className="utrend-legend">
        {series.models.map((m, mi) => (
          <span className="uleg" key={m.label} title={m.label}>
            <i style={{ background: LINE_COLORS[mi % LINE_COLORS.length] }} />
            <span className="uleg-n">{m.label}</span>
            <em>{fmtTokens(m.tokens)}</em>
          </span>
        ))}
      </div>
    </div>
  )
}

/** 把纵轴上限抬到一个整齐的数：3847201 → 5000000，读数才不刺眼 */
function niceMax(v: number): number {
  const base = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / base
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10

  return step * base
}
