import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Send } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface MailConfig {
  host: string
  port: number
  user: string
  from: string
  secure: string
  has_pass: boolean
}

/**
 * 邮件设置：SMTP 发信配置 + 测试发送。
 * 密码只写不读——接口从不回显明文（只给 has_pass），输入框留空即保持原密码不变。
 */
export default function MailSettings() {
  const [cfg, setCfg] = useState<MailConfig | null>(null)
  const [pass, setPass] = useState('')
  const [testTo, setTestTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    api<MailConfig>('/admin/mail-config').then(setCfg).catch((e) => toast.error((e as Error).message))
  }, [])

  if (!cfg) return <p className="text-muted-foreground text-sm">加载中…</p>

  const save = async () => {
    setBusy(true)
    try {
      await api('/admin/mail-config', { method: 'PUT', body: JSON.stringify({ ...cfg, pass }) })
      toast.success('已保存')
      setCfg(await api<MailConfig>('/admin/mail-config'))
      setPass('')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const r = await api<{ message: string }>('/admin/mail-config/test', {
        method: 'POST',
        body: JSON.stringify({ to: testTo.trim() })
      })
      toast.success(r.message)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>邮件设置</CardTitle>
          <CardDescription>
            配置后注册与登录使用邮箱验证码。主流邮箱的服务器与端口：QQ 邮箱 smtp.qq.com 465（SSL）、
            163 邮箱 smtp.163.com 465（SSL）、Gmail smtp.gmail.com 587（STARTTLS），密码用邮箱的「授权码」。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>SMTP 服务器</Label>
            <Input
              value={cfg.host}
              onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
              placeholder="smtp.qq.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>端口</Label>
              <Input
                type="number"
                value={cfg.port}
                onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>加密方式</Label>
              <div className="flex h-9 gap-1 rounded-lg bg-muted p-1">
                <Button
                  type="button"
                  size="sm"
                  className="flex-1"
                  variant={cfg.secure === 'ssl' ? 'default' : 'ghost'}
                  onClick={() => setCfg({ ...cfg, secure: 'ssl', port: cfg.port === 587 ? 465 : cfg.port })}
                >
                  SSL
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="flex-1"
                  variant={cfg.secure === 'starttls' ? 'default' : 'ghost'}
                  onClick={() => setCfg({ ...cfg, secure: 'starttls', port: cfg.port === 465 ? 587 : cfg.port })}
                >
                  STARTTLS
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>SMTP 用户名</Label>
            <Input
              value={cfg.user}
              onChange={(e) => setCfg({ ...cfg, user: e.target.value })}
              placeholder="通常是发件邮箱本身"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>SMTP 密码 / 授权码</Label>
            <Input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder={cfg.has_pass ? '已设置，留空保持不变' : '邮箱授权码（不是登录密码）'}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>发件人邮箱</Label>
            <Input
              type="email"
              value={cfg.from}
              onChange={(e) => setCfg({ ...cfg, from: e.target.value })}
              placeholder="验证码邮件的发件人，通常与用户名相同"
            />
          </div>
          <div>
            <Button onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>测试发送</CardTitle>
          <CardDescription>保存后发一封测试邮件，SMTP 报错会原样显示，方便排查。</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="收件邮箱"
          />
          <Button variant="outline" className="shrink-0" onClick={test} disabled={testing || !testTo.trim()}>
            <Send className="size-4" />
            {testing ? '发送中…' : '发送测试邮件'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
