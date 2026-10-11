import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, LogOut, MailPlus, User } from 'lucide-react'
import { toast } from 'sonner'
import { useApp } from '@/contexts/AppContext'
import { api, TOKEN_KEY } from '@/lib/api'
import { confirmDialog } from '@/lib/confirm'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import CodeField from '@/components/CodeField'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

/**
 * 右上角账号菜单：修改邮箱 + 退出登录（自定义确认框）。
 * 初始化的管理员邮箱可能是假的（收不到验证码），换邮箱走「新邮箱收码」验证，
 * 换成真实邮箱之后日常登录就全用邮箱验证码。
 */
export default function UserMenu() {
  const { user, refreshUser } = useApp()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const openDialog = () => {
    setEmail('')
    setCode('')
    setOpen(true)
  }

  const sendCode = async () => {
    if (!email.trim()) throw new Error('请先填写新邮箱')
    const r = await api<{ message: string }>('/admin/profile/email/code', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim() })
    })
    toast.success(r.message ?? '验证码已发送')
  }

  const submit = async () => {
    setBusy(true)
    try {
      const r = await api<{ message: string; user: { email: string } }>('/admin/profile/email', {
        method: 'PUT',
        body: JSON.stringify({ email: email.trim(), code: code.trim() })
      })
      toast.success(r.message ?? '邮箱已更新')
      setOpen(false)
      await refreshUser()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    if (!(await confirmDialog('确定退出登录？'))) return
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch {
      /* ignore */
    }
    localStorage.removeItem(TOKEN_KEY)
    navigate('/login')
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5 px-2 font-normal focus-visible:ring-0">
            <User className="size-4" />
            <span className="hidden max-w-40 truncate sm:block">{user?.email}</span>
            <ChevronDown className="size-4 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={openDialog}>
            <MailPlus className="mr-2 size-4" />
            修改邮箱
          </DropdownMenuItem>
          <DropdownMenuItem onClick={logout}>
            <LogOut className="mr-2 size-4" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>修改邮箱</DialogTitle>
            <DialogDescription>
              当前 {user?.email}。新邮箱会收到验证码，验证通过即生效——之后的验证码登录、找回都发到新邮箱。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>新邮箱</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>邮箱验证码</Label>
              <CodeField value={code} onChange={setCode} onSend={sendCode} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submit} disabled={busy || !email.trim() || !code.trim()}>
              {busy ? '提交中…' : '确认修改'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
