import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, daysAgo, fmtNumber, today } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/**
 * 模型概况（Token Plan → 概况）——消费 Go 服务端的真实口径。
 *
 * 数据来源：qn-server 内置采集器（10 秒节拍）写 ai_model_health_days，**只有按天粒度**，
 * 所以这里没有 Laravel 版的「小时级时间轴」和「采集器实时状态」，只有：
 *   · 区间内每个模型的探测汇总（总次数 / 成功 / 稳定率 / 提供上游）
 *   · 按天稳定率矩阵：行是模型、列是日期，一眼看出哪天开始波动
 */

/** 某模型在某天的探测汇总（rate 0~1） */
interface DayPoint {
    day: string
    total: number
    ok: number
    rate: number
}

/** 一个模型的区间汇总 + 按天明细 */
interface ModelSeries {
    model_id: number
    model: string
    total: number
    ok: number
    rate: number
    upstreams: string[]
    days: DayPoint[]
}

interface SeriesResp {
    from: string
    to: string
    dates: string[]
    rows: ModelSeries[]
}

/** 稳定率配色：几乎全绿、有波动的黄、大面积失败的标红；没有数据用灰色 */
function rateTone(rate: number | null) {
    if (rate === null) return 'text-muted-foreground'
    if (rate >= 0.999) return 'text-emerald-600'
    if (rate >= 0.9) return 'text-amber-600'

    return 'text-red-600'
}

function rateText(rate: number | null) {
    return rate === null ? '—' : `${(rate * 100).toFixed(rate >= 0.99 ? 1 : 2)}%`
}

/** 矩阵一格底色：整格按当天的 ok/total 配色，没记录灰 */
function cellTone(ok: number, total: number) {
    if (total === 0) return 'bg-muted'
    if (ok === 0) return 'bg-red-500'

    return ok === total ? 'bg-emerald-500' : 'bg-amber-400'
}

export default function ModelHealth() {
    const [series, setSeries] = useState<SeriesResp | null>(null)
    const [from, setFrom] = useState(daysAgo(6))
    const [to, setTo] = useState(today())
    const [busy, setBusy] = useState(false)

    const loadSeries = useCallback(async (f: string, t: string) => {
        setBusy(true)
        try {
            setSeries(await api<SeriesResp>(`/admin/ai-models/health/series?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`))
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setBusy(false)
        }
    }, [])

    useEffect(() => { loadSeries(from, to) }, [loadSeries, from, to])

    // 按天查表：model_id|day → DayPoint，矩阵渲染时免去每格 find
    const dayMap = useMemo(() => {
        const map = new Map<string, DayPoint>()
        for (const m of series?.rows ?? []) {
            for (const d of m.days ?? []) map.set(`${m.model_id}|${d.day}`, d)
        }

        return map
    }, [series])

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-xl font-bold">模型概况</h1>
                <div className="flex flex-wrap items-center gap-2">
                    <Input type="date" className="h-8 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                    <span className="text-xs text-muted-foreground">至</span>
                    <Input type="date" className="h-8 w-[150px]" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => loadSeries(from, to)}>
                        <RefreshCw className={`mr-1 size-3.5 ${busy ? 'animate-spin' : ''}`} />刷新
                    </Button>
                </div>
            </div>

            {series && series.rows.length === 0 && (
                <Card>
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                        这段时间还没有探测记录。确认上游已启用、模型已匹配到模型库，采集器每 10 秒会自动探测。
                    </CardContent>
                </Card>
            )}

            {/* 区间汇总：每个模型的盘子 */}
            {series && series.rows.length > 0 && (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">
                            {series.from} ~ {series.to} 汇总
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-[200px]">模型</TableHead>
                                    <TableHead>提供上游</TableHead>
                                    <TableHead className="w-[100px]">探测次数</TableHead>
                                    <TableHead className="w-[100px]">成功</TableHead>
                                    <TableHead className="w-[110px]">稳定率</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {series.rows.map((m) => (
                                    <TableRow key={m.model_id}>
                                        <TableCell className="text-sm font-medium">{m.model}</TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {(m.upstreams ?? []).length > 0 ? m.upstreams.join('、') : '—'}
                                        </TableCell>
                                        <TableCell className="text-sm">{fmtNumber(m.total)}</TableCell>
                                        <TableCell className="text-sm">{fmtNumber(m.ok)}</TableCell>
                                        <TableCell className={cn('text-sm font-medium', rateTone(m.total > 0 ? m.rate : null))}>
                                            {rateText(m.total > 0 ? m.rate : null)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {/* 按天矩阵：行是模型、列是日期，哪天开始波动一眼可见 */}
            {series && series.rows.length > 0 && (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">按天稳定率</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <table className="w-full border-separate border-spacing-y-1 text-sm">
                                <thead>
                                    <tr>
                                        <th className="sticky left-0 z-10 bg-card px-2 text-left font-normal text-muted-foreground">模型</th>
                                        {series.dates.map((d) => (
                                            <th key={d} className="px-0.5 text-center text-[10px] font-normal text-muted-foreground">
                                                {d.slice(5)}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {series.rows.map((m) => (
                                        <tr key={m.model_id}>
                                            <td className="sticky left-0 z-10 bg-card px-2 text-sm">{m.model}</td>
                                            {series.dates.map((d) => {
                                                const p = dayMap.get(`${m.model_id}|${d}`)
                                                return (
                                                    <td key={d} className="px-0.5">
                                                        <div
                                                            title={`${d}：${p ? `${p.ok}/${p.total}` : '无记录'}`}
                                                            className={cn('h-5 min-w-5 rounded-sm', cellTone(p?.ok ?? 0, p?.total ?? 0))}
                                                        />
                                                    </td>
                                                )
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-emerald-500" />全部成功</span>
                            <span className="flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-amber-400" />有失败</span>
                            <span className="flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-red-500" />全部失败</span>
                            <span className="flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-muted" />无记录</span>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
