import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ShieldCheck } from 'lucide-react'
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
 * 后台登录页。
 *
 * 精简范围：只留账号密码登录。找回密码（邮箱验证码）与 TOTP 二步验证都不做——
 * 本地一体化模式下平台跟着桌面端走，管理员就是本机用户，没有邮箱可发、也没有必要多一道。
 */
export default function Login() {
  const { refreshUser } = useApp()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [agreed, setAgreed] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!agreed) {
      toast.error('请先阅读并同意用户协议和隐私政策')
      return
    }
    setLoading(true)
    try {
      const res = await api<LoginResult>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      })
      if (res.user?.role !== 'admin') {
        toast.error('仅平台管理员可登录后台')
        return
      }
      localStorage.setItem(TOKEN_KEY, res.token!)
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
            <ShieldCheck className="size-5" />
          </div>
          <CardTitle>青鸟平台登录</CardTitle>
          <CardDescription>管理员账号登录</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
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
              {loading ? '登录中...' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
