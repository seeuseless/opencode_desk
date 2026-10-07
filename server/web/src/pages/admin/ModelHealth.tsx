import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, daysAgo, fmtNumber, today } from '@/lib/utils'
import { AiStatusBadge } from '@/components/AiStatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Stat {
    total: number
    ok: number
    rate: number | null
    avg_latency: number | null
}

interface LiveModel {
    id: number
    name: string
    providers: number
    upstreams: string[]
    status: string
    latency_ms: number | null
    last_error: string | null
    checked_at: string | null
    recent: Stat
}

/** 实时状态：采集器每 interval 秒探一轮（每个上游一个请求，同上游多模型轮换） */
interface Summary {
    interval: number
    /** 模型状态超过这么久没新记录就算未知（轮换让探测间隔不均，后端按同上游模型数放宽） */
    stale_after: number
    /** 「当下」稳定率的统计窗口（秒） */
    window: number
    running: boolean
    last_checked_at: string | null
    models: LiveModel[]
}

/** 时间轴一个格子：[桶起点(unix 秒), 探测次数, 成功次数, 平均延迟] */
type Cell = [number, number, number, number | null]

interface DayRow {
    date: string
    total: number
    ok: number
    rate: number | null
    avg_latency: number | null
}

interface SeriesModel {
    id: number
    name: string
    summary: Stat
    cells?: Cell[]
    days?: DayRow[]
}

interface Series {
    mode: 'timeline' | 'daily'
    from: string
    to: string
    bucket_seconds?: number
    dates?: string[]
    models: SeriesModel[]
}

type RangeKey = '1h' | '24h' | 'today' | 'yesterday' | 'custom'

const RANGES: { key: RangeKey; label: string }[] = [
    { key: '1h', label: '最近 1 小时' },
    { key: '24h', label: '最近 24 小时' },
    { key: 'today', label: '今天' },
    { key: 'yesterday', label: '昨天' },
    { key: 'custom', label: '自定义' },
]

const LEGEND = [
    { label: '全部成功', cls: 'bg-emerald-500' },
    { label: '有失败', cls: 'bg-amber-400' },
    { label: '全部失败', cls: 'bg-red-500' },
    { label: '无数据', cls: 'bg-muted' },
]

/**
 * 快捷区间 → 接口参数：相对区间（最近 N 小时）给绝对时刻，
 * 整日区间给 YYYY-MM-DD，由后端按站点时区取整日——两边都不做时区换算，免得错开 8 小时。
 */
function rangeParams(key: RangeKey, from: string, to: string) {
    const now = new Date()
    if (key === '1h') return { from: new Date(now.getTime() - 3600_000).toISOString(), to: now.toISOString() }
    if (key === '24h') return { from: new Date(now.getTime() - 24 * 3600_000).toISOString(), to: now.toISOString() }
    if (key === 'today') return { from: today(), to: today() }
    if (key === 'yesterday') return { from: daysAgo(1), to: daysAgo(1) }

    return { from, to }
}

/** 稳定率配色：几乎全绿、有波动的黄、大面积失败的标红；没有数据用灰色 */
function rateTone(rate: number | null) {
    if (rate === null) return 'text-muted-foreground'
    if (rate >= 99.9) return 'text-emerald-600'
    if (rate >= 90) return 'text-amber-600'

    return 'text-red-600'
}

function rateText(rate: number | null) {
    return rate === null ? '—' : `${rate.toFixed(rate >= 99 ? 1 : 2)}%`
}

/** 时间轴一格：整桶全成功绿、全失败红、有波动黄、没记录灰 */
function cellTone(ok: number, total: number) {
    if (total === 0) return 'bg-muted'
    if (ok === 0) return 'bg-red-500'

    return ok === total ? 'bg-emerald-500' : 'bg-amber-400'
}

