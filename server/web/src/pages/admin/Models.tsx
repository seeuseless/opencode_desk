import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FlaskConical, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtTime } from '@/lib/utils'
import { confirmDialog } from '@/lib/confirm'
import { AiStatusBadge } from '@/components/AiStatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/** 能提供该模型的上游（同名匹配上的记录） */
interface Provider {
    id: number
    upstream_id: number
    upstream_name: string | null
    upstream_enabled: boolean
    model: string
    enabled: boolean
    status: string
    latency_ms: number | null
    last_checked_at: string | null
    last_error: string | null
}

interface Model {
    id: number
    name: string
    builtin: boolean
    ratio: number
    free: boolean
    discount: number | null
    discount_label: string | null
    effective_ratio: number
    enabled: boolean
    sort: number
    remark: string | null
    status: string
    upstream_names: string[]
    providers: Provider[]
}

/** discount 在表单里保持字符串：空串 = 不打折，避免 0 和「没填」混在一起 */
const emptyForm = { name: '', builtin: false, ratio: 1, free: false, discount: '', enabled: true, sort: 0, remark: '' }

/**
 * 模型（一级菜单）：平台对外提供的模型名清单。
 *
 * 这里只管「名字」这一层——模型名就是客户端选到的 ID，如 deepseek-v4-flash。
 * 能不能真的用，取决于「上游」菜单里有没有自动获取到同名模型（匹配上即供货）。
 * 一个模型名可以被多个上游同时提供，网关会自动在它们之间轮换与故障转移。
 */
