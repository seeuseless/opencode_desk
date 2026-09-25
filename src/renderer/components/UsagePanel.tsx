import { useCallback, useEffect, useState } from 'react'
import { BarChart3, LoaderCircle, RefreshCw } from 'lucide-react'
import { t } from '../i18n'
import { fmtNumber, fmtTokens, daysAgoYmd, ymd } from '../format'
import type { LocalUsage, LocalUsageBucket, LocalUsageRow, LocalUsageSeries } from '../oc'

/**
 * 设置 → 使用量（本机统计）。
 *
 * 数据全部来自内核的会话存储（主进程经内核 REST 聚合，见 electron/main/usage.ts），
 * **不依赖平台、不需要登录**——离线也有数，历史天然完整。口径是这台电脑：
 * 含全部项目的全部会话（包括手机端发起的）。
 *
 * 区间默认最近 30 天，只影响「各模型用量」与趋势；总量 / 今日 / 昨日是固定口径。
 * 没有积分概念：内核记的是 token 与调用次数，积分只在平台那侧有账。
 */
export function UsagePanel() {
  const [from, setFrom] = useState(() => daysAgoYmd(29))
  const [to, setTo] = useState(() => ymd(new Date()))
  const [data, setData] = useState<LocalUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async (f: string, td: string) => {
    setBusy(true)
    setErr('')
    try {
      setData(await window.qingniao.usageLocal({ from: f, to: td }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  // 挂载即拉：本机统计不需要任何前置条件
  useEffect(() => {
    void load(from, to)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  /** 换区间立即重查（近 7 天 / 近 30 天 / 查询共用） */
  const apply = (f: string, td: string) => {
    setFrom(f)
    setTo(td)
    void load(f, td)
  }

  const maxModel = Math.max(1, ...(data?.models ?? []).map((m) => m.tokens))

  return (
    <section>
      <h3>
        <BarChart3 size={15} /> {t('使用量')}
        <span className="spacer" />
        <button className="ghost" disabled={busy} onClick={() => void load(from, to)}>
          <RefreshCw size={13} className={busy ? 'spin' : undefined} /> {t('刷新')}
        </button>
      </h3>
      <p className="sec-tip">
        {t('统计来自这台电脑的内核会话记录，含全部项目与历史会话；token 量按模型返回的实际用量计。')}
      </p>

      {err && <p className="form-msg block bad">{t('本机统计读取失败：')}{err}</p>}

      <div className="usage-cards">
        <UsageCard title={t('总量')} bucket={data?.all} />
        <UsageCard title={t('今日')} bucket={data?.today} />
        <UsageCard title={t('昨日')} bucket={data?.yesterday} />
      </div>
      <div className="usage-cards">
        <UsageCard title={t('近 7 天')} bucket={data?.last7} />
        <UsageCard title={t('近 30 天')} bucket={data?.last30} />
        <UsageCard title={t('近 90 天')} bucket={data?.last90} />
      </div>

      <div className="usage-range">
        <label>
          {t('从')}
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t('到')}
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="ghost" onClick={() => apply(ymd(new Date()), ymd(new Date()))}>{t('今日')}</button>
        <button className="ghost" onClick={() => apply(daysAgoYmd(1), daysAgoYmd(1))}>{t('昨日')}</button>
        <button className="ghost" onClick={() => apply(daysAgoYmd(6), ymd(new Date()))}>{t('近 7 天')}</button>
        <button className="ghost" onClick={() => apply(daysAgoYmd(29), ymd(new Date()))}>{t('近 30 天')}</button>
        <button className="primary" disabled={busy} onClick={() => void load(from, to)}>{t('查询')}</button>
        {/* 区间内没有任何调用时这行只剩一串 0，没有信息量，不显示 */}
        {(data?.range.calls ?? 0) > 0 && (
          <span className="usage-range-tip">
            {t('区间内 {a} token · {b} 次', { a: fmtTokens(data?.range.tokens), b: fmtNumber(data?.range.calls) })}
          </span>
        )}
      </div>

      <div className="usage-sec">
        <div className="usage-sec-title">{t('各模型用量')}</div>
        {(data?.models.length ?? 0) === 0 ? (
          <div className="plist-empty hint">{t('这个区间里还没有调用记录')}</div>
        ) : (
          <div className="ubars">
            {data!.models.map((m) => (
              <div className="ubar" key={m.label}>
                <span className="ubar-dot" style={{ background: colorOf(m.label, data!.models) }} />
                <span className="ubar-name" title={m.label}>{m.label}</span>
                <span className="ubar-track">
                  <i style={{ width: `${Math.max(2, (m.tokens / maxModel) * 100)}%`, background: colorOf(m.label, data!.models) }} />
                </span>
                <span className="ubar-val">
                  {fmtTokens(m.tokens)}
                  <em>{t('{n} 次', { n: fmtNumber(m.calls) })}</em>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="usage-sec">
        <div className="usage-sec-title">{t('用量趋势')}</div>
        {!data || data.models.length === 0 ? (
          <div className="plist-empty hint">{t('这个区间里还没有调用记录')}</div>
        ) : (
          <Trend series={data.series} />
        )}
      </div>
    </section>
  )
}

/** 条形图与折线图同色：同一个模型在哪儿都是同一个颜色，两处对照着看不用回头找名字 */
const LINE_COLORS = ['#2563eb', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d']

/** 模型 → 颜色：按当前排序取色（models 顺序变了颜色跟着换，但同一份数据内是一致的） */
function colorOf(label: string, models: LocalUsageRow[]): string {
  const i = models.findIndex((m) => m.label === label)
  return i >= 0 ? LINE_COLORS[i % LINE_COLORS.length] : 'var(--fg2)'
}

/** 一张口径卡：token 是主角，调用次数作副信息；没有调用时副行不显示（不摆一排 0） */
function UsageCard(p: { title: string; bucket?: LocalUsageBucket }) {
  return (
    <div className="ucard">
      <div className="ucard-k">{p.title}</div>
      <div className="ucard-v">{fmtTokens(p.bucket?.tokens)}</div>
      {(p.bucket?.calls ?? 0) > 0 && (
        <div className="ucard-s">
          {t('{a} 次调用', { a: fmtNumber(p.bucket?.calls) })}
        </div>
      )}
    </div>
  )
}

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
function Trend({ series }: { series: LocalUsageSeries }) {
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
        aria-label={t('各模型用量趋势')}
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

        {ticks.map((tk) => (
          <text key={tk.d} className="utrend-xtick" x={x(tk.i)} y={H - 8} textAnchor="middle">
            {tk.d.slice(5)}
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
          {total === 0 && <div className="utrend-tip-none">{t('这天没有调用')}</div>}
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
