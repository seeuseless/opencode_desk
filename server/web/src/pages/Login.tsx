import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ShieldCheck, UserPlus } from 'lucide-react'
import { api, TOKEN_KEY } from '@/lib/api'
import { useApp } from '@/contexts/AppContext'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface LoginResult {
  token?: string
  user?: { role: string }
}

/**
 * 平台登录页：登录 / 注册两个页签。
 *
 * 为什么加注册：本地一体化部署下平台是跟着桌面端走的，换台机器、换个数据目录就可能
 * 一个账号都没有，没有注册就只能去后台手工建。这里自助开号，省掉那一步。
 *
 * 注册建出来的都是 member（不能进后台，见服务端 register），所以注册成功后
 * 不能像登录那样直接 navigate('/admin')，得提示「去桌面端登录」——
 * 桌面端 /ide/login 走的是网页登录态，那边 member 是允许的。
 *
 * 邮箱验证码：本地部署没有可投递的邮箱，服务端固定收 000000，
 * 界面上直接把提示码写出来，别让人对着一个永远收不到信的输入框发呆。
 */
export default function Login() {
  const { refreshUser } = useApp()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [agreed, setAgreed] = useState(false)

  const isRegister = mode === 'register'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!agreed) {
      toast.error('请先阅读并同意用户协议和隐私政策')
      return
    }
    setLoading(true)
    try {
      const res = await api<LoginResult>(isRegister ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify(isRegister ? { email, password, name, code } : { email, password })
      })
      if (!res.token) {
        toast.error('登录失败：服务端未返回令牌')
        return
      }

      // 注册出来的是 member，进不了后台；登录时也要确认确实是 admin 才放行
      if (res.user?.role !== 'admin') {
        if (isRegister) {
          toast.success('注册成功，请到桌面端登录使用')
          setMode('login')
          setPassword('')
          setCode('')
          return
        }
        toast.error('仅平台管理员可登录后台')
        return
      }

      localStorage.setItem(TOKEN_KEY, res.token)
      await refreshUser()
      navigate('/admin')
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
            {isRegister ? '没有账号？直接注册一个' : '管理员账号登录'}
          </CardDescription>
          <div className="mt-2 grid w-full grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            <Button
              type="button"
              size="sm"
              variant={isRegister ? 'ghost' : 'default'}
              onClick={() => setMode('login')}
            >
              登录
            </Button>
            <Button
              type="button"
              size="sm"
              variant={isRegister ? 'default' : 'ghost'}
              onClick={() => setMode('register')}
            >
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
                placeholder="admin@local"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isRegister ? '至少 6 位' : undefined}
              />
            </div>
            {isRegister && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">邮箱验证码</Label>
                <Input
                  id="code"
                  required
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                />
                <p className="text-muted-foreground text-xs">
                  本地部署不发邮件，验证码固定为 <span className="font-mono font-medium">000000</span>
                </p>
              </div>
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
              {loading ? '处理中...' : isRegister ? '注册并登录' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}