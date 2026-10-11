import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, Coins, Loader2, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtNumber, fmtTokens } from '@/lib/utils'
import MemberGrantDialog from '@/components/MemberGrantDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface PointRow {
    id: number
    change: number
    after: number
    type: string
    type_label: string
    remark: string
    operator: string | null
    created_at: string
}

interface UsageRow {
    id: number
    model: string
    ratio: number
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    points: number
    created_at: string
}

interface Detail {
    member: { id: number; name: string; email: string; role: string; points: number; status: string; created_at: string }
    stats: { tokens: number; used_points: number; calls: number }
    logs: PointRow[]
    usages: UsageRow[]
}

/**
 * 会员详情页：这个人是谁、还剩多少积分，以及他全部的账——积分记录与消耗记录。
 *
 * 两张表都由后端按 id 倒序取最近 100 条，前端不再分页（够用且省一次查询）。
 */
export default function MemberDetail() {
    const { id } = useParams()
    const nav = useNavigate()
    const [d, setD] = useState<Detail | null>(null)
    const [busy, setBusy] = useState(false)
    const [grant, setGrant] = useState(false)
    const [tab, setTab] = useState<'logs' | 'usages'>('logs')

    const load = useCallback(async () => {
        setBusy(true)
        try {
            setD(await api<Detail>(`/admin/members/${id}`))
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setBusy(false)
        }
    }, [id])

    useEffect(() => { load() }, [load])

    if (!d) {
        return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />加载中...</div>
    }

    const m = d.member

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => nav('/admin/members')}>
                    <ArrowLeft className="mr-1 size-4" />会员列表
                </Button>
                <h1 className="text-xl font-bold">{m.name}</h1>
                <span className="text-sm text-muted-foreground">{m.email}</span>
                {m.role === 'admin' && <Badge variant="info">管理员</Badge>}
                {m.status === 'active'
                    ? <Badge variant="success">正常</Badge>
                    : <Badge variant="secondary">{m.status}</Badge>}
                <div className="ml-auto flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={busy} onClick={load}>
                        <RefreshCw className={`mr-1 size-4 ${busy ? 'animate-spin' : ''}`} />刷新
                    </Button>
                    {/* 管理员不参与积分计费，后端会拒，这里直接不给入口 */}
                    {m.role !== 'admin' && (
                        <Button size="sm" onClick={() => setGrant(true)}>
                            <Coins className="mr-1 size-4" />赠送积分
                        </Button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                    { k: '当前积分', v: fmtNumber(m.points) },
                    { k: '累计 token', v: fmtTokens(d.stats.tokens) },
                    // 管理员不参与积分计费：账本里照记 token，但不产生扣分
                    { k: '累计消耗积分', v: m.role === 'admin' ? '不计费' : fmtNumber(d.stats.used_points) },
                    { k: '调用次数', v: fmtNumber(d.stats.calls) },
                ].map((x) => (
                    <Card key={x.k}>
                        <CardContent className="p-4">
                            <div className="text-xs text-muted-foreground">{x.k}</div>
                            <div className="mt-1 text-lg font-semibold">{x.v}</div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <p className="text-sm text-muted-foreground">
                注册于 {m.created_at} · 消耗积分 = 总 token 量 ÷ 1000 × 模型倍率（向上取整），由网关按上游回包的 usage 自动扣。
            </p>

            <Card>
                <CardContent className="p-0">
                    <div className="flex items-center gap-2 border-b p-3">
                        <Button size="sm" variant={tab === 'logs' ? 'default' : 'outline'} onClick={() => setTab('logs')}>
                            积分记录
                        </Button>
                        <Button size="sm" variant={tab === 'usages' ? 'default' : 'outline'} onClick={() => setTab('usages')}>
                            消耗记录
                        </Button>
                        <span className="ml-auto text-xs text-muted-foreground">各显示最近 100 条</span>
                    </div>

                    <Table>
                        <TableHeader>
                            {tab === 'logs' ? (
                                <TableRow>
                                    <TableHead className="w-[160px]">时间</TableHead>
                                    <TableHead className="w-[90px]">类型</TableHead>
                                    <TableHead className="w-[110px]">变动</TableHead>
                                    <TableHead className="w-[110px]">余额</TableHead>
                                    <TableHead>说明</TableHead>
                                </TableRow>
                            ) : (
                                <TableRow>
                                    <TableHead className="w-[160px]">时间</TableHead>
                                    <TableHead className="w-[200px]">模型</TableHead>
                                    <TableHead>输入 / 输出</TableHead>
                                    <TableHead className="w-[120px]">合计</TableHead>
                                    <TableHead className="w-[110px]">扣积分</TableHead>
                                </TableRow>
                            )}
                        </TableHeader>
                        <TableBody>
                            {tab === 'logs' && d.logs.length === 0 && (
                                <TableRow><TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">还没有积分变动</TableCell></TableRow>
                            )}
                            {tab === 'logs' && d.logs.map((l) => (
                                <TableRow key={l.id}>
                                    <TableCell className="text-xs text-muted-foreground">{l.created_at}</TableCell>
                                    <TableCell>
                                        {l.type === 'consume'
                                            ? <Badge variant="secondary">消耗</Badge>
                                            : l.change > 0 ? <Badge variant="success">发放</Badge> : <Badge variant="warning">调整</Badge>}
                                    </TableCell>
                                    <TableCell className={`font-mono text-sm ${l.change > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                                        {l.change > 0 ? '+' : ''}{fmtNumber(l.change)}
                                    </TableCell>
                                    <TableCell className="font-mono text-sm text-muted-foreground">{fmtNumber(l.after)}</TableCell>
                                    <TableCell className="text-xs">
                                        {l.remark}
                                        {l.operator ? <span className="ml-1 text-muted-foreground">（{l.operator}）</span> : null}
                                    </TableCell>
                                </TableRow>
                            ))}

                            {tab === 'usages' && d.usages.length === 0 && (
                                <TableRow><TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">还没有消耗记录</TableCell></TableRow>
                            )}
                            {tab === 'usages' && d.usages.map((u) => (
                                <TableRow key={u.id}>
                                    <TableCell className="text-xs text-muted-foreground">{u.created_at}</TableCell>
                                    <TableCell>
                                        <div className="font-mono text-xs">{u.model}</div>
                                        <div className="text-xs text-muted-foreground">{u.ratio} 倍</div>
                                    </TableCell>
                                    <TableCell className="text-xs text-muted-foreground">
                                        {fmtTokens(u.prompt_tokens)} / {fmtTokens(u.completion_tokens)}
                                    </TableCell>
                                    <TableCell className="text-sm">{fmtTokens(u.total_tokens)}</TableCell>
                                    <TableCell className="text-sm">{fmtNumber(u.points)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <MemberGrantDialog member={grant ? m : null} onClose={() => setGrant(false)} onDone={load} />
        </div>
    )
}
