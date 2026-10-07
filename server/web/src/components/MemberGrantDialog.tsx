import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtNumber } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface GrantTarget {
    id: number
    name: string
    points: number
}

/**
 * 赠送积分：填「本次赠送多少」，不是最终余额。
 *
 * 后端只认最终余额（差额自动进 PointLog 流水），所以这里负责把目标余额算好再提交；
 * 填负数即为扣减，扣到负数的请求在提交前就拦掉。
 */
export default function MemberGrantDialog({
    member,
    onClose,
    onDone,
}: {
    member: GrantTarget | null
    onClose: () => void
    onDone?: () => void
}) {
    const [amount, setAmount] = useState('')
    const [remark, setRemark] = useState('')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (member) {
            setAmount('')
            setRemark('')
        }
    }, [member])

    const raw = amount.trim()
    const delta = Number(raw)
    const isInt = raw !== '' && Number.isInteger(delta)
    const after = (member?.points ?? 0) + (isInt ? delta : 0)

    const save = async () => {
        if (!member) return
        if (!isInt) { toast.error('积分请填整数'); return }
        if (delta === 0) { toast.error('赠送数量不能为 0'); return }
        if (after < 0) { toast.error(`扣减后余额会变成 ${after}，不能为负`); return }

        setSaving(true)
        try {
            const r = await api<{ message: string }>(`/admin/members/${member.id}`, {
                method: 'PUT',
                body: JSON.stringify({ points: after, remark }),
            })
            toast.success(r.message)
            onDone?.()
            onClose()
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
            <DialogContent>
                <DialogHeader><DialogTitle>赠送积分 · {member?.name}</DialogTitle></DialogHeader>
                <div className="space-y-3">
                    <div className="rounded-md border bg-muted/30 p-3 text-sm">
                        当前积分 <b className="font-mono">{fmtNumber(member?.points)}</b>
                        {isInt && delta !== 0 && (
                            <span className="text-muted-foreground">
                                {' → '}
                                <b className="font-mono">{fmtNumber(after)}</b>
                                （{delta > 0 ? '+' : ''}{fmtNumber(delta)}）
                            </span>
                        )}
                    </div>
                    <div className="space-y-1">
                        <Label>赠送数量</Label>
                        <Input
                            type="number"
                            step={1}
                            placeholder="如 10000"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">填本次要增加的积分，不是最终余额。填负数即为扣减，余额不会为负。</p>
                    </div>
                    <div className="space-y-1">
                        <Label>备注</Label>
                        <Input placeholder="如：9 月充值 / 补偿" value={remark} onChange={(e) => setRemark(e.target.value)} />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>取消</Button>
                    <Button onClick={save} disabled={saving}>{saving ? '提交中...' : '确定赠送'}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
