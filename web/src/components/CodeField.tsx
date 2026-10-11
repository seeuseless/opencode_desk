import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * 邮箱验证码输入行：右侧「获取验证码」按钮，发送成功后 60 秒倒计时。
 * 发送逻辑由调用方注入（登录/注册走 /auth/send-code，超管换邮箱走管理接口），
 * onSend 抛错会 toast 出来且不启动倒计时，成功提示也由调用方在 onSend 里 toast。
 */
export default function CodeField({ onSend, value, onChange }: {
    onSend: () => Promise<void>
    value: string
    onChange: (v: string) => void
}) {
    const [left, setLeft] = useState(0)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        if (left <= 0) return
        const t = setInterval(() => setLeft((v) => (v <= 1 ? 0 : v - 1)), 1000)
        return () => clearInterval(t)
    }, [left])

    const send = async () => {
        setBusy(true)
        try {
            await onSend()
            setLeft(60)
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex gap-2">
            <Input
                required
                inputMode="numeric"
                placeholder="6 位验证码"
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
            <Button type="button" variant="outline" className="w-28 shrink-0" disabled={busy || left > 0} onClick={send}>
                {left > 0 ? `${left}s 后重发` : busy ? '发送中…' : '获取验证码'}
            </Button>
        </div>
    )
}
