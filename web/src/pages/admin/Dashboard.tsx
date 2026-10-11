import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/contexts/AppContext'
import { daysAgo, fmtNumber, fmtTokens, today } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Overview {
    members: number
    models: number
    enabled_models: number
    tokens: { today: number; yesterday: number; d30: number; total: number }
    points: { today: number; total: number }
    calls: { today: number; total: number }
}

interface Row {
    label: string
    sub: string | null
    calls: number
    tokens: number
    prompt_tokens: number
    completion_tokens: number
    points: number
}

interface Stats {
    from: string
    to: string
    group: 'day' | 'model' | 'member'
    rows: Row[]
}

const GROUPS: { key: Stats['group']; label: string; head: string }[] = [
    { key: 'day', label: '按天', head: '日期' },
    { key: 'model', label: '按模型', head: '模型' },
    { key: 'member', label: '按会员', head: '会员' },
]

/** 平台概览：Token Plan 的盘子——多少人、多少模型、烧了多少 token */
export default function Dashboard() {
    const { settings } = useApp()
    const [s, setS] = useState<Overview | null>(null)
    const [stats, setStats] = useState<Stats | null>(null)
    const [group, setGroup] = useState<Stats['group']>('day')
    const [from, setFrom] = useState(daysAgo(29))
    const [to, setTo] = useState(today())
    const [busy, setBusy] = useState(false)
    const [mail, setMail] = useState<{ mail_configured: boolean; mp_configured?: boolean } | null>(null)

    const loadStats = useCallback(async (g: Stats['group'], f: string, t: string) => {
        setBusy(true)
        try {
            setStats(await api<Stats>(`/admin/usage/stats?group=${g}&from=${f}&to=${t}`))
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setBusy(false)
        }
    }, [])

    useEffect(() => {
        api<Overview>('/admin/usage/overview').then(setS).catch(() => toast.error('概览加载失败'))
        api<{ mail_configured: boolean; mp_configured?: boolean }>('/admin/dashboard').then(setMail).catch(() => {})
    }, [])

    // 时间范围或分组变了就重新拉列表
    useEffect(() => { loadStats(group, from, to) }, [group, from, to, loadStats])

    const envCards = [
        { label: '邮件服务', value: mail?.mail_configured ? '已配置' : '未配置', sub: '注册与登录的验证码邮件依赖 SMTP 配置' },
        ...(settings.mp_visible
            ? [{ label: '微信小程序', value: mail?.mp_configured ? '已配置' : '未配置', sub: '在系统设置填写 AppID/AppSecret' }]
            : []),
    ]

    const current = GROUPS.find((g) => g.key === group)!

    // 后端 /admin/usage/stats 只回 {from,to,rows}，合计要自己从 rows 累加
    const totalCalls = stats?.rows.reduce((n, r) => n + (r.calls || 0), 0) ?? 0
    const totalTokens = stats?.rows.reduce((n, r) => n + (r.tokens || 0), 0) ?? 0
    const totalPoints = stats?.rows.reduce((n, r) => n + (r.points || 0), 0) ?? 0

    return (
        <div className="space-y-4">
            <h1 className="text-xl font-bold">平台概览</h1>

            {/* 会员 / 模型：Token Plan 的两个基本盘 */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card>
                    <CardHeader className="pb-1"><CardTitle className="text-sm font-normal text-muted-foreground">会员数</CardTitle></CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{fmtNumber(s?.members)}</div>
                        <div className="text-xs text-muted-foreground">不含管理员</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-1"><CardTitle className="text-sm font-normal text-muted-foreground">模型数</CardTitle></CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{fmtNumber(s?.models)}</div>
                        <div className="text-xs text-muted-foreground">启用 {fmtNumber(s?.enabled_models)} 个</div>
                    </CardContent>
                </Card>
                {envCards.map((c) => (
                    <Card key={c.label}>
                        <CardHeader className="pb-1"><CardTitle className="text-sm font-normal text-muted-foreground">{c.label}</CardTitle></CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{c.value}</div>
                            <div className="text-xs text-muted-foreground">{c.sub}</div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* token 总量：今日 / 昨日 / 最近 30 天 / 累计 */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">总 token 量</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                        {[
                            { label: '今日', v: s?.tokens.today, sub: `${fmtNumber(s?.calls.today)} 次调用` },
                            { label: '昨日', v: s?.tokens.yesterday, sub: '全天累计' },
                            { label: '最近 30 天', v: s?.tokens.d30, sub: '含今天' },
                            { label: '累计', v: s?.tokens.total, sub: `消耗积分 ${fmtNumber(s?.points.total)}` },
                        ].map((x) => (
                            <div key={x.label}>
                                <div className="text-xs text-muted-foreground">{x.label}</div>
                                <div className="text-xl font-bold">{fmtTokens(x.v)}</div>
                                <div className="text-xs text-muted-foreground">{x.sub}</div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* 明细：可选时间范围 + 按天/模型/会员三种口径 */}
            <Card>
                <CardHeader className="gap-3 pb-3">
                    <div className="flex flex-wrap items-center gap-2">
                        {GROUPS.map((g) => (
                            <Button
                                key={g.key}
                                size="sm"
                                variant={group === g.key ? 'default' : 'outline'}
                                onClick={() => setGroup(g.key)}
                            >
                                {g.label}
                            </Button>
                        ))}
                        <div className="ml-auto flex flex-wrap items-center gap-2">
                            <Input type="date" className="h-8 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                            <span className="text-xs text-muted-foreground">至</span>
                            <Input type="date" className="h-8 w-[150px]" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => loadStats(group, from, to)}>
                                <RefreshCw className={`mr-1 size-3.5 ${busy ? 'animate-spin' : ''}`} />刷新
                            </Button>
                        </div>
                    </div>
                    {stats && (
                        <div className="text-xs text-muted-foreground">
                            {stats.from} ~ {stats.to}：共 {fmtNumber(totalCalls)} 次调用、
                            {fmtTokens(totalTokens)} token、消耗积分 {fmtNumber(totalPoints)}
                        </div>
                    )}
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-[220px]">{current.head}</TableHead>
                                <TableHead className="w-[100px]">调用</TableHead>
                                <TableHead className="w-[110px]">输入</TableHead>
                                <TableHead className="w-[110px]">输出</TableHead>
                                <TableHead className="w-[120px]">合计 token</TableHead>
                                <TableHead>消耗积分</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {(!stats || stats.rows.length === 0) && (
                                <TableRow>
                                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                                        这段时间还没有用量记录
                                    </TableCell>
                                </TableRow>
                            )}
                            {stats?.rows.map((r, i) => (
                                <TableRow key={`${r.label}-${i}`}>
                                    <TableCell>
                                        <div className="text-sm">{r.label}</div>
                                        {r.sub ? <div className="text-xs text-muted-foreground">{r.sub}</div> : null}
                                    </TableCell>
                                    <TableCell className="text-sm">{fmtNumber(r.calls)}</TableCell>
                                    <TableCell className="text-sm text-muted-foreground">{r.prompt_tokens ? fmtTokens(r.prompt_tokens) : '—'}</TableCell>
                                    <TableCell className="text-sm text-muted-foreground">{r.completion_tokens ? fmtTokens(r.completion_tokens) : '—'}</TableCell>
                                    <TableCell className="text-sm font-medium">{fmtTokens(r.tokens)}</TableCell>
                                    <TableCell className="text-sm">{fmtNumber(r.points)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    )
}
