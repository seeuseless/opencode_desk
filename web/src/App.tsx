import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AppProvider, useApp } from '@/contexts/AppContext'
import { getToken } from '@/lib/api'
import AdminLayout from '@/components/AdminLayout'
import Login from '@/pages/Login'
import IdeLogin from '@/pages/IdeLogin'
import IdeDevice from '@/pages/IdeDevice'
// Token Plan 后台：概况（模型可用性）/ 模型 / 上游 / 会员 / 用量
import Dashboard from '@/pages/admin/Dashboard'
import ModelHealth from '@/pages/admin/ModelHealth'
import Models from '@/pages/admin/Models'
import Upstreams from '@/pages/admin/Upstreams'
import UpstreamDetail from '@/pages/admin/UpstreamDetail'
import Members from '@/pages/admin/Members'
import MemberDetail from '@/pages/admin/MemberDetail'
import MailSettings from '@/pages/admin/MailSettings'
import { Toaster } from '@/components/ui/sonner'

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user } = useApp()
  if (!getToken()) return <Navigate to="/login" replace />
  if (user && user.role !== 'admin') return <Navigate to="/login" replace />
  return <>{children}</>
}

function Shell() {
  const { ready } = useApp()
  const [booted, setBooted] = useState(false)

  useEffect(() => {
    if (ready) setBooted(true)
  }, [ready])

  if (!booted) return null

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* 桌面端登录页：青鸟「登录」按钮在系统浏览器里打开的就是它，登录后发一次性授权码 */}
      <Route path="/ide/login" element={<IdeLogin />} />
      {/* 手机端页面：扫码打开，靠 URL 里的设备 token 鉴权，不走后台登录 */}
      <Route path="/ide/device/:token" element={<IdeDevice />} />
      <Route path="/admin" element={<AdminGuard><AdminLayout /></AdminGuard>}>
        <Route index element={<Dashboard />} />
        {/* Token Plan：概况 / 模型 / 上游 / 会员 */}
        <Route path="ai/health" element={<ModelHealth />} />
        <Route path="ai/models" element={<Models />} />
        <Route path="ai/upstreams" element={<Upstreams />} />
        <Route path="ai/upstreams/:id" element={<UpstreamDetail />} />
        <Route path="members" element={<Members />} />
        <Route path="members/:id" element={<MemberDetail />} />
        <Route path="mail" element={<MailSettings />} />
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Shell />
        <Toaster />
      </BrowserRouter>
    </AppProvider>
  )
}
