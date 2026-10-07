import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, MessageSquarePlus, RefreshCw, Send, Square, WifiOff } from 'lucide-react'

/**
 * 手机端页面：{平台域名}/ide/device/{token}
 *
 * 不用登录——二维码里的 token 就是通行证，扫码即用。
 * 页面不直连电脑：所有指令发给平台，电脑每隔一秒来认领一次，
 * 所以手机在外面用流量也能操作家里那台机器。
 *
 * 只有两个页面：
 *   1. 项目列表：点项目展开它的任务，可新建任务；
 *   2. 聊天：打开任务即进来，底部选模型，发送/停止与电脑状态双向一致。
 *
 * 数据流有两条：指令走 rpc（请求-应答，拿项目/任务/历史），
 * 实时走 events（桌面端把内核事件推上来，手机上就能看着 AI 一个字一个字往外吐）。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 每个项目先摆几条任务：手机屏幕就那么高，一屏塞满反而找不到最新的那个 */
const TASKS_PAGE = 5

interface Task { id: string; title: string; updated: number; busy: boolean }
interface Msg { role: 'user' | 'assistant'; text: string }
interface Project { id: string; name: string; path: string }
interface ModelItem { key: string; providerID: string; modelID: string; label: string }

export default function IdeDevice() {
    const { token = '' } = useParams()
    const base = `/api/ide/device/${token}`

    const [boot, setBoot] = useState(true)
    const [fatal, setFatal] = useState('')
    const [owner, setOwner] = useState('')
    const [online, setOnline] = useState(false)

    const [view, setView] = useState<'projects' | 'chat'>('projects')
    const [projects, setProjects] = useState<Project[]>([])
    const [openPath, setOpenPath] = useState('')
    const [tasks, setTasks] = useState<Record<string, Task[]>>({})
    /** 每个项目当前露出多少条任务：点一次「加载更多」加 5 条（任务按最近更新排前，先看到的永远是最新的） */
    const [shownTasks, setShownTasks] = useState<Record<string, number>>({})
    const [busyMap, setBusyMap] = useState<Record<string, boolean>>({})

    const [cur, setCur] = useState<{ path: string; name: string; id: string; title: string } | null>(null)
    const [msgs, setMsgs] = useState<Msg[]>([])
    const [draft, setDraft] = useState('')
    const [models, setModels] = useState<ModelItem[]>([])
    const [model, setModel] = useState('')
    const [pickModel, setPickModel] = useState(false)
    const [sending, setSending] = useState(false)
    const [loadingMsgs, setLoadingMsgs] = useState(false)
    const [tip, setTip] = useState('')

    const cursor = useRef(0)
    const scrollRef = useRef<HTMLDivElement>(null)
    const curRef = useRef<typeof cur>(null)
    curRef.current = cur
    /** 事件回调里要用到的最新值：回调只注册一次，不能闭包住旧 state */
    const openPathRef = useRef('')
    openPathRef.current = openPath
    const loadTasksRef = useRef<(path: string) => Promise<void>>(async () => {})
    /** 事件回调只注册一次，读不到最新 state：发送态用 ref 镜像一份 */
    const sendingRef = useRef(false)
    sendingRef.current = sending
    const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 标签页标题：这个页面是「桌面任务」，不是后台（blade 里的默认标题是后台的名字）
    useEffect(() => {
        const prev = document.title
        document.title = '桌面任务'
        return () => { document.title = prev }
    }, [])

    /* ---------------- 通信：指令走 rpc，实时走 events ---------------- */

    const post = async <T,>(path: string, body?: unknown): Promise<T> => {
        const res = await fetch(base + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body ?? {}),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error((data as { message?: string })?.message || `HTTP ${res.status}`)
        return data as T
    }

    const get = async <T,>(path: string): Promise<T> => {
        const res = await fetch(base + path, { headers: { Accept: 'application/json' } })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error((data as { message?: string })?.message || `HTTP ${res.status}`)
        return data as T
    }

    /** 下发一条指令并等结果（电脑没响应就抛错，不无限等） */
    const rpc = useCallback(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        const { id } = await post<{ id: number }>('/rpc', { method, params })
        for (let i = 0; i < 160; i++) {
            await sleep(500)
            const r = await get<{ status: string; result: T; error: string | null }>(`/rpc/${id}`)
            if (r.status === 'done') return r.result
            if (r.status === 'failed') throw new Error(r.error || '执行失败')
        }
        throw new Error('电脑响应超时')
    }, [base])

    /* ---------------- 启动：拿落地信息 + 项目与模型 ---------------- */

    useEffect(() => {
        ;(async () => {
            try {
                const info = await get<{ device: { name: string; platform: string; online: boolean }; user: { name: string } }>('')
                setOwner(info.user?.name || '')
                setOnline(info.device.online)
                if (info.device.online) {
                    const [p, m] = await Promise.all([
                        rpc<{ projects: Project[] }>('projects.list'),
                        rpc<{ models: ModelItem[] }>('models.list'),
                    ])
                    setProjects(p.projects || [])
                    setModels(m.models || [])
                    setModel((m.models || [])[0]?.key || '')
                }
            } catch (e) {
                setFatal((e as Error).message)
            } finally {
                setBoot(false)
            }
        })()
    }, [rpc])

    /** 实时事件：桌面端把内核事件推给平台，这里按游标增量拉 */
    useEffect(() => {
        let alive = true
        const tick = async () => {
            while (alive) {
                try {
                    const r = await get<{ cursor: number; online: boolean; events: { type: string; payload: Record<string, unknown> }[] }>(
                        `/events?cursor=${cursor.current}`,
                    )
                    cursor.current = r.cursor
                    setOnline(r.online)
                    if (r.events.length) applyEvents(r.events)
                } catch {
                    /* 网络抖动：下一轮再说 */
                }
                await sleep(1200)
            }
        }
        tick()
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [base])

    /**
     * 事件落地：只认四类。
     *   session.busy    —— 电脑端对「哪个任务在跑」的判断，手机按钮状态跟着它走
     *                      （电脑上点了停止，这里也会收到 false，按钮自己变回「发送」）
     *   message.delta   —— AI 正在输出的文字增量，直接追加到当前聊天的最后一条助手消息上
     *   session.changed —— 电脑那边这个会话的内容变了（电脑上发的消息、AI 回复、工具输出），
     *                      去拉一次完整历史对齐；纯工具轮次没有文本增量，只靠 delta 会漏
     *   session.error   —— 电脑那边这一轮失败了（如模型没配好），提示出来并解除发送态
     */
    const applyEvents = (events: { type: string; payload: Record<string, unknown> }[]) => {
        for (const e of events) {
            const sid = String(e.payload.sessionID || '')
            if (e.type === 'session.busy' && sid) {
                const on = e.payload.busy === true
                setBusyMap((m) => ({ ...m, [sid]: on }))
                if (curRef.current?.id === sid) {
                    setSending(on)
                    // 状态一变就对齐一次：busy 亮起来要把电脑上刚发的那句话也带下来，
                    // 灭下去要用内核的完整消息校正尾部（流式事件可能丢几段）
                    scheduleReconcile()
                }
            } else if (e.type === 'message.delta' && sid && sid === curRef.current?.id) {
                const text = String(e.payload.text || '')
                if (!text) continue
                setMsgs((list) => {
                    const last = list[list.length - 1]
                    if (last && last.role === 'assistant') {
                        return [...list.slice(0, -1), { role: 'assistant', text: last.text + text }]
                    }
                    return [...list, { role: 'assistant', text }]
                })
            } else if (e.type === 'session.changed' && sid && sid === curRef.current?.id) {
                // 电脑那边内容变了：拉一次完整历史，电脑上发的消息、AI 的整段回复都能一次补齐。
                // 正在流式输出时不拉——文字增量已经在推了，再拉一遍纯属白费流量与电。
                if (!sendingRef.current) scheduleReconcile()
            } else if (e.type === 'session.error' && sid && sid === curRef.current?.id) {
                setTip(String(e.payload.message || '电脑那边执行失败'))
                setSending(false)
            } else if (e.type === 'sessions.changed') {
                // 电脑上新建/删除/改名了任务：重拉一次当前展开的项目
                const path = openPathRef.current
                if (path) void loadTasksRef.current(path)
            }
        }
    }

    /** 一轮结束后拉一次完整历史（防流式丢段），做一次去抖免得连拉好几次 */
    const scheduleReconcile = () => {
        if (reconcileTimer.current) clearTimeout(reconcileTimer.current)
        reconcileTimer.current = setTimeout(() => { void reconcile() }, 600)
    }

    const reconcile = async () => {
        const c = curRef.current
        // 草稿态（会话还没建）没有历史可对，别白跑一趟
        if (!c || !c.id) return
        try {
            const r = await rpc<{ messages: Msg[] }>('session.messages', { path: c.path, sessionId: c.id })
            if (r.messages?.length) setMsgs(r.messages)
        } catch {
            /* 校正失败无所谓，流式内容已经在了 */
        }
    }

    useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [msgs])

    /* ---------------- 项目 / 任务 ---------------- */

    const toggleProject = async (p: Project) => {
        if (openPath === p.path) { setOpenPath(''); return }
        setOpenPath(p.path)
        if (!tasks[p.path]) await loadTasks(p.path)
    }

    const loadTasks = async (path: string) => {
        try {
            const r = await rpc<{ tasks: Task[] }>('sessions.list', { path })
            const list = r.tasks || []
            setTasks((m) => ({ ...m, [path]: list }))
            setBusyMap((m) => {
                const next = { ...m }
                for (const t of list) next[t.id] = t.busy
                return next
            })
            // 电脑上改了任务名：聊天页顶部那行标题也跟着走，别停在旧名字上
            setCur((c) => {
                if (!c || c.path !== path || !c.id) return c
                const hit = list.find((t) => t.id === c.id)
                return hit && hit.title !== c.title ? { ...c, title: hit.title } : c
            })
        } catch (e) {
            setTip((e as Error).message)
        }
    }

    /** 打开任务：拉历史并直接进聊天页（点任务就是要说话，别让人再点一次） */
    /** 重拉项目清单（电脑上加了文件夹，手机上点一下就能同步过来） */
    const refreshProjects = async () => {
        if (!online) { setTip('电脑不在线'); return }
        try {
            const r = await rpc<{ projects: Project[] }>('projects.list')
            setProjects(r.projects || [])
        } catch (e) {
            setTip((e as Error).message)
        }
    }

    const openTask = async (p: Project, t: Task) => {
        setCur({ path: p.path, name: p.name, id: t.id, title: t.title })
        setMsgs([])
        setLoadingMsgs(true)
        setSending(!!busyMap[t.id])
        setView('chat')
        try {
            const r = await rpc<{ messages: Msg[] }>('session.messages', { path: p.path, sessionId: t.id })
            setMsgs(r.messages || [])
        } catch (e) {
            setTip((e as Error).message)
        } finally {
            setLoadingMsgs(false)
        }
    }

    /**
     * 新建任务：只开一张草稿，真的会话等第一条消息才建（与电脑上完全一致）。
     *
     * 早先是点一下就在电脑上建好会话、标题写死「手机新建的任务」，结果任务列表里
     * 一眼就能看出哪条是手机建的，而且那个名字跟任务内容毫无关系。
     * 现在标题就是用户发的那句话（截前 30 字），来源信息不再出现在任务名里。
     */
    const newTask = (p: Project) => {
        if (!online) { setTip('电脑不在线'); return }
        setOpenPath(p.path)
        setCur({ path: p.path, name: p.name, id: '', title: '新任务' })
        setMsgs([])
        setSending(false)
        setPickModel(false)
        setView('chat')
    }

    /** 新任务名：与电脑上同一口径——用户说的第一句话，超过 30 字截断 */
    const titleOf = (text: string) => {
        const one = text.replace(/\s+/g, ' ').trim()
        return one.length > 30 ? one.slice(0, 30) + '…' : one
    }

    /* ---------------- 发送 / 停止 ---------------- */

    const send = async () => {
        const text = draft.trim()
        if (!text || !cur || sending) return
        setDraft('')
        setMsgs((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '' }])
        setSending(true)
        try {
            let sid = cur.id
            // 草稿态（刚点「新建任务」还没说过话）：到这一刻才真的建会话，标题就用这句话。
            // 电脑上也是这么干的——空会话不落盘，落盘的标题就是首条消息。
            if (!sid) {
                const created = await rpc<{ task: Task }>('session.create', { path: cur.path, title: titleOf(text) })
                sid = created.task.id
                setCur((c) => (c ? { ...c, id: sid, title: created.task.title } : c))
            }
            const sel = models.find((x) => x.key === model)
            await rpc('session.send', {
                path: cur.path,
                sessionId: sid,
                text,
                ...(sel ? { model: { providerID: sel.providerID, modelID: sel.modelID } } : {}),
            })
            // 电脑已受理：内容靠事件流实时回来，什么时候算完由 session.busy 事件说了算
            void loadTasks(cur.path)
        } catch (e) {
            setTip((e as Error).message)
            setSending(false)
        }
    }

    const stop = async () => {
        if (!cur) return
        try {
            await rpc('session.stop', { path: cur.path, sessionId: cur.id })
        } catch (e) {
            setTip((e as Error).message)
        } finally {
            setSending(false)
            setBusyMap((m) => ({ ...m, [cur.id]: false }))
        }
    }

    const curModelLabel = useMemo(() => models.find((m) => m.key === model)?.label || '模型', [models, model])

    /* ---------------- 渲染 ---------------- */

    if (boot) {
        return <div className="flex min-h-screen items-center justify-center gap-2 bg-muted/40 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在连接电脑…</div>
    }
    if (fatal) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
                <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center">
                    <WifiOff className="mx-auto mb-2 size-6 text-muted-foreground" />
                    <div className="font-medium">链接打不开</div>
                    <p className="mt-1 text-sm text-muted-foreground">{fatal}</p>
                </div>
            </div>
        )
    }

    // 聊天页
    if (view === 'chat' && cur) {
        return (
            <div className="flex h-screen flex-col bg-background">
                <header className="flex items-center gap-2 border-b px-3 py-2">
                    <button className="rounded p-1 hover:bg-accent" onClick={() => { setView('projects'); setPickModel(false) }}>
                        <ArrowLeft className="size-5" />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{cur.title}</div>
                        <div className="truncate text-xs text-muted-foreground">{cur.name}</div>
                    </div>
                    <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => loadTasks(cur.path)} title="刷新任务">
                        <RefreshCw className="size-4" />
                    </button>
                </header>

                <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
                    {loadingMsgs && <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />拉取电脑上的聊天记录…</div>}
                    {!loadingMsgs && msgs.length === 0 && (
                        <div className="py-10 text-center text-sm text-muted-foreground">还没有内容，说点什么吧</div>
                    )}
                    {msgs.filter((m) => m.text !== '').map((m, i) => (
                        <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                            <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                                m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                            }`}>
                                {m.text}
                            </div>
                        </div>
                    ))}
                    {sending && msgs[msgs.length - 1]?.role !== 'assistant' && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />电脑正在处理…</div>
                    )}
                </div>

                {/* 底部：模型选择 + 输入 + 发送/停止（状态与电脑一致，双向） */}
                <div className="border-t px-3 pb-3 pt-2">
                    {pickModel && models.length > 0 && (
                        <div className="mb-2 max-h-[40vh] overflow-y-auto rounded-lg border bg-card p-1">
                            {models.map((m) => (
                                <button
                                    key={m.key}
                                    className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${m.key === model ? 'bg-accent' : ''}`}
                                    onClick={() => { setModel(m.key); setPickModel(false) }}
                                >
                                    <span className="truncate">{m.label}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {/* 一行三件，高度统一 40px（h-10 / min-h-10 / size-10）：输入框在最左，
                        模型选择跟在输入框后面，发送/停止压最右。三者一样高才不会看着歪。 */}
                    <div className="flex items-end gap-2">
                        <textarea
                            className="h-10 flex-1 resize-none rounded-2xl border bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                            rows={1}
                            placeholder={online ? '发消息给电脑上的青鸟…' : '电脑不在线'}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey && !/Mobi/i.test(navigator.userAgent)) {
                                    e.preventDefault()
                                    void send()
                                }
                            }}
                        />
                        <button
                            className="flex h-10 max-w-[7rem] shrink-0 items-center gap-1 rounded-full border px-3 text-xs text-muted-foreground disabled:opacity-40"
                            onClick={() => setPickModel((v) => !v)}
                            disabled={!models.length}
                        >
                            <span className="truncate">{curModelLabel}</span>
                            <ChevronDown className="size-3.5 shrink-0" />
                        </button>
                        {sending ? (
                            <button className="grid size-10 shrink-0 place-items-center rounded-full bg-destructive text-destructive-foreground" onClick={stop} title="停止">
                                <Square className="size-4" />
                            </button>
                        ) : (
                            <button
                                className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
                                onClick={send}
                                disabled={!draft.trim() || !online}
                                title="发送"
                            >
                                <Send className="size-4" />
                            </button>
                        )}
                    </div>
                </div>

                {tip && <Tip text={tip} onClose={() => setTip('')} />}
            </div>
        )
    }

    // 项目页
    return (
        <div className="min-h-screen bg-background">
            <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-4 py-3">
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">桌面任务</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={`inline-block size-1.5 shrink-0 rounded-full ${online ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
                        <span className="truncate">
                            {online ? '电脑在线' : '电脑不在线'}
                            {owner ? ` · ${owner}` : ''}
                            {projects.length > 0 ? ` · ${projects.length} 个项目` : ''}
                        </span>
                    </div>
                </div>
                <button className="shrink-0 rounded p-1.5 text-muted-foreground active:bg-accent" title="刷新项目" onClick={refreshProjects}>
                    <RefreshCw className="size-4" />
                </button>
            </header>

            <div className="p-3">
                {!online && (
                    <p className="mb-3 px-1 text-xs leading-relaxed text-muted-foreground">
                        电脑不在线：请确认电脑上的青鸟已打开、平台账号已登录、左栏手机面板里的开关已打开。
                    </p>
                )}

                {projects.length === 0 && online && (
                    <div className="py-10 text-center text-sm text-muted-foreground">电脑上还没有项目</div>
                )}

                {/* 全部项目装在一个容器里靠分隔线切分：每项各带一圈边框时，相邻两项的上下边框会并成两条线 */}
                {projects.length > 0 && (
                    <div className="divide-y overflow-hidden rounded-xl border bg-card">
                        {projects.map((p) => {
                            const open = openPath === p.path
                            const list = tasks[p.path] || []
                            const shown = shownTasks[p.path] ?? TASKS_PAGE
                            return (
                                <div key={p.path}>
                                    {/* 项目行整行可点（展开/收起），右侧「新建任务」是个独立按钮——嵌套 button 不合法，故行用 div */}
                                    <div className="flex w-full cursor-pointer items-center gap-2 px-3 py-3 text-left active:bg-accent" onClick={() => void toggleProject(p)}>
                                        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                                        {/* 新建任务放在项目行最右，且只在展开时出现：收着时点它等于「先展开再新建」，一步变两步 */}
                                        {open && (
                                            <button
                                                className="shrink-0 rounded p-1 text-primary"
                                                title="新建任务"
                                                onClick={(e) => { e.stopPropagation(); void newTask(p) }}
                                            >
                                                <MessageSquarePlus className="size-4" />
                                            </button>
                                        )}
                                    </div>

                                    {open && (
                                        <div className="divide-y border-t bg-muted/40">
                                            {list.length === 0 && <div className="py-3 pl-9 pr-4 text-xs text-muted-foreground">这个项目还没有任务</div>}
                                            {list.slice(0, shown).map((t) => (
                                                <button
                                                    key={t.id}
                                                    className="flex w-full items-center gap-2 py-3 pl-9 pr-4 text-left text-sm active:bg-accent"
                                                    onClick={() => void openTask(p, t)}
                                                >
                                                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                                                    {(busyMap[t.id] || t.busy) && (
                                                        <span className="flex shrink-0 items-center gap-1 text-xs text-primary">
                                                            <Loader2 className="size-3.5 animate-spin" />处理中
                                                        </span>
                                                    )}
                                                </button>
                                            ))}
                                            {list.length > shown && (
                                                <button
                                                    className="flex w-full items-center justify-center gap-1 py-2.5 text-xs text-muted-foreground active:bg-accent"
                                                    onClick={() =>
                                                        setShownTasks((m) => ({ ...m, [p.path]: (m[p.path] ?? TASKS_PAGE) + TASKS_PAGE }))
                                                    }
                                                >
                                                    <ChevronDown className="size-3.5" />
                                                    加载更多（还有 {list.length - shown} 个）
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            {tip && <Tip text={tip} onClose={() => setTip('')} />}
        </div>
    )
}

/** 底部轻提示：不做原生 alert，手机上也不该被弹窗打断 */
function Tip({ text, onClose }: { text: string; onClose: () => void }) {
    useEffect(() => {
        const t = setTimeout(onClose, 4000)
        return () => clearTimeout(t)
    }, [onClose])
    return (
        <div className="fixed inset-x-3 bottom-4 z-50 rounded-lg bg-foreground px-3 py-2 text-center text-xs text-background shadow-lg" onClick={onClose}>
            {text}
        </div>
    )
}