export default function Models() {
    const [list, setList] = useState<Model[]>([])
    const [busy, setBusy] = useState<Record<string, boolean>>({})
    const [open, setOpen] = useState(false)
    const [editing, setEditing] = useState<Model | null>(null)
    const [form, setForm] = useState(emptyForm)
    const [saving, setSaving] = useState(false)

    const load = () => api<Model[]>('/admin/ai-models/models').then(setList).catch((e) => toast.error((e as Error).message))
    useEffect(() => { load() }, [])

    const run = async (tag: string, fn: () => Promise<void>) => {
        setBusy((b) => ({ ...b, [tag]: true }))
        try { await fn() } finally { setBusy((b) => ({ ...b, [tag]: false })) }
    }

    const openNew = () => { setEditing(null); setForm(emptyForm); setOpen(true) }
    const openEdit = (m: Model) => {
        setEditing(m)
        setForm({
            name: m.name, builtin: m.builtin, ratio: m.ratio,
            free: m.free, discount: m.discount === null ? '' : String(m.discount),
            enabled: m.enabled, sort: m.sort, remark: m.remark || '',
        })
        setOpen(true)
    }

    const save = async () => {
        if (!form.name.trim()) { toast.error('请填写模型名'); return }
        const d = form.discount.trim()
        if (d !== '' && (Number(d) < 0.01 || Number(d) > 0.99)) { toast.error('折扣只能填 0.01 – 0.99'); return }
        setSaving(true)
        try {
            const body = JSON.stringify({
                ...form,
                name: form.name.trim(),
                ratio: Number(form.ratio),
                // 空串 = 清空折扣（后端用 null 表示不打折）
                discount: d === '' ? null : Number(d),
            })
            if (editing) await api(`/admin/ai-models/models/${editing.id}`, { method: 'PUT', body })
            else await api('/admin/ai-models/models', { method: 'POST', body })
            toast.success('已保存')
            setOpen(false)
            load()
        } catch (e) { toast.error((e as Error).message) } finally { setSaving(false) }
    }

    const toggle = async (m: Model, enabled: boolean) => {
        try { await api(`/admin/ai-models/models/${m.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }); load() } catch (e) { toast.error((e as Error).message) }
    }

    /** 限免开关：直接改，不用进弹窗——活动时开开关关很频繁 */
    const toggleFree = async (m: Model, free: boolean) => {
        try {
            await api(`/admin/ai-models/models/${m.id}`, { method: 'PUT', body: JSON.stringify({ free }) })
            toast.success(free ? `「${m.name}」已限免，调用不再扣积分` : `「${m.name}」已恢复计费`)
            load()
        } catch (e) { toast.error((e as Error).message) }
    }

    const remove = async (m: Model) => {
        if (!(await confirmDialog(`删除模型「${m.name}」？上游那边的同名匹配会自动解绑。`))) return
        try { await api(`/admin/ai-models/models/${m.id}`, { method: 'DELETE' }); toast.success('已删除'); load() } catch (e) { toast.error((e as Error).message) }
    }

    /** 真实调用：走网关同一条候选链，发一条最小对话 */
    const test = (m: Model) =>
        run(`t-${m.id}`, async () => {
            try {
                const r = await api<{ ok: boolean; error: string | null; reply: string | null; via: { upstream: string | null; model: string } }>(`/admin/ai-models/models/${m.id}/test`, { method: 'POST' })
                if (r.ok) toast.success(`调用成功：${r.via?.upstream} → ${r.via?.model}`, { description: r.reply ? `模型回包：${r.reply}` : '' })
                else toast.error('调用失败', { description: r.error || '' })
                load()
            } catch (e) { toast.error((e as Error).message) }
        })

    /** 重新认领一遍上游里的同名模型（批量改过名字之后用） */
    const reMatch = () =>
        run('match', async () => {
            try {
                const r = await api<{ bound: number }>('/admin/ai-models/re-match', { method: 'POST' })
                toast.success(r.bound > 0 ? `已匹配 ${r.bound} 条上游模型` : '没有新的可匹配模型')
                load()
            } catch (e) { toast.error((e as Error).message) }
        })

    const unmatched = list.filter((m) => m.status === 'unmatched').length

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold">模型</h1>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={busy.match} onClick={reMatch}>
                        <RefreshCw className={`mr-1 size-4 ${busy.match ? 'animate-spin' : ''}`} />重新匹配
                    </Button>
                    <Button size="sm" onClick={openNew}><Plus className="mr-1 size-4" />新增模型</Button>
                </div>
            </div>

            <p className="text-sm text-muted-foreground">
                模型名就是客户端选到的模型 ID（如 <code className="rounded bg-muted px-1">deepseek-v4-flash</code>）。
                它自己不绑定上游：去「上游」里点<b>自动获取模型</b>，拉回来的模型名与这里的名字相同即自动匹配，
                该上游就成为这个模型的供货方。同名模型可被多个上游提供，网关自动轮换与故障转移。
            </p>

            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-[220px]">模型名</TableHead>
                                <TableHead>上游</TableHead>
                                <TableHead className="w-[110px]">状态</TableHead>
                                <TableHead className="w-[80px]">内置</TableHead>
                                <TableHead className="w-[110px]">消耗比例</TableHead>
                                <TableHead className="w-[90px]">折扣</TableHead>
                                <TableHead className="w-[80px]">限免</TableHead>
                                <TableHead className="w-[70px]">排序</TableHead>
                                <TableHead className="w-[80px]">启用</TableHead>
                                <TableHead className="w-[190px]">操作</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {list.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                                        还没有模型，先新增一个模型名。
                                    </TableCell>
                                </TableRow>
                            )}
                            {list.map((m) => (
                                <TableRow key={m.id}>
                                    <TableCell>
                                        <div className="font-mono text-sm font-medium">{m.name}</div>
                                        {m.remark ? <div className="text-xs text-muted-foreground">{m.remark}</div> : null}
                                    </TableCell>
                                    <TableCell>
                                        {m.upstream_names.length === 0 ? (
                                            <span className="text-xs text-muted-foreground">— 去「上游」同步同名模型</span>
                                        ) : (
                                            <span className="flex flex-wrap items-center gap-1">
                                                {m.upstream_names.map((n) => (
                                                    <Badge key={n} variant="outline" className="font-normal">{n}</Badge>
                                                ))}
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell><AiStatusBadge status={m.status} /></TableCell>
                                    <TableCell>
                                        {/* 「内置」是一列是否判断：是＝平台官方提供，否＝第三方接入 */}
                                        {m.builtin
                                            ? <Badge variant="info">是</Badge>
                                            : <span className="text-sm text-muted-foreground">否</span>}
                                    </TableCell>
                                    <TableCell className="text-sm">
                                        <div>{m.ratio} 倍</div>
                                        {/* 实扣倍率与标价不同时才补一行，避免每天看重复数字 */}
                                        {m.effective_ratio !== m.ratio && (
                                            <div className="text-xs text-muted-foreground">实扣 {m.effective_ratio} 倍</div>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        {m.discount_label
                                            ? <Badge variant="warning">{m.discount_label}</Badge>
                                            : <span className="text-xs text-muted-foreground">—</span>}
                                    </TableCell>
                                    <TableCell>
                                        <Switch checked={m.free} onCheckedChange={(v) => toggleFree(m, v)} />
                                    </TableCell>
                                    <TableCell className="font-mono text-sm text-muted-foreground">{m.sort}</TableCell>
                                    <TableCell>
                                        <Switch checked={m.enabled} onCheckedChange={(v) => toggle(m, v)} />
                                    </TableCell>
                                    <TableCell>
                                        <Button variant="ghost" size="sm" disabled={busy[`t-${m.id}`] || !m.providers.length} onClick={() => test(m)}>
                                            <FlaskConical className="mr-1 size-3.5" />测试
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={() => openEdit(m)}><Pencil className="size-3.5" /></Button>
                                        <Button variant="ghost" size="icon" onClick={() => remove(m)}><Trash2 className="size-3.5" /></Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <div className="text-xs text-muted-foreground">
                共 {list.length} 个模型{unmatched > 0 ? `，其中 ${unmatched} 个还没有上游提供（状态：未匹配）` : ''}。
                客户端通过 <code className="rounded bg-muted px-1">/api/ide/v1</code> 拉到的就是这个清单（仅含启用且有上游的）。
            </div>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogHeader><DialogTitle>{editing ? '编辑模型' : '新增模型'}</DialogTitle></DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <Label>模型名</Label>
                            <Input
                                className="font-mono"
                                placeholder="deepseek-v4-flash"
                                value={form.name}
                                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                            />
                            <p className="text-xs text-muted-foreground">
                                必须与上游返回的模型标识完全一致（区分大小写）才能匹配上；客户端选到的也是这个名字。
                            </p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <Label>消耗比例（倍）</Label>
                                <Input
                                    type="number" min={0} step={0.1}
                                    value={form.ratio}
                                    onChange={(e) => setForm((f) => ({ ...f, ratio: Number(e.target.value) }))}
                                />
                                <p className="text-xs text-muted-foreground">1 表示 1 倍。</p>
                            </div>
                            <div className="space-y-1">
                                <Label>折扣</Label>
                                <Input
                                    type="number" min={0.01} max={0.99} step={0.01}
                                    placeholder="不打折留空"
                                    value={form.discount}
                                    onChange={(e) => setForm((f) => ({ ...f, discount: e.target.value }))}
                                />
                                <p className="text-xs text-muted-foreground">
                                    填 0.01 – 0.99，显示成 <code className="rounded bg-muted px-1">0.2x</code>；
                                    实际扣分 = 消耗比例 × 折扣，留空表示不打折。
                                </p>
                            </div>
                        </div>
                        <div className="space-y-1">
                            <Label>排序</Label>
                            <Input type="number" value={form.sort} onChange={(e) => setForm((f) => ({ ...f, sort: Number(e.target.value) }))} />
                            <p className="text-xs text-muted-foreground">越大越靠前。</p>
                        </div>
                        <div className="space-y-1">
                            <Label>备注</Label>
                            <Input value={form.remark} onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))} />
                        </div>
                        <div className="flex items-center gap-2">
                            <Switch checked={form.free} onCheckedChange={(v) => setForm((f) => ({ ...f, free: v }))} />
                            <span className="text-sm">限时免费（开启后调用不扣积分，折扣同时失效）</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Switch checked={form.builtin} onCheckedChange={(v) => setForm((f) => ({ ...f, builtin: v }))} />
                            <span className="text-sm">内置模型（平台官方提供）</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
                            <span className="text-sm">启用（停用后不出现在客户端模型列表）</span>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
                        <Button onClick={save} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
