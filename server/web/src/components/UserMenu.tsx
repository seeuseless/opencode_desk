import { useNavigate } from 'react-router-dom'
import { ChevronDown, LogOut, User } from 'lucide-react'
import { useApp } from '@/contexts/AppContext'
import { api, TOKEN_KEY } from '@/lib/api'
import { confirmDialog } from '@/lib/confirm'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

/** 右上角账号菜单：退出登录（自定义确认框） */
export default function UserMenu() {
  const { user } = useApp()
  const navigate = useNavigate()

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
        <DropdownMenuItem onClick={logout}>
          <LogOut className="mr-2 size-4" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
