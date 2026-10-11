import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, Brain, ChevronDown, ChevronRight, Loader2, MessageSquarePlus, RefreshCw, Send, Square, WifiOff } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

/** 读展开状态等小存档；坏了就落默认值，绝不让它把整个页面带崩 */
function readStore<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key)
        return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
        return fallback
    }
}

function writeStore(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {
        /* 隐私模式下写不进去就算了，只是下次进来不记得展开状态 */
    }
}

/** 每个项目先摆几条任务：手机屏幕就那么高，一屏塞满反而找不到最新的那个 */
const TASKS_PAGE = 5

interface Task { id: string; title: string; updated: number; busy: boolean }
/**
 * 手机端显示的一条消息：一个角色 + 若干 part。
 *
 * 早先这里只有 `{ role, text }`（正文拍平），结果手机上只看得到最终答复，
 * 思考过程和工具调用（点元素、读文件、跑命令）全没了——同一段对话手机和桌面
 * 看到的是两回事。现在跟桌面一样按 part 渲染，`思考` 折叠块与步骤行才有。
 */
interface Msg { role: 'user' | 'assistant'; parts: Part[] }

interface Part {
  id: string
  type: 'text' | 'reasoning' | 'tool'
  /** 正文 / 思考的文本 */
  text?: string
  /** 工具名 */
  tool?: string
  /** 工具状态：pending / running / completed / error */
  status?: string
  /** 工具入参摘要（路径 / 命令 / URL / 选择器…） */
  detail?: string
}

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
    // 展开状态从 localStorage 起步：刷新/重进页面后还停在原来那个项目上，
    // 不用每次都重新点一遍展开才能看到自己在盯哪个任务
    const [openPath, setOpenPath] = useState(() => readStore('qn.openPath', ''))
    const [tasks, setTasks] = useState<Record<string, Task[]>>({})
    /** 每个项目当前露出多少条任务：点一次「加载更多」加 5 条（任务按最近更新排前，先看到的永远是最新的） */
    const [shownTasks, setShownTasks] = useState<Record<string, number>>(() => readStore('qn.shownTasks', {}))
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
    /** syncTasks 要读最新的 tasks/online（事件回调只注册一次，闭包里的都是旧的） */
    const tasksRef = useRef<Record<string, Task[]>>({})
    tasksRef.current = tasks
    const onlineRef = useRef(online)
    onlineRef.current = online
    /** 待重拉的任务列表：攒一批再发，避免电脑上一轮改好几次就打出一串请求 */
    const pendingSync = useRef<Set<string>>(new Set())
    const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 标签页标题：这个页面是「桌面任务」，不是后台（blade 里的默认标题是后台的名字）
    useEffect(() => {
        const prev = document.title
        document.title = '桌面任务'
        return () => { document.title = prev }
    }, [])

    // 软键盘适配：iOS Safari 键盘弹出不缩 100dvh，底部输入栏会被键盘盖住（得滚动才能看到）。
    // 用 visualViewport 的可视高度驱动 --qn-vvh（配合 index.css 的 .qn-viewport 优先级），
    // 键盘弹出/收起、地址栏收放都实时跟随；安卓走 meta 的 interactive-widget=resizes-content。
    useEffect(() => {
        const vv = window.visualViewport
        if (!vv) return
        const apply = () => document.documentElement.style.setProperty('--qn-vvh', vv.height + 'px')
        apply()
        vv.addEventListener('resize', apply)
        vv.addEventListener('scroll', apply)
        return () => {
            vv.removeEventListener('resize', apply)
            vv.removeEventListener('scroll', apply)
            document.documentElement.style.removeProperty('--qn-vvh')
        }
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
                    // 记住的那个项目顺手把任务列表拉起来：进来就停在原处、列表也是热的，
                    // 不用再点一次展开。路径可能已不存在（电脑上删了项目），对不上就当没记过。
                    const remembered = openPathRef.current
                    if (remembered && (p.projects || []).some((x) => x.path === remembered)) {
                        void loadTasksRef.current(remembered)
                    } else if (remembered) {
                        setOpenPath('')
                        writeStore('qn.openPath', '')
                    }
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
                let got = 0
                try {
                    const r = await get<{ cursor: number; online: boolean; events: { type: string; payload: Record<string, unknown> }[] }>(
                        `/events?cursor=${cursor.current}`,
                    )
                    cursor.current = r.cursor
                    setOnline(r.online)
                    got = r.events.length
                    if (got) applyEvents(r.events)
                } catch {
                    /* 网络抖动：下一轮再说 */
                }
                // 服务端是**短长轮询**：没事件时请求会挂着，直到电脑上真有了变化才返回。
                // 所以「拿到了事件」几乎零延迟，只有连不上时才会走到 sleep 兜底。
                // 拿到事件后不睡：正是一串事件要连着处理完，睡一下反倒平白加延迟。
                if (!got) await sleep(400)
            }
        }
        tick()
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [base])

    /**
     * 事件落地：只认这几类。
     *   session.busy    —— 电脑端对「哪个任务在跑」的判断，手机按钮状态跟着它走
     *                      （电脑上点了停止，这里也会收到 false，按钮自己变回「发送」）
     *   message.delta   —— AI 正在输出的文字增量，直接追加到当前聊天的最后一条助手消息上
     *   session.changed —— 电脑那边这个会话的内容变了（电脑上发的消息、AI 回复、工具输出），
     *                      去拉一次完整历史对齐；纯工具轮次没有文本增量，只靠 delta 会漏
     *   session.error   —— 电脑那边这一轮失败了（如模型没配好），提示出来并解除发送态
     *   sessions.changed—— 电脑上新建/删除/改名了任务，重拉对应项目的任务列表
     *   projects.changed—— 电脑上项目清单变了，重拉项目列表
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
                    // 增量只往「最后一条助手消息的最后一个正文 part」上追加。
                    // 桌面端已经把思考的增量过滤掉了（主进程按 partID 判类型），
                    // 所以这里收到的必然是正文，直接追加即可。
                    if (last && last.role === 'assistant') {
                        const parts = [...last.parts]
                        const tail = parts[parts.length - 1]
                        if (tail && tail.type === 'text') parts[parts.length - 1] = { ...tail, text: (tail.text ?? '') + text }
                        else parts.push({ id: '', type: 'text', text })
                        return [...list.slice(0, -1), { role: 'assistant', parts }]
                    }
                    return [...list, { role: 'assistant', parts: [{ id: '', type: 'text', text }] }]
                })
            } else if (e.type === 'session.changed' && sid && sid === curRef.current?.id) {
                // 电脑那边内容变了：拉一次完整历史，电脑上发的消息、AI 的整段回复都能一次补齐。
                // 正在流式输出时不拉——文字增量已经在推了，再拉一遍纯属白费流量与电。
                if (!sendingRef.current) scheduleReconcile()
            } else if (e.type === 'session.error' && sid && sid === curRef.current?.id) {
                setTip(String(e.payload.message || '电脑那边执行失败'))
                setSending(false)
            } else if (e.type === 'sessions.changed') {
                syncTasks(String(e.payload.directory || ''))
            } else if (e.type === 'projects.changed') {
                void refreshProjects()
            }
        }
    }

    /** 一轮结束后拉一次完整历史（防流式丢段），做一次去抖免得连拉好几次 */
    const scheduleReconcile = () => {
        if (reconcileTimer.current) clearTimeout(reconcileTimer.current)
        reconcileTimer.current = setTimeout(() => { void reconcile() }, 400)
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

    /**
     * 电脑上任务有增删改名 → 重拉任务列表。
     *
     * 早先只重拉「手机上正展开着的那一个项目」，于是电脑上往别的项目里新建任务，
     * 手机这边完全没反应——用户看着就是「不同步」。现在按事件里带的 directory
     * 精确重拉；内核没给目录（老事件形状）就退回「所有已经拉过的项目都重来一遍」。
     *
     * 攒 300ms 再发：电脑上一轮对话里连续改好几次是常事，逐条重拉会打成请求风暴，
     * 而 300ms 对「实时」来说察觉不到。
     */
    const syncTasks = (dir: string) => {
        if (!onlineRef.current) return
        for (const p of dir ? [dir] : Object.keys(tasksRef.current)) {
            pendingSync.current.add(p)
        }
        if (syncTimer.current) clearTimeout(syncTimer.current)
        syncTimer.current = setTimeout(() => {
            const paths = [...pendingSync.current]
            pendingSync.current.clear()
            for (const p of paths) void loadTasksRef.current(p)
        }, 300)
    }

    const toggleProject = async (p: Project) => {
        if (openPath === p.path) { setOpenPath(''); writeStore('qn.openPath', ''); return }
        setOpenPath(p.path)
        writeStore('qn.openPath', p.path)
        if (!tasks[p.path]) await loadTasks(p.path)
    }

    const loadTasks = async (path: string) => {
        try {
            const r = await rpc<{ tasks: Task[] }>('sessions.list', { path })
            const list = r.tasks || []
            setTasks((m) => ({ ...m, [path]: list }))
            // 存一份到 ref：syncTasks 在事件回调里要用最新的 tasks 表，
            // 而回调只注册一次，直接闭包捕获的会是首帧那份空对象。
            tasksRef.current = { ...tasksRef.current, [path]: list }
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
    // 把 loadTasks 挂到 ref 上给事件回调用。
    // 位置很关键：**必须**在 loadTasks 定义之后——它是 const，提前赋值会撞 TDZ，
    // 页面直接白屏（Cannot access before initialization）。
    // 少了这一行则相反：syncTasks 调的是 ref 初始那个空壳，事件收到了列表却不动。
    loadTasksRef.current = loadTasks

    /** 打开任务：拉历史并直接进聊天页（点任务就是要说话，别让人再点一次） */
    /** 重拉项目清单（电脑上加了文件夹，手机上点一下就能同步过来） */
    const refreshProjects = async () => {
        // onlineRef：事件回调里也会调它，而事件回调只注册一次，闭包里的 online 是首帧那个 false
        if (!onlineRef.current) { setTip('电脑不在线'); return }
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
        setMsgs((m) => [
            ...m,
            { role: 'user', parts: [{ id: '', type: 'text', text }] },
            { role: 'assistant', parts: [] },
        ])
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
            /* qn-viewport = 100dvh（见 index.css）：高度跟着地址栏/软键盘实时变，
               底部的输入栏才不会被顶到折叠线以下。overflow-hidden 是不许整页滚动——
               页面本身固定，只有中间的消息流该滚。 */
            <div className="qn-viewport flex flex-col overflow-hidden bg-background">
                <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
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

                {/* min-h-0：flex 列里的默认 min-height:auto 会让这一段不肯缩到内容以下，
                    消息一多就会把底部输入栏顶出屏幕（那正是要修的那个毛病）。 */}
                <div ref={scrollRef} className="qn-hide-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
                    {loadingMsgs && <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />拉取电脑上的聊天记录…</div>}
                    {!loadingMsgs && msgs.length === 0 && (
                        <div className="py-10 text-center text-sm text-muted-foreground">还没有内容，说点什么吧</div>
                    )}
                    {/* 按 part 渲染，与桌面同构：正文走 markdown，思考是折叠块，工具是步骤行。
                        助手消息整条不套气泡底色——工具/思考是过程，正文才是答复，
                        套一整块底色会让人以为整条都是回复（同桌面的排版口径）。 */}
                    {msgs.filter((m) => m.parts.length > 0).map((m, i) =>
                        m.role === 'user' ? (
                            <div key={i} className="flex justify-end">
                                <div className="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
                                    {m.parts.map((pt, k) =>
                                        pt.type === 'text' ? (
                                            // 用户自己发的是纯文本，按原样显示（走 markdown 反而会吃掉
                                            // 「*」「_」这类字符，聊天里打星号很常见）
                                            <span key={k} className="whitespace-pre-wrap break-words">{pt.text}</span>
                                        ) : null,
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div key={i} className="flex flex-col gap-1.5">
                                {m.parts.map((pt, k) => (
                                    <PartView key={pt.id || k} part={pt} />
                                ))}
                            </div>
                        ),
                    )}
                    {sending && msgs[msgs.length - 1]?.parts.length === 0 && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />电脑正在处理…</div>
                    )}
                </div>

                {/* 底部：模型选择 + 输入 + 发送/停止（状态与电脑一致，双向）。
                    shrink-0：消息流再长也不许把它压扁；qn-safe-bottom 给手势条让位。 */}
                <div className="qn-safe-bottom shrink-0 border-t px-3 pb-3 pt-2">
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
                        模型选择跟在输入框后面，发送/停止压最右。三者一样高才不会看着歪。
                        min-w-0 是关键：flex 子项默认 min-width:auto，textarea 会被自身
                        固有宽度（cols 默认值）撑住不肯缩，把右边的发送按钮挤出屏幕。 */}
                    <div className="flex items-end gap-2">
                        <textarea
                            className="h-10 min-w-0 flex-1 resize-none rounded-2xl border bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
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
                            className="flex h-10 max-w-[6rem] shrink-0 items-center gap-1 rounded-full border px-3 text-xs text-muted-foreground disabled:opacity-40"
                            onClick={() => setPickModel((v) => !v)}
                            disabled={!models.length}
                            title={curModelLabel}
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

    // 项目页。overflow-x-hidden：手机上有内容（长任务名、宽表格）超宽时，
        // 页面会横向晃一下，用户得左右拖才能看全——这里一律掐掉，只让该滚的地方滚。
        return (
            <div className="min-h-screen overflow-x-hidden bg-background">
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
                {/* 原来这里有个「刷新项目」按钮，现在去掉了：
                    列表已经是实时的（电脑上项目增删改会推 projects.changed，
                    任务增删改推 sessions.changed），这个按钮除了让人误以为
                    「不点它就不刷新」，没有任何实际作用。 */}
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
                                                        setShownTasks((m) => {
                                                            const next = { ...m, [p.path]: (m[p.path] ?? TASKS_PAGE) + TASKS_PAGE }
                                                            writeStore('qn.shownTasks', next)
                                                            return next
                                                        })
                                                    }
                                                >
                                                    <ChevronDown className="size-3.5" />
                                                    加载更多
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

/**
 * 工具显示名 —— 与桌面 ChatView 的 TOOL_META 保持同一套叫法。
 *
 * 只搬「名字」，不搬图标：桌面那套每个条目配一个 lucide 图标，几十个图标打进手机包体
 * 不划算；手机用一个小圆点表示工具，靠文字区分。改了桌面那边记得同步这里。
 *
 * 内置 MCP 的工具名带 server 前缀（panel_、media_、vision_…），见桌面端 TOOL_META 注释。
 */
const TOOL_NAMES: Record<string, string> = {
    read: '读取', write: '写入', edit: '编辑', apply_patch: '应用补丁', patch: '应用补丁',
    bash: '终端', shell: '终端', execute: '执行',
    glob: '查找文件', grep: '搜索内容', codesearch: '代码搜索',
    webfetch: '抓取网页', websearch: '网络搜索',
    task: '子任务', todowrite: '待办清单', todo_write: '待办清单',
    question: '提问', skill: '技能', retry: '重试', invalid: '无效调用',
    media_generate_image: '生成图片', media_create_video: '生成视频', media_check_video: '查视频任务',
    music_generate_music: '生成音乐', music_check_music: '查音乐任务',
    tts_generate_speech: '配音', asr_transcribe_audio: '听写',
    vision_describe_image: '识图',
    panel_navigate: '浏览器导航', panel_snapshot: '页面快照',
    panel_click: '点击元素', panel_type: '元素输入',
}

function toolName(tool: string): string {
    return TOOL_NAMES[tool.toLowerCase()] ?? (tool || '工具')
}

/**
 * 一个 part 的手机端呈现。
 *
 * 三种形态与桌面一一对应：
 *   正文     → markdown（AI 输出大量是标题/列表/表格/代码块）
 *   思考     → 默认折叠的一行「思考」，点开看全文（桌面默认收起，手机屏幕更小同理）
 *   工具调用 → 一行步骤：名字 + 摘要（路径/命令/选择器）+ 状态点
 */
function PartView({ part }: { part: Part }) {
    const [open, setOpen] = useState(false)

    if (part.type === 'reasoning') {
        if (!part.text?.trim()) return null
        return (
            <div className="rounded-lg border bg-muted/40">
                <button
                    className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground"
                    onClick={() => setOpen((v) => !v)}
                >
                    <Brain className="size-3.5 shrink-0" />
                    <span>思考</span>
                    <span className="truncate">{open ? '' : part.text!.slice(0, 40)}</span>
                    {open ? <ChevronDown className="ml-auto size-3.5 shrink-0" /> : <ChevronRight className="ml-auto size-3.5 shrink-0" />}
                </button>
                {open && (
                    <div className="border-t px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                        {part.text}
                    </div>
                )}
            </div>
        )
    }

    if (part.type === 'tool') {
        const st = part.status ?? 'pending'
        const dot =
            st === 'running' ? 'bg-amber-500 animate-pulse'
            : st === 'error' ? 'bg-destructive'
            : st === 'completed' ? 'bg-emerald-500'
            : 'bg-muted-foreground/50'
        const label = st === 'running' ? '进行中' : st === 'error' ? '失败' : st === 'completed' ? '完成' : '等待'
        return (
            <div className="flex items-center gap-2 px-0.5 text-xs text-muted-foreground">
                <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
                <span className="shrink-0">{toolName(part.tool ?? '')}</span>
                {part.detail && <span className="truncate font-mono text-[11px] opacity-70">{part.detail}</span>}
                <span className="ml-auto shrink-0">{label}</span>
            </div>
        )
    }

    // 正文与桌面同口径：**不套气泡底色**（正文是答复本身，桌面 ChatView 就是白底直排），
    // 宽度占满消息列——套灰气泡会让人误以为这是引用/备注，也和桌面看起来不一样。
    return (
        <div className="qn-md w-full break-words text-sm leading-relaxed">
            <Markdown remarkPlugins={[remarkGfm]}>{part.text ?? ''}</Markdown>
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