/** 桶起点（unix 秒）→ 本机时区的 HH:MM */
function clock(ts: number) {
    const d = new Date(ts * 1000)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 后端给的是站点时区的 Y-m-d H:i:s，直接截取时分秒，别再让 Date 解析一遍 */
function shortTime(v: string | null) {
    return v ? v.slice(11) : '—'
}

function bucketLabel(seconds?: number) {
    if (!seconds) return ''
    if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
    if (seconds % 60 === 0) return `${seconds / 60} 分钟`

    return `${seconds} 秒`
}

/**
 * 模型概况（Token Plan → 概况）：采集器 ai:health 的结果视图。
 *
 * 上半屏是「当下」：每个启用模型的最新状态，跟采集器同一个节拍，每 10 秒自动刷一次；
 * 下半屏是「历史」：跨度一天以内看时间轴（一格一段时间，一眼看出哪里断过），
 * 超过一天就换成每天的稳定百分比——一天一个数，比逐秒明细更适合看趋势。
 *
 * 注意采集器每轮每个上游只探一个模型（同上游多模型轮换），所以「最近探测」各不相同是正常的。
 */
export default function ModelHealth() {
    const [live, setLive] = useState<Summary | null>(null)
    const [series, setSeries] = useState<Series | null>(null)
    const [range, setRange] = useState<RangeKey>('24h')
    const [from, setFrom] = useState(daysAgo(6))
    const [to, setTo] = useState(today())
    const [busy, setBusy] = useState(false)

    const params = useMemo(() => rangeParams(range, from, to), [range, from, to])

    const loadSeries = useCallback(async () => {
        setBusy(true)
        try {
            setSeries(await api<Series>(`/admin/ai-models/health/series?from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`))
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setBusy(false)
        }
    }, [params])

    // 实时状态：10 秒一轮，跟采集器同节拍
    useEffect(() => {
        let alive = true
        const pull = () =>
            api<Summary>('/admin/ai-models/health')
                .then((d) => { if (alive) setLive(d) })
                .catch(() => {})
        pull()
        const timer = setInterval(pull, 10000)

        return () => { alive = false; clearInterval(timer) }
    }, [])

    // 历史：范围一变就重取，另外每分钟跟一次（不必跟着 10 秒跳）
    useEffect(() => { loadSeries() }, [loadSeries])
    useEffect(() => {
        const timer = setInterval(loadSeries, 60000)

        return () => clearInterval(timer)
    }, [loadSeries])

    // 按天视图：把「模型 × 日期」摊平成一张查表，格子里不至于每次都去 find
    const dayMap = useMemo(() => {
        const map = new Map<string, DayRow>()
        series?.models.forEach((m) => m.days?.forEach((d) => map.set(`${m.id}|${d.date}`, d)))

        return map
    }, [series])

    const daySummary = (date: string): Stat => {
        let total = 0
        let ok = 0
        series?.models.forEach((m) => {
            const row = dayMap.get(`${m.id}|${date}`)
            if (row) { total += row.total; ok += row.ok }
        })

        return { total, ok, rate: total > 0 ? (ok / total) * 100 : null, avg_latency: null }
    }

    const daily = series?.mode === 'daily'
    const cells = series?.models[0]?.cells?.length ?? 0

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-xl font-bold">模型概况</h1>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className={cn('inline-block size-2 rounded-full', live?.running ? 'bg-emerald-500' : 'bg-red-500')} />
                    {live?.running ? `采集中（每 ${live.interval} 秒一轮）` : '采集器未运行'}
                    {live?.last_checked_at ? ` · 最后一条 ${shortTime(live.last_checked_at)}` : ''}
                </div>
            </div>

            {/* 采集器没跑的话，页面上的数字永远是旧的，先提醒一声 */}
            {live && !live.running && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div className="space-y-1">
                        <div>采集器没有在跑，下面看到的都是旧数据。在服务器上二选一启动：</div>
                        <div>
                            <code className="rounded bg-amber-100 px-1">php artisan ai:health</code> 常驻采集（推荐，自带 10 秒节拍）；
                            或 <code className="rounded bg-amber-100 px-1">php artisan schedule:work</code> 交给调度器。
                        </div>
                    </div>
                </div>
            )}

            {/* 当下：每个启用模型的最新状态 */}
            {live?.models.length === 0 && (
                <Card>
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                        还没有启用的模型。先在「模型」里启用模型，再到「上游」里同步同名模型。
                    </CardContent>
                </Card>
            )}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {live?.models.map((m) => (
                    <Card key={m.id}>
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center justify-between gap-2 text-sm">
                                <span className="truncate font-mono">{m.name}</span>
                                <AiStatusBadge status={m.status} latency={m.latency_ms} />
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-1 text-xs">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">近 {bucketLabel(live?.window ?? 300)}稳定率</span>
                                <span className={cn('font-medium', rateTone(m.recent.rate))}>
                                    {rateText(m.recent.rate)}
                                    <span className="ml-1 font-normal text-muted-foreground">（{m.recent.ok}/{m.recent.total}）</span>
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">平均延迟</span>
                                <span>{m.recent.avg_latency ? `${m.recent.avg_latency}ms` : '—'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">最近探测</span>
                                <span>{shortTime(m.checked_at)}</span>
                            </div>
                            <div className="truncate text-muted-foreground" title={m.upstreams.join('、')}>
                                {m.providers > 0 ? `上游：${m.upstreams.join('、')}` : '没有上游供货这个模型名'}
                            </div>
                            {m.last_error ? (
                                <div className="line-clamp-2 text-red-600" title={m.last_error}>{m.last_error}</div>
                            ) : null}
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* 历史：≤1 天看时间轴，>1 天看每天的稳定百分比 */}
            <Card>
                <CardHeader className="gap-3 pb-3">
                    <div className="flex flex-wrap items-center gap-2">
                        {RANGES.map((r) => (
                            <Button key={r.key} size="sm" variant={range === r.key ? 'default' : 'outline'} onClick={() => setRange(r.key)}>
                                {r.label}
                            </Button>
                        ))}
                        {range === 'custom' && (
                            <>
                                <Input type="date" className="h-8 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                                <span className="text-xs text-muted-foreground">至</span>
                                <Input type="date" className="h-8 w-[150px]" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
                            </>
                        )}
                        <Button variant="outline" size="sm" className="ml-auto" disabled={busy} onClick={loadSeries}>
                            <RefreshCw className={cn('mr-1 size-3.5', busy && 'animate-spin')} />刷新
                        </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {series && (
                            <span>
                                {series.from} ~ {series.to} · {daily ? `按天看稳定百分比（> 1 天）` : `时间轴每格 ${bucketLabel(series.bucket_seconds)}，共 ${cells} 格`}
                            </span>
                        )}
                        <span className="flex items-center gap-3">
                            {LEGEND.map((l) => (
                                <span key={l.label} className="flex items-center gap-1">
                                    <span className={cn('inline-block size-2.5 rounded-sm', l.cls)} />
                                    {l.label}
                                </span>
                            ))}
                        </span>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {series && series.models.length === 0 ? (
                        <div className="py-10 text-center text-sm text-muted-foreground">还没有启用的模型</div>
                    ) : daily ? (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-[120px]">日期</TableHead>
                                    {series?.models.map((m) => (
                                        <TableHead key={m.id} className="text-right font-mono text-xs">{m.name}</TableHead>
                                    ))}
                                    <TableHead className="w-[90px] text-right">总体</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {series?.dates?.map((date) => {
                                    const all = daySummary(date)

                                    return (
                                        <TableRow key={date}>
                                            <TableCell className="text-sm">{date}</TableCell>
                                            {series.models.map((m) => {
                                                const row = dayMap.get(`${m.id}|${date}`)

                                                return (
                                                    <TableCell
                                                        key={m.id}
                                                        className={cn('text-right text-sm', rateTone(row?.rate ?? null))}
                                                        title={row ? `${row.total} 次探测，成功 ${row.ok} 次${row.avg_latency ? `，平均 ${row.avg_latency}ms` : ''}` : '这天没有采集记录'}
                                                    >
                                                        {rateText(row?.rate ?? null)}
                                                    </TableCell>
                                                )
                                            })}
                                            <TableCell className={cn('text-right text-sm font-medium', rateTone(all.rate))}>{rateText(all.rate)}</TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-[200px]">模型</TableHead>
                                    <TableHead className="w-[100px]">稳定率</TableHead>
                                    <TableHead className="w-[110px]">平均延迟</TableHead>
                                    <TableHead className="w-[110px]">探测次数</TableHead>
                                    <TableHead>时间轴</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {series?.models.map((m) => (
                                    <TableRow key={m.id}>
                                        <TableCell className="font-mono text-sm">{m.name}</TableCell>
                                        <TableCell className={cn('text-sm font-medium', rateTone(m.summary.rate))}>{rateText(m.summary.rate)}</TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {m.summary.avg_latency ? `${m.summary.avg_latency}ms` : '—'}
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">{fmtNumber(m.summary.total)}</TableCell>
                                        <TableCell>
                                            {m.summary.total === 0 ? (
                                                <span className="text-xs text-muted-foreground">这段时间没有采集记录</span>
                                            ) : (
                                                <div>
                                                    <div className="flex h-5 overflow-hidden rounded-sm">
                                                        {m.cells?.map(([ts, total, ok, latency]) => (
                                                            <div
                                                                key={ts}
                                                                className={cn('flex-1', cellTone(ok, total))}
                                                                title={`${clock(ts)} 稳定 ${rateText(total > 0 ? (ok / total) * 100 : null)}（${ok}/${total}）${latency ? ` · 平均 ${latency}ms` : ''}`}
                                                            />
                                                        ))}
                                                    </div>
                                                    <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
                                                        <span>{clock(m.cells?.[0]?.[0] ?? 0)}</span>
                                                        <span>{clock(m.cells?.[m.cells.length - 1]?.[0] ?? 0)}</span>
                                                    </div>
                                                </div>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground">
                采集器每 10 秒一轮，<b>每轮每个上游只探一个模型</b>（同上游的多个模型轮换，避免并发撞上游限流），
                所以各模型的「最近探测」时间会错开、时间轴上也会有空格，都是正常的。
                表格里超过一天的口径取「每天的稳定百分比」，一天以内则展示逐格时间轴。
                原始记录只保留最近几天（<code className="rounded bg-muted px-1">AI_HEALTH_KEEP_DAYS</code>），
                按天累计的百分比永久保留。
            </p>
        </div>
    )
}
