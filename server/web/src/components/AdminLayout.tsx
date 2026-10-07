import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Boxes, Coins, LayoutDashboard, type LucideIcon } from 'lucide-react'
import { useApp } from '@/contexts/AppContext'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import SideNav, { type NavEntry } from '@/components/SideNav'
import UserMenu from '@/components/UserMenu'
import ConfirmHost from '@/components/ConfirmHost'

/**
 * 后台布局。
 *
 * 精简范围：只留「概览 + Token Plan（概况/模型/上游/会员）」。
 * 权限组、小程序装修、应用市场、系统设置、协议管理、通知那几项都不做——
 * 本地一体化模式下平台是跟着桌面端走的，没有多管理员分权的需求。
 */
export default function AdminLayout() {
  const { settings } = useApp()
  const [navOpen, setNavOpen] = useState(false)

  const nav: NavEntry[] = [
    { to: '/admin', icon: LayoutDashboard, label: '概览', end: true },
    // Token Plan：平台对外的模型供给与会员计费，「概况 → 模型 → 上游 → 会员」是一条链
    {
      label: 'Token Plan',
      icon: Coins,
      items: [
        { to: '/admin/ai/health', icon: LayoutDashboard, label: '概况' },
        { to: '/admin/ai/models', icon: Boxes, label: '模型' },
        { to: '/admin/ai/upstreams', icon: Boxes, label: '上游' },
        { to: '/admin/members', icon: Boxes, label: '会员' }
      ]
    }
  ]

  return (
    <div className="flex h-screen">
      {navOpen && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setNavOpen(false)} />}
      <aside
        className={cn(
          'bg-card fixed inset-y-0 left-0 z-50 flex w-56 shrink-0 flex-col border-r transition-transform lg:static lg:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex items-center gap-2 h-14 px-4 border-b">
          {settings.logo_url ? (
            <img src={settings.logo_url} alt="logo" className="h-7 w-auto object-contain" />
          ) : (
            <div className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md">
              <Boxes className="size-4" />
            </div>
          )}
          <span className="font-semibold">{settings.mall_name || '青鸟平台'}</span>
        </div>
        <SideNav entries={nav} onNavigate={() => setNavOpen(false)} storageKey="admin_nav_collapsed" />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setNavOpen((v) => !v)}
            aria-label="菜单"
          >
            <LayoutDashboard className="size-4" />
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      <ConfirmHost />
    </div>
  )
}
