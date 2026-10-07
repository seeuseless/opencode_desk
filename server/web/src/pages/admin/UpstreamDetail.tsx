import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Activity, ArrowLeft, Download, FlaskConical, KeyRound, Loader2, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtTime } from '@/lib/utils'
import { confirmDialog } from '@/lib/confirm'
import { AiStatusBadge } from '@/components/AiStatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface UpKey {
    id: number
    upstream_id: number
    name: string
    api_key_masked: string
    enabled: boolean
    status: string
    latency_ms: number | null
    last_checked_at: string | null
    last_error: string | null
    last_used_at: string | null
}

interface UpModel {
    id: number
    model: string
    model_id: number | null
    matched_name: string | null
    manual: boolean
    enabled: boolean
    status: string
    latency_ms: number | null
    last_checked_at: string | null
    last_error: string | null
}

interface Upstream {
    id: number
    name: string
    driver: string
    base_url: string
    enabled: boolean
    sort: number
    remark: string | null
    models_synced_at: string | null
    keys: UpKey[]
    models: UpModel[]
    stats: { keys: number; keys_ok: number; models: number; matched: number; unmatched: number; manual: number }
}

const emptyKey = { name: '', api_key: '', enabled: true }
const emptyModel = { model: '', enabled: true }

/**
 * 上游详情页：密钥、模型清单、同步/检测/导入——列表页装不下的全在这儿。
 * 模型动辄几百个，所以这里给模型表加搜索与「只看未匹配」筛选。
 */
