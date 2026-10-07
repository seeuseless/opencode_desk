import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtTime } from '@/lib/utils'
import { confirmDialog } from '@/lib/confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/** 列表行：只列名称/状态/操作，密钥与模型全在详情页 */
interface UpstreamRow {
    id: number
    name: string
    base_url: string
    enabled: boolean
    sort: number
    remark: string | null
    keys_count: number
    keys_ok: number
    models_count: number
    matched_count: number
    models_synced_at: string | null
}

const emptyForm = { name: '', base_url: '', remark: '', enabled: true, sort: 0, api_key: '', models: '' }

/**
 * 上游（Token Plan 二级菜单）：一个 OpenAI 兼容服务。
 *
 * 列表刻意做瘦：一行一个上游，模型清单可能有几百条，展开在列表里会把页面撑爆。
 * 密钥、模型、同步/检测/导入全部进详情页。
 */
export default function Upstreams() {
    const nav = useNavigate()
    const [list, setList] = useState<UpstreamRow[]>([])
    const [busy, setBusy] = useState(false)
    const [dialog, setDialog] = useState(false)
    const [editing, setEditing] = useState<UpstreamRow | null>(null)
    const [form, setForm] = useState(emptyForm)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        setBusy(true)
        try {
            setList(await api<UpstreamRow[]>('/admin/ai-upstreams/upstreams'))
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setBusy(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const openNew = () => { setEditing(null); setForm(emptyForm); setDialog(true) }
    const openEdit = (u: UpstreamRow) => {
        setEditing(u)
        // api_key / models 编辑时一律留空：留空 = 不动已有的，回显掩码会诱导重复粘贴
        setForm({ name: u.name, base_url: u.base_url, remark: u.remark || '', enabled: u.enabled, sort: u.sort, api_key: '', models: '' })
        setDialog(true)
    }

    const save = async () => {
        if (!form.name.trim() || !form.base_url.trim()) { toast.error('请填写名称与 URL 地址'); return }
        setSaving(true)
        try {
            const body = JSON.stringify({
                ...form,
                base_url: form.base_url.trim(),
                sort: Number(form.sort) || 0,
                api_key: form.api_key.trim(),
                models: form.models.trim(),
            })
            if (editing) await api(`/admin/ai-upstreams/upstreams/${editing.id}`, { method: 'PUT', body })
            else await api('/admin/ai-upstreams/upstreams', { method: 'POST', body })
            toast.success('已保存')
            setDialog(false)
            load()
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setSaving(false)
        }
    }

    const toggle = async (u: UpstreamRow, enabled: boolean) => {
        try {
            await api(`/admin/ai-upstreams/upstreams/${u.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
            load()
        } catch (e) {
            toast.error((e as Error).message)
        }
    }

    const remove = async (u: UpstreamRow) => {
        if (!(await confirmDialog(`删除上游「${u.name}」会同时删除其 ${u.keys_count} 把密钥与 ${u.models_count} 个模型，确定？`))) return
        try {
            await api(`/admin/ai-upstreams/upstreams/${u.id}`, { method: 'DELETE' })
            toast.success('已删除')
            load()
        } catch (e) {
            toast.error((e as Error).message)
        }
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold">上游</h1>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={busy} onClick={load}>
                        <RefreshCw className={`mr-1 size-4 ${busy ? 'animate-spin' : ''}`} />刷新
                    </Button>
                    <Button size="sm" onClick={openNew}><Plus className="mr-1 size-4" />新增上游</Button>
                </div>
            </div>

            <p className="text-sm text-muted-foreground">
                一个上游 = 一个 OpenAI 兼容服务（<code className="rounded bg-muted px-1">/models</code>、
                <code className="rounded bg-muted px-1">/chat/completions</code>）。
                点名称进详情页配密钥、拉模型清单——模型可能有几百个，列表这里不展开。
            </p>

            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>名称</TableHead>
                                <TableHead className="w-[90px]">排序</TableHead>
                                <TableHead className="w-[160px]">状态</TableHead>
                                <TableHead className="w-[110px]">操作</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {list.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                                        还没有上游，先添加一个（如 deepseek）。
                                    </TableCell>
                                </TableRow>
                            )}
                            {list.map((u) => (
                                <TableRow key={u.id}>
                                    <TableCell>
                                        <button
                                            className="flex items-center gap-2 text-left hover:underline"
                                            onClick={() => nav(`/admin/ai/upstreams/${u.id}`)}
                                        >
                                            <Server className="size-4 text-muted-foreground" />
                                            <span className="font-medium">{u.name}</span>
                                        </button>
                                        <div className="mt-0.5 text-xs text-muted-foreground">
                                            {u.base_url} · 密钥 {u.keys_ok}/{u.keys_count} 可用 · 模型 {u.models_count}（匹配 {u.matched_count}）
                                            {u.models_synced_at ? ` · 同步于 ${fmtTime(u.models_synced_at, true)}` : ''}
                                        </div>
                                    </TableCell>
                                    <TableCell className="font-mono text-sm text-muted-foreground">{u.sort}</TableCell>
                                    <TableCell>
                                        <div className="flex items-center gap-2">
                                            <Switch checked={u.enabled} onCheckedChange={(v) => toggle(u, v)} />
                                            {u.enabled
                                                ? <Badge variant="success">启用</Badge>
                                                : <Badge variant="secondary">已停用</Badge>}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Button variant="ghost" size="icon" title="编辑" onClick={() => openEdit(u)}><Pencil className="size-4" /></Button>
                                        <Button variant="ghost" size="icon" title="删除" onClick={() => remove(u)}><Trash2 className="size-4" /></Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <Dialog open={dialog} onOpenChange={setDialog}>
                <DialogContent>
                    <DialogHeader><DialogTitle>{editing ? '编辑上游' : '新增上游'}</DialogTitle></DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1"><Label>名称</Label><Input placeholder="如 deepseek" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
                        <div className="space-y-1">
                            <Label>URL 地址</Label>
                            <Input className="font-mono" placeholder="https://api.deepseek.com/v1" value={form.base_url} onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))} />
                            <p className="text-xs text-muted-foreground">填到 /v1 为止，平台自动拼 /models 与 /chat/completions。</p>
                        </div>
                        <div className="space-y-1">
                            <Label>API Key</Label>
                            <Input className="font-mono" placeholder="sk-..." value={form.api_key} onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))} />
                            <p className="text-xs text-muted-foreground">
                                {editing ? '留空不修改；填了就在这个上游下新增一把密钥。' : '加密存储，后台只显示掩码。同一个上游可加多把，网关按状态自动择优、失败自动切换。'}
                            </p>
                        </div>
                        <div className="space-y-1">
                            <Label>模型名</Label>
                            <Textarea rows={3} className="font-mono" placeholder="deepseek-v4-flash, deepseek-v4-chat" value={form.models} onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))} />
                            <p className="text-xs text-muted-foreground">
                                逗号或换行分隔，填上游真实接受的模型标识。与「模型」菜单里的名字相同即自动匹配，那个模型就多了一个供货方。
                                {editing ? '留空不新增；已有的不会动。' : '也可以先不填，之后在详情页「自动获取模型」拉取。'}
                            </p>
                        </div>
                        <div className="space-y-1"><Label>备注</Label><Input value={form.remark} onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))} /></div>
                        <div className="space-y-1">
                            <Label>排序</Label>
                            <Input type="number" value={form.sort} onChange={(e) => setForm((f) => ({ ...f, sort: Number(e.target.value) }))} />
                            <p className="text-xs text-muted-foreground">数字越大越靠前（列表按倒序排）。</p>
                        </div>
                        <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} /><span className="text-sm">启用（停用后其下模型不再对外提供）</span></div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDialog(false)}>取消</Button>
                        <Button onClick={save} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
