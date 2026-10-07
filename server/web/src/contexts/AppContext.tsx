import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { api, getToken } from "@/lib/api"

export interface User {
    id: number
    name: string
    email: string
    role: string
    avatar?: string | null
    two_factor_enabled?: boolean
    admin_group?: { id: number; name: string; is_super: boolean; permissions: string[] } | null
}

export interface Settings {
    mall_name?: string
    logo_url?: string
    footer_html?: string
    admin?: Record<string, string>
    privacy_mask?: boolean
    privacy_masked?: string[]
    mp_visible?: boolean
    apps_visible?: boolean
    [key: string]: unknown
}

interface AppState {
    user: User | null
    settings: Settings
    ready: boolean
    setUser: (u: User | null) => void
    refreshUser: () => Promise<void>
    reloadSettings: () => Promise<void>
}

const Ctx = createContext<AppState>(null as unknown as AppState)

export function useApp() {
    return useContext(Ctx)
}

export function AppProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null)
    const [settings, setSettings] = useState<Settings>({})
    const [ready, setReady] = useState(false)

    const reloadSettings = () => api<Settings>("/settings").then(setSettings).catch(() => {})

    const refreshUser = async () => {
        if (!getToken()) return
        const me = await api<User>("/auth/me")
        setUser(me)
    }

    useEffect(() => {
        const boot = async () => {
            reloadSettings()
            if (getToken()) {
                try {
                    await refreshUser()
                } catch {
                    /* token 失效时 api() 已跳转 */
                }
            }
            setReady(true)
        }
        boot()
    }, [])

    return (
        <Ctx.Provider value={{ user, settings, ready, setUser, refreshUser, reloadSettings }}>
            {children}
        </Ctx.Provider>
    )
}