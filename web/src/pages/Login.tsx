import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { KeyRound, Mail, ShieldCheck, UserPlus } from 'lucide-react'
import { api, TOKEN_KEY } from '@/lib/api'
import { useApp } from '@/contexts/AppContext'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import CodeField from '@/components/CodeField'

interface LoginResult {
  token?: string
  user?: { role: string }
}

/**
 * 平台登录页：登录 / 注册两个页签。
 *
 * 登录有两种方式：邮箱验证码（邮件配置后的主方式，member 没有密码只能用它）
 * 和账号密码（管理员兜底——邮件还没配时进后台配 SMTP 的唯一途径）。
 * 默认方式跟着服务端「邮件是否已配置」走，配置好后登录就全部用验证码。
 *
 * 注册 = 邮箱 + 验证码，不设密码；建出来的都是 member（第一个注册的自动 admin），
 * member 进不了后台，注册成功提示去桌面端登录。
 */
export default function Login() {
  const { refreshUser, settings } = useApp()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [way, setWay] = useState<'code' | 'password'>('code')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [agreed, setAgreed] = useState(false)
  // 「邮件已配置 → 默认验证码登录」只在设置首次到达时应用一次，不覆盖用户手动切换
  const wayApplied = useRef(false)

  useEffect(() => {
    if (!wayApplied.current && typeof settings.mail_configured === 'boolean') {
      wayApplied.current = true
      setWay(settings.mail_configured ? 'code' : 'password')
    }
  }, [settings.mail_configured])

  const isRegister = mode === 'register'
  const isCode = !isRegister && way === 'code'

  const authed = (res: LoginResult, memberHint: string) => {
    if (!res.token) {
      toast.error('登录失败：服务端未返回令牌')
      return
    }
    // 后台只放 admin；member 的登录态在桌面端登录页（/ide/login）里才有意义
    if (res.user?.role !== 'admin') {
      toast.info(memberHint)
      if (isRegister) {
        setMode('login')
        setCode('')
      }
      return
    }
    localStorage.setItem(TOKEN_KEY, res.token)
    refreshUser().then(() => navigate('/admin'))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!agreed) {
      toast.error('请先阅读并同意用户协议和隐私政策')
      return
    }
    setLoading(true)
    try {
      if (isRegister) {
        const res = await api<LoginResult>('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email: email.trim(), name, code: code.trim() })
        })
        authed(res, '注册成功，请到桌面端登录使用')
      } else if (isCode) {
        const res = await api<LoginResult>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: email.trim(), code: code.trim() })
        })
        authed(res, '该账号不是管理员，请到桌面端登录使用')
      } else {
        const res = await api<LoginResult>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: email.trim(), password })
        })
        authed(res, '该账号不是管理员，请到桌面端登录使用')
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="bg-primary text-primary-foreground grid size-10 place-items-center rounded-xl">
            {isRegister ? <UserPlus className="size-5" /> : <ShieldCheck className="size-5" />}
          </div>
          <CardTitle>{isRegister ? '注册青鸟账号' : '青鸟平台登录'}</CardTitle>
          <CardDescription>
            {isRegister ? '使用邮箱验证码注册' : isCode ? '使用邮箱验证码登录' : '管理员账号密码登录'}
          </CardDescription>
          <div className="mt-2 grid w-full grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            <Button type="button" size="sm" variant={isRegister ? 'ghost' : 'default'} onClick={() => setMode('login')}>
              登录
            </Button>
            <Button type="button" size="sm" variant={isRegister ? 'default' : 'ghost'} onClick={() => setMode('register')}>
              注册
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {isRegister && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">账号名（选填）</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="不填则取邮箱 @ 前面的部分"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            {isRegister || isCode ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">邮箱验证码</Label>
                <CodeField
                  value={code}
                  onChange={setCode}
                  onSend={async () => {
                    if (!email.trim()) throw new Error('请先填写邮箱')
                    const r = await api<{ message: string }>('/auth/send-code', {
                      method: 'POST',
                      body: JSON.stringify({ email: email.trim(), purpose: isRegister ? 'register' : 'login' })
                    })
                    toast.success(r.message ?? '验证码已发送')
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            )}
            {!isRegister && (
              <button
                type="button"
                className="text-muted-foreground flex items-center justify-center gap-1 text-xs underline"
                onClick={() => setWay(way === 'code' ? 'password' : 'code')}
              >
                {way === 'code' ? (
                  <>
                    <KeyRound className="size-3" /> 用密码登录
                  </>
                ) : (
                  <>
                    <Mail className="size-3" /> 用验证码登录
                  </>
                )}
              </button>
            )}
            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span>我已阅读并同意《用户协议》和《隐私政策》</span>
            </label>
            <Button type="submit" disabled={loading}>
              {loading ? '处理中...' : isRegister ? '注册' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
