import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Coins, RefreshCw, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtNumber, fmtTokens } from '@/lib/utils'
import MemberGrantDialog from '@/components/MemberGrantDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Member {
    id: number
    name: string
    email: string
    role: string
    points: number
    status: string
    tokens: number
    used_points: number
    created_at: string
}

/**
 * Token Plan · 会员：列表只做「看人 + 赠送积分」，账目一律进详情页。
 *
 * 积分规则是「模型倍率 × token 量」，后台的人工操作只有赠送（差额自动进流水）。
 */
export default function Members() {
    const [list, setList] = useState<Member[]>([])
    const [total, setTotal] = useState(0)
    const [q, setQ] = useState('')
    const [busy, setBusy] = useState(false)
    const [grant, setGrant] = useState<Member | null>(null)

    const load = useCallback(async (keyword = '') => {
        setBusy(true)
        try {
            const r = await api<{ total: number; items: Member[] }>(`/admin/members?q=${encodeURIComponent(keyword)}`)
            setList(r.items)
            setTotal(r.total)
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setBusy(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-xl font-bold">会员</h1>
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            className="h-9 w-[220px] pl-8"
                            placeholder="邮箱 / 昵称"
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') load(q) }}
                        />
                    </div>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => load(q)}>
                        <RefreshCw className={`mr-1 size-4 ${busy ? 'animate-spin' : ''}`} />刷新
                    </Button>
                </div>
            </div>

            <p className="text-sm text-muted-foreground">
                消耗积分 = 总 token 量 ÷ 1000 × 模型倍率（向上取整），由网关按上游回包的 usage 自动扣。
                点会员名进详情看积分记录与消耗记录。
            </p>

            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>会员</TableHead>
                                <TableHead className="w-[120px]">积分</TableHead>
                                <TableHead className="w-[120px]">累计 token</TableHead>
                                <TableHead className="w-[130px]">累计消耗积分</TableHead>
                                <TableHead className="w-[100px]">状态</TableHead>
                                <TableHead className="w-[150px]">注册时间</TableHead>
                                <TableHead className="w-[140px]">操作</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {list.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                                        还没有账号（共 {total} 条）
                                    </TableCell>
                                </TableRow>
                            )}
                            {list.map((m) => (
                                <TableRow key={m.id}>
                                    <TableCell>
                                        <div className="flex items-center gap-1.5">
                                            <Link to={`/admin/members/${m.id}`} className="text-sm font-medium hover:underline">
                                                {m.name}
                                            </Link>
                                            {/* 管理员也在列表里：他们照样用内置模型跑 token，只是不参与积分计费 */}
                                            {m.role === 'admin' && <Badge variant="info">管理员</Badge>}
                                        </div>
                                        <div className="text-xs text-muted-foreground">{m.email}</div>
                                    </TableCell>
                                    <TableCell>
                                        <span className="font-mono text-sm font-semibold">{fmtNumber(m.points)}</span>
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">{fmtTokens(m.tokens)}</TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {m.role === 'admin' ? '不计费' : fmtNumber(m.used_points)}
                                    </TableCell>
                                    <TableCell>
                                        {m.status === 'active'
                                            ? <Badge variant="success">正常</Badge>
                                            : <Badge variant="secondary">{m.status}</Badge>}
                                    </TableCell>
                                    <TableCell className="text-xs text-muted-foreground">{m.created_at}</TableCell>
                                    <TableCell>
                                        {m.role === 'admin' ? (
                                            <span className="text-xs text-muted-foreground">不参与积分计费</span>
                                        ) : (
                                            <Button variant="ghost" size="sm" onClick={() => setGrant(m)}>
                                                <Coins className="mr-1 size-3.5" />赠送积分
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <MemberGrantDialog member={grant} onClose={() => setGrant(null)} onDone={() => load(q)} />
        </div>
    )
}
