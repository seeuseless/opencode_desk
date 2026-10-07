import { useEffect, useRef, useState } from "react"
import { NavLink, useLocation } from "react-router-dom"
import { ChevronDown, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** 导航项：带 to 为独立菜单项；带 items 为可折叠的二级分组；perm 为权限键（无权限不渲染） */
export type NavEntry = {
    label: string
    icon: LucideIcon
    to?: string
    end?: boolean
    perm?: string
    items?: NavEntry[]
}

const linkClass = (active: boolean) =>
    cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    )

export default function SideNav({ entries, onNavigate, storageKey }: { entries: NavEntry[]; onNavigate?: () => void; storageKey?: string }) {
    const { pathname } = useLocation()
    const navRef = useRef<HTMLElement>(null)
    // 记录用户手动折叠的分组；未记录时，当前页所在分组默认展开、其余折叠。storageKey 存在时跨会话记住
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
        if (!storageKey) return {}
        try { return JSON.parse(localStorage.getItem(storageKey) || '{}') } catch { return {} }
    })

    useEffect(() => {
        if (storageKey) localStorage.setItem(storageKey, JSON.stringify(collapsed))
    }, [collapsed, storageKey])

    // 菜单项多时记住滚动位置，刷新后回到原处而不是顶部
    useEffect(() => {
        const el = navRef.current
        if (el && storageKey) el.scrollTop = Number(localStorage.getItem(`${storageKey}_scroll`) || 0)
    }, [])
    const saveScroll = () => {
        if (storageKey && navRef.current) localStorage.setItem(`${storageKey}_scroll`, String(navRef.current.scrollTop))
    }

    const isItemActive = (e: NavEntry) => (e.end ? pathname === e.to : pathname.startsWith(e.to ?? ""))
    const isGroupActive = (e: NavEntry) => e.items?.some(isItemActive) ?? false
    const isOpen = (e: NavEntry) => !(collapsed[e.label] ?? !isGroupActive(e))

    // 路由变化时自动展开当前页所在分组
    useEffect(() => {
        const active = entries.find(isGroupActive)
        if (active) setCollapsed((c) => ({ ...c, [active.label]: false }))
    }, [pathname])

    const groups = entries.filter((e) => e.items)
    const allExpanded = groups.length > 0 && groups.every(isOpen)
    const toggleAll = () =>
        setCollapsed(Object.fromEntries(groups.map((g) => [g.label, allExpanded])))

    return (
        <nav ref={navRef} onScroll={saveScroll} className="flex-1 space-y-1 overflow-y-auto p-2">
            {entries.map((e, i) =>
                e.to ? (
                    <div key={e.to} className="flex items-center gap-1">
                        <NavLink to={e.to} end={e.end} onClick={onNavigate} className={({ isActive }) => cn(linkClass(isActive), "flex-1")}>
                            <e.icon className="size-4" />
                            {e.label}
                        </NavLink>
                        {/* 概览行右侧：一键展开/收起所有一级分组 */}
                        {i === 0 && groups.length > 0 && (
                            <button onClick={toggleAll} className="shrink-0 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                                {allExpanded ? "收起全部" : "展开全部"}
                            </button>
                        )}
                    </div>
                ) : (
                    <div key={e.label}>
                        <button
                            onClick={() => setCollapsed((c) => ({ ...c, [e.label]: isOpen(e) }))}
                            className={cn(
                                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                                isGroupActive(e) ? "text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                            )}
                        >
                            <e.icon className="size-4" />
                            <span className="flex-1 text-left">{e.label}</span>
                            <ChevronDown className={cn("size-3.5 transition-transform", isOpen(e) && "rotate-180")} />
                        </button>
                        {isOpen(e) && (
                            <div className="space-y-1 pb-1">
                                {e.items!.map((sub) => (
                                    <NavLink key={sub.to} to={sub.to!} end={sub.end} onClick={onNavigate} className={({ isActive }) => cn(linkClass(isActive), "pl-9")}>
                                        <sub.icon className="size-4" />
                                        {sub.label}
                                    </NavLink>
                                ))}
                            </div>
                        )}
                    </div>
                ),
            )}
        </nav>
    )
}
