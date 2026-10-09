import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Boxes, Check, Copy, ExternalLink, KeyRound, Loader2, Smartphone } from 'lucide-react'
import { api, getToken, TOKEN_KEY } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface PairResult { code: string; expires_in: number; app_url: string; user: { id: number; name: string; email: string } }

/**
 * 青鸟桌面端登录页（/ide/login）：
 * 1. 用平台账号登录（与后台同一套账号，含二步验证）；
 * 2. 换取一次性授权码（10 分钟、一次有效）；
 * 3. 唤起 qingniao://auth?code=xxx 把授权码交给青鸟；唤不起就复制授权码手动粘贴。
 *
 * 页面本身不依赖登录态，未登录直接访问即进入登录流程。
 */
export default function IdeLogin() {
    const [booting, setBooting] = useState(true)
    const [mode, setMode] = useState<'login' | 'register'>('login')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [name, setName] = useState('')
    const [code, setCode] = useState('')
    const [busy, setBusy] = useState(false)
    const [pair, setPair] = useState<PairResult | null>(null)
    const [left, setLeft] = useState(0)
    const [copied, setCopied] = useState(false)

    /** 设备名：让后台「已连接客户端」里能区分是哪台机器 */
    const deviceName = useMemo(() => {
        const ua = navigator.userAgent
        const os = /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Web'
        return `青鸟 · ${os}`
    }, [])

    /** 已有登录态（同一浏览器登录过后台）→ 直接进入授权步骤，不必重复输密码 */
    useEffect(() => {
        const token = getToken()
        if (!token) { setBooting(false); return }
        api<{ name: string }>('/auth/me')
            .then(() => doPair())
            .catch(() => { localStorage.removeItem(TOKEN_KEY); setBooting(false) })
    }, [])

    // 授权码倒计时
    useEffect(() => {
        if (!pair) return
        setLeft(pair.expires_in)
        const t = setInterval(() => setLeft((v) => (v <= 1 ? (clearInterval(t), 0) : v - 1)), 1000)
        return () => clearInterval(t)
    }, [pair])

    const doPair = async () => {
        try {
            setPair(await api<PairResult>('/ide/pair', { method: 'POST', body: JSON.stringify({ device: deviceName }) }))
        } catch (e) {
            toast.error((e as Error).message)
        } finally {
            setBooting(false)
        }
    }

    const login = async (e: React.FormEvent) => {
        e.preventDefault()
        const isRegister = mode === 'register'
        setBusy(true)
        try {
            // 注册走同一个接口，注册成功服务端直接发 token，于是可以一步跳到授权码那步
            const r = await api<{ token?: string }>(isRegister ? '/auth/register' : '/auth/login', {
                method: 'POST',
                body: JSON.stringify(isRegister ? { email, password, name, code } : { email, password }),
            })
            if (!r.token) {
                toast.error('服务端未返回令牌，请重试')
                return
            }
            localStorage.setItem(TOKEN_KEY, r.token)
            await doPair()
        } catch (err) {
            toast.error((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    const switchAccount = async () => {
        try { await api('/auth/logout', { method: 'POST' }) } catch { /* 忽略 */ }
        localStorage.removeItem(TOKEN_KEY)
        setPair(null)
        setEmail(''); setPassword('')
    }

    const openApp = () => {
        if (!pair) return
        window.location.href = pair.app_url
    }

    const copyCode = async () => {
        if (!pair) return
        try {
            await navigator.clipboard.writeText(pair.code)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch { toast.error('复制失败，请手动选中授权码复制') }
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
            <Card className="w-full max-w-md">
                <CardContent className="p-6">
                    <div className="mb-6 flex items-center gap-2">
                        <div className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-md"><Boxes className="size-4" /></div>
                        <div>
                            <div className="font-semibold">登录青鸟</div>
                            <div className="text-xs text-muted-foreground">使用平台账号授权本机青鸟客户端</div>
                        </div>
                    </div>

                    {booting ? (
                        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在检查登录状态…</div>
                    ) : pair ? (
                        <div className="space-y-4">
                            <div className="rounded-md border bg-muted/30 p-3 text-sm">
                                <Smartphone className="mr-1.5 inline size-4 text-muted-foreground" />
                                已为 <b>{pair.user.name}</b> 生成授权码，剩余有效时间 {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
                            </div>

                            <Button className="w-full" size="lg" onClick={openApp} disabled={left <= 0}>
                                <ExternalLink className="mr-1.5 size-4" />打开青鸟 APP
                            </Button>
                            <p className="text-xs text-muted-foreground">
                                点上方按钮会唤起本机青鸟并自动完成登录。如果浏览器没有反应（未安装或系统未注册协议），
                                请复制下面的授权码，回到青鸟点「登录」→「粘贴授权码」。
                            </p>

                            <div className="space-y-1">
                                <Label className="text-xs">授权码（10 分钟内有效，用一次即作废）</Label>
                                <div className="flex gap-2">
                                    <Input readOnly value={pair.code} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                                    <Button variant="outline" onClick={copyCode}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
                                </div>
                            </div>

                            <button className="text-xs text-muted-foreground underline" onClick={switchAccount}>换一个账号登录</button>
                        </div>
                    ) : (
                        <form className="space-y-4" onSubmit={login}>
                            {mode === 'register' && (
                                <div className="space-y-1">
                                    <Label>账号名（选填）</Label>
                                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="不填则取邮箱 @ 前面的部分" />
                                </div>
                            )}
                            <div className="space-y-1"><Label>邮箱</Label><Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></div>
                            <div className="space-y-1">
                                <Label>密码</Label>
                                <div className="relative">
                                    <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input className="pl-8" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'register' ? '至少 6 位' : undefined} />
                                </div>
                            </div>
                            {mode === 'register' && (
                                <div className="space-y-1">
                                    <Label>邮箱验证码</Label>
                                    <Input required inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" />
                                    <p className="text-xs text-muted-foreground">
                                        本地部署不发邮件，验证码固定为 <span className="font-mono font-medium">000000</span>
                                    </p>
                                </div>
                            )}
                            <Button className="w-full" type="submit" disabled={busy || !email || !password}>{busy ? '处理中...' : mode === 'register' ? '注册并授权' : '登录并授权'}</Button>
                            <p className="text-xs text-muted-foreground">账号与后台一致。青鸟只会拿到一份可随时吊销的长期授权，不会保存你的密码。</p>
                            <button
                                type="button"
                                className="text-xs text-muted-foreground underline"
                                onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
                            >
                                {mode === 'login' ? '没有账号？直接注册' : '已有账号？去登录'}
                            </button>
                        </form>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