export default function UpstreamDetail() {
    const { id } = useParams()
    const nav = useNavigate()
    const [u, setU] = useState<Upstream | null>(null)
    const [busy, setBusy] = useState<Record<string, boolean>>({})
    const [keyDialog, setKeyDialog] = useState(false)
    const [keyEditing, setKeyEditing] = useState<UpKey | null>(null)
    const [keyForm, setKeyForm] = useState(emptyKey)
    const [saving, setSaving] = useState(false)
    const [kw, setKw] = useState('')
    const [onlyUnmatched, setOnlyUnmatched] = useState(false)
    const [modelDialog, setModelDialog] = useState(false)
    const [modelEditing, setModelEditing] = useState<UpModel | null>(null)
    const [modelForm, setModelForm] = useState(emptyModel)

    const load = useCallback(async () => {
        try {
            setU(await api<Upstream>(`/admin/ai-upstreams/upstreams/${id}`))
        } catch (e) {
            toast.error((e as Error).message)
        }
    }, [id])

    useEffect(() => { load() }, [load])

    const run = async (tag: string, fn: () => Promise<void>) => {
        setBusy((b) => ({ ...b, [tag]: true }))
        try { await fn() } finally { setBusy((b) => ({ ...b, [tag]: false })) }
    }

    const toggleUpstream = async (enabled: boolean) => {
        if (!u) return
        try {
            await api(`/admin/ai-upstreams/upstreams/${u.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
            load()
        } catch (e) { toast.error((e as Error).message) }
    }

    /** 自动获取模型：拉上游 /models 覆盖本地清单，并自动与模型库同名匹配 */
    const syncModels = () => u && run('sync', async () => {
        try {
            const r = await api<{ message: string; stats: { added: number; removed: number; matched: number; unmatched: number } }>(
                `/admin/ai-upstreams/upstreams/${u.id}/sync`, { method: 'POST' },
            )
            toast.success(r.message, {
                description: `新增 ${r.stats.added}、移除 ${r.stats.removed}、匹配 ${r.stats.matched}、待匹配 ${r.stats.unmatched}`,
            })
            load()
        } catch (e) { toast.error((e as Error).message) }
    })

    const testUpstream = () => u && run('test', async () => {
        try {
            const r = await api<{ report: { name: string; status: string; error: string | null }[]; models: string[] }>(
                `/admin/ai-upstreams/upstreams/${u.id}/test`, { method: 'POST' },
            )
            const bad = r.report.filter((k) => k.status === 'error')
            const ok = r.report.length - bad.length
            if (!bad.length) toast.success(`${u.name}：${ok}/${r.report.length} 把密钥可用，上游共 ${r.models.length} 个模型`)
            else toast.warning(`${u.name}：${ok} 把可用、${bad.length} 把失败`, { description: bad[0]?.error || '' })
            load()
        } catch (e) { toast.error((e as Error).message) }
    })

    const importModels = () => u && run('imp', async () => {
        try {
            const r = await api<{ added: number; message: string }>(`/admin/ai-upstreams/upstreams/${u.id}/import-models`, { method: 'POST' })
            toast.success(r.message)
            load()
        } catch (e) { toast.error((e as Error).message) }
    })

    const openKeyNew = () => { setKeyEditing(null); setKeyForm(emptyKey); setKeyDialog(true) }
    const openKeyEdit = (k: UpKey) => { setKeyEditing(k); setKeyForm({ name: k.name, api_key: '', enabled: k.enabled }); setKeyDialog(true) }

    const openModelNew = () => { setModelEditing(null); setModelForm(emptyModel); setModelDialog(true) }
    const openModelEdit = (m: UpModel) => { setModelEditing(m); setModelForm({ model: m.model, enabled: m.enabled }); setModelDialog(true) }

    const saveModel = async () => {
        if (!u) return
        const name = modelForm.model.trim()
        if (!name) { toast.error('请填写模型名'); return }
        setSaving(true)
        try {
            const body = JSON.stringify({ ...modelForm, model: name })
            if (modelEditing) await api(`/admin/ai-upstreams/models/${modelEditing.id}`, { method: 'PUT', body })
            else await api(`/admin/ai-upstreams/upstreams/${u.id}/models`, { method: 'POST', body })
            toast.success('已保存')
            setModelDialog(false)
            load()
        } catch (e) { toast.error((e as Error).message) } finally { setSaving(false) }
    }

    const removeModel = async (m: UpModel) => {
        if (!(await confirmDialog(`删除模型「${m.model}」？只是这个上游不再提供它，模型库里的同名条目不受影响。`))) return
        try { await api(`/admin/ai-upstreams/models/${m.id}`, { method: 'DELETE' }); load() } catch (e) { toast.error((e as Error).message) }
    }

    const saveKey = async () => {
        if (!u) return
        if (!keyEditing && !keyForm.api_key.trim()) { toast.error('请填写 API Key'); return }
        setSaving(true)
        try {
            if (keyEditing) await api(`/admin/ai-upstreams/keys/${keyEditing.id}`, { method: 'PUT', body: JSON.stringify(keyForm) })
            else await api(`/admin/ai-upstreams/upstreams/${u.id}/keys`, { method: 'POST', body: JSON.stringify(keyForm) })
            toast.success('已保存')
            setKeyDialog(false)
            load()
        } catch (e) { toast.error((e as Error).message) } finally { setSaving(false) }
    }

    const removeKey = async (k: UpKey) => {
        if (!(await confirmDialog(`删除密钥「${k.name || k.api_key_masked}」？`))) return
        try { await api(`/admin/ai-upstreams/keys/${k.id}`, { method: 'DELETE' }); load() } catch (e) { toast.error((e as Error).message) }
    }

    const testKey = (k: UpKey) => run(`key-${k.id}`, async () => {
        try {
            const r = await api<{ key: UpKey; ok: boolean; error: string | null }>(`/admin/ai-upstreams/keys/${k.id}/test`, { method: 'POST' })
            if (r.ok) toast.success(`密钥可用（${r.key.latency_ms}ms）`)
            else toast.error('密钥不可用', { description: r.error || '' })
            load()
        } catch (e) { toast.error((e as Error).message) }
    })

    const probeKey = (k: UpKey) => run(`probe-${k.id}`, async () => {
        try {
            const r = await api<{ ok: boolean; error: string | null; model: string; reply: string | null }>(`/admin/ai-upstreams/keys/${k.id}/probe`, { method: 'POST' })
            if (r.ok) toast.success(`真实调用成功：${r.model}`, { description: r.reply ? `模型回包：${r.reply}` : '' })
            else toast.error('真实调用失败', { description: r.error || '' })
            load()
        } catch (e) { toast.error((e as Error).message) }
    })

    const testModel = (m: UpModel) => run(`m-${m.id}`, async () => {
        try {
            const r = await api<{ ok: boolean; error: string | null; reply: string | null; via: { upstream: string | null; model: string } }>(
                `/admin/ai-models/models/${m.model_id}/test`, { method: 'POST' },
            )
            if (r.ok) toast.success(`调用成功：${r.via?.upstream} → ${r.via?.model}`, { description: r.reply ? `模型回包：${r.reply}` : '' })
            else toast.error('调用失败', { description: r.error || '' })
            load()
        } catch (e) { toast.error((e as Error).message) }
    })

    if (!u) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />加载中...</div>

    const models = u.models.filter((m) => {
        if (onlyUnmatched && m.model_id) return false
        return kw.trim() === '' || m.model.toLowerCase().includes(kw.trim().toLowerCase())
    })

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => nav('/admin/ai/upstreams')}>
                    <ArrowLeft className="mr-1 size-4" />上游列表
                </Button>
                <h1 className="text-xl font-bold">{u.name}</h1>
                <Badge variant="outline" className="font-normal">{u.driver}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{u.base_url}</span>
                <span className="text-xs text-muted-foreground">排序 {u.sort}</span>
                <div className="ml-auto flex items-center gap-2">
                    <Switch checked={u.enabled} onCheckedChange={toggleUpstream} />
                    <span className="text-sm text-muted-foreground">{u.enabled ? '启用中' : '已停用'}</span>
                </div>
            </div>

            <p className="text-sm text-muted-foreground">
                密钥 {u.stats.keys_ok}/{u.stats.keys} 可用 · 模型 {u.stats.models} 个（匹配 {u.stats.matched}，未匹配 {u.stats.unmatched}）
                {u.models_synced_at ? ` · 同步于 ${fmtTime(u.models_synced_at)}` : ''}
                {u.remark ? ` · ${u.remark}` : ''}
            </p>

            <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={busy.sync} onClick={syncModels}>
                    <Download className={`mr-1 size-4 ${busy.sync ? 'animate-bounce' : ''}`} />自动获取模型
                </Button>
                <Button variant="outline" size="sm" disabled={busy.test} onClick={testUpstream}>
                    <RefreshCw className={`mr-1 size-4 ${busy.test ? 'animate-spin' : ''}`} />检测全部密钥
                </Button>
                {u.stats.unmatched > 0 && (
                    <Button variant="outline" size="sm" disabled={busy.imp} onClick={importModels}>
                        <Plus className="mr-1 size-4" />把未匹配的 {u.stats.unmatched} 个加入「模型」
                    </Button>
                )}
            </div>

            <Card>
                <CardHeader className="flex-row items-center gap-2 pb-3">
                    <KeyRound className="size-4 text-muted-foreground" />
                    <span className="font-semibold">API Key（{u.keys.length}）</span>
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={openKeyNew}><Plus className="mr-1 size-3.5" />新增</Button>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>备注</TableHead><TableHead>密钥</TableHead><TableHead className="w-[110px]">状态</TableHead>
                                <TableHead className="w-[160px]">最近检测</TableHead><TableHead>失败原因</TableHead><TableHead className="w-[190px]">操作</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {u.keys.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">还没有密钥，同一个上游可以配多把，网关自动择优与故障转移</TableCell></TableRow>}
                            {u.keys.map((k) => (
                                <TableRow key={k.id}>
                                    <TableCell className="font-medium">
                                        {k.name || '—'}
                                        {!k.enabled && <Badge variant="secondary" className="ml-1.5">已停用</Badge>}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{k.api_key_masked}</TableCell>
                                    <TableCell><AiStatusBadge status={k.enabled ? k.status : 'unknown'} latency={k.latency_ms} /></TableCell>
                                    <TableCell className="text-xs">{k.last_checked_at ? fmtTime(k.last_checked_at) : '—'}</TableCell>
                                    <TableCell className="max-w-[220px] truncate text-xs text-red-500" title={k.last_error || ''}>{k.last_error || ''}</TableCell>
                                    <TableCell>
                                        <Button variant="ghost" size="sm" disabled={busy[`key-${k.id}`]} onClick={() => testKey(k)}><Activity className="mr-1 size-3.5" />检测</Button>
                                        <Button variant="ghost" size="sm" disabled={busy[`probe-${k.id}`]} onClick={() => probeKey(k)}><FlaskConical className="mr-1 size-3.5" />调用</Button>
                                        <Button variant="ghost" size="icon" onClick={() => openKeyEdit(k)}><Pencil className="size-3.5" /></Button>
                                        <Button variant="ghost" size="icon" onClick={() => removeKey(k)}><Trash2 className="size-3.5" /></Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="gap-3 pb-3">
                    <div className="flex items-center gap-2">
                        <Server className="size-4 text-muted-foreground" />
                        <span className="font-semibold">模型（{u.models.length}）</span>
                        <div className="ml-auto flex items-center gap-2">
                            <Input className="h-8 w-[200px]" placeholder="搜索模型名" value={kw} onChange={(e) => setKw(e.target.value)} />
                            <Button size="sm" variant={onlyUnmatched ? 'default' : 'outline'} onClick={() => setOnlyUnmatched((v) => !v)}>
                                只看未匹配
                            </Button>
                            <Button size="sm" variant="outline" onClick={openModelNew}>
                                <Plus className="mr-1 size-3.5" />新增模型
                            </Button>
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        与「模型」菜单里的模型名同名即自动匹配，那个模型就多了一个供货方。
                        手工新增/改名的模型在「自动获取模型」时不会被删（上游不上报不代表上游没有）。
                        当前显示 {models.length} 条{u.stats.manual > 0 ? ` · 其中手工 ${u.stats.manual} 条` : ''}。
                    </p>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>模型</TableHead><TableHead className="w-[120px]">匹配</TableHead><TableHead className="w-[110px]">状态</TableHead>
                                <TableHead className="w-[160px]">最近检测</TableHead><TableHead>失败原因</TableHead><TableHead className="w-[190px]">操作</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {models.length === 0 && (
                                <TableRow><TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                                    {u.models.length === 0 ? '还没有模型，点上方「自动获取模型」从上游拉取，或手工新增' : '没有符合条件的模型'}
                                </TableCell></TableRow>
                            )}
                            {models.map((m) => (
                                <TableRow key={m.id}>
                                    <TableCell className="font-mono text-sm">
                                        {m.model}
                                        {m.manual && <Badge variant="outline" className="ml-1.5 font-normal">手工</Badge>}
                                        {!m.enabled && <Badge variant="secondary" className="ml-1.5">已停用</Badge>}
                                    </TableCell>
                                    <TableCell>
                                        {m.model_id
                                            ? <Badge variant="success">已匹配</Badge>
                                            : <Badge variant="warning">未匹配</Badge>}
                                    </TableCell>
                                    <TableCell><AiStatusBadge status={m.enabled ? m.status : 'unknown'} latency={m.latency_ms} /></TableCell>
                                    <TableCell className="text-xs">{m.last_checked_at ? fmtTime(m.last_checked_at) : '—'}</TableCell>
                                    <TableCell className="max-w-[200px] truncate text-xs text-red-500" title={m.last_error || ''}>{m.last_error || ''}</TableCell>
                                    <TableCell>
                                        {m.model_id
                                            ? <Button variant="ghost" size="sm" disabled={busy[`m-${m.id}`]} onClick={() => testModel(m)}><FlaskConical className="mr-1 size-3.5" />测试</Button>
                                            : null}
                                        <Button variant="ghost" size="icon" title="编辑" onClick={() => openModelEdit(m)}><Pencil className="size-3.5" /></Button>
                                        <Button variant="ghost" size="icon" title="删除" onClick={() => removeModel(m)}><Trash2 className="size-3.5" /></Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <div className="text-xs text-muted-foreground">
                想改名称 / URL / 备注？回<Link className="underline" to="/admin/ai/upstreams">上游列表</Link>点编辑。
            </div>

            <Dialog open={modelDialog} onOpenChange={setModelDialog}>
                <DialogContent>
                    <DialogHeader><DialogTitle>{modelEditing ? '编辑模型' : `新增模型 · ${u.name}`}</DialogTitle></DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <Label>模型名</Label>
                            <Input autoFocus placeholder="如 deepseek-v4-flash" value={modelForm.model} onChange={(e) => setModelForm((f) => ({ ...f, model: e.target.value }))} />
                            <p className="text-xs text-muted-foreground">
                                填上游真实接受的模型标识，网关转发时原样传给它。
                                与「模型」菜单里的名字相同即自动匹配；手工维护的模型不会被「自动获取模型」删掉。
                            </p>
                        </div>
                        <div className="flex items-center gap-2"><Switch checked={modelForm.enabled} onCheckedChange={(v) => setModelForm((f) => ({ ...f, enabled: v }))} /><span className="text-sm">启用（停用的模型不对外提供）</span></div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setModelDialog(false)}>取消</Button>
                        <Button onClick={saveModel} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={keyDialog} onOpenChange={setKeyDialog}>
                <DialogContent>
                    <DialogHeader><DialogTitle>{keyEditing ? '编辑密钥' : `新增密钥 · ${u.name}`}</DialogTitle></DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1"><Label>备注名</Label><Input placeholder="如：主力 key / 备用 key" value={keyForm.name} onChange={(e) => setKeyForm((f) => ({ ...f, name: e.target.value }))} /></div>
                        <div className="space-y-1">
                            <Label>API Key</Label>
                            <Input placeholder={keyEditing ? `留空不修改（当前 ${keyEditing.api_key_masked}）` : 'sk-...'} value={keyForm.api_key} onChange={(e) => setKeyForm((f) => ({ ...f, api_key: e.target.value }))} />
                            <p className="text-xs text-muted-foreground">加密存储，后台只显示掩码。同一个上游可加多把，网关按状态自动择优、失败自动切换。</p>
                        </div>
                        <div className="flex items-center gap-2"><Switch checked={keyForm.enabled} onCheckedChange={(v) => setKeyForm((f) => ({ ...f, enabled: v }))} /><span className="text-sm">启用（停用的 Key 不参与轮换）</span></div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setKeyDialog(false)}>取消</Button>
                        <Button onClick={saveKey} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
