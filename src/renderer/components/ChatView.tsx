import { useEffect, useRef, useState, type ReactNode } from 'react'
import hljs from 'highlight.js/lib/common'
import {
  AlertCircle, ArrowDown, Brain, Bot, Check, ChevronDown, ChevronRight, FileDiff, FilePlus, FileText,
  Folder, Globe, HelpCircle, ListChecks, LoaderCircle, Pencil, RotateCw, Search, Send, Sparkles,
  Square, Terminal, Trash2, Wrench, X
} from 'lucide-react'
import { oc, type MessageView, type ModelSel, type Part, type Session } from '../oc'
import type { ProviderCfg } from '../../../electron/main/types'
import { ModelPicker, type ModelGroup } from './ModelPicker'
import { Markdown } from './Markdown'
import type { Project } from './Sidebar'

interface Props {
  project?: Project
  sessionId: string
  model: string
  onModelChange: (key: string) => void
  settings: ProviderCfg[]
  /** 设置已加载完成（区分"提供商还没加载"与"真的没有提供商"，防止启动时清掉存档模型） */
  settingsReady: boolean
  /** 草稿首发：内核会话此刻才创建 */
  onDraftCreated: (s: Session) => void
  onRefreshSessions: () => void
  /** 上报某会话的处理中状态（多任务并行互不覆盖），侧栏任务行据此显示/移除加载图标 */
  onBusy: (sid: string, running: boolean) => void
  /** 自增信号：点 + / 点任务时自动聚焦输入框 */
  focusSignal: number
}

/** 'pid/mid' → ModelSel；'' → 跟随内核默认 */
function parseModel(key: string): ModelSel | undefined {
  if (!key) return undefined
  const i = key.indexOf('/')
  return { providerID: key.slice(0, i), modelID: key.slice(i + 1) }
}

/** 内核 todo 清单项（opencode todo.updated 事件） */
interface TodoItem {
  content: string
  status: string
  priority?: string
}

/** 上游错误 → 一句人话（错误条展示，不 dump 原始 JSON） */
function humanizeError(raw: string): string {
  if (/insufficient[_ ]credit|quota|balance|arrears|exceeded your current/i.test(raw)) return '账户额度不足或已欠费，请检查该提供商的余额。'
  if (/invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication/i.test(raw)) return 'API Key 无效或未通过认证，请到设置里检查该提供商的密钥。'
  if (/rate[_ ]?limit|too many requests|429/i.test(raw)) return '请求过于频繁，已被限流，请稍候片刻再试。'
  if (/model[_ ]not[_ ]found|does not exist|unknown model|unsupported model|provider.{0,20}not found/i.test(raw)) return '请求的模型在该端点不存在或不可用，请更换模型。'
  if (/timeout|timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(raw)) return '无法连接模型端点，请检查 Base URL 与网络。'
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw
}

export function ChatView(p: Props) {
  const [msgs, setMsgs] = useState<MessageView[]>([])
  const [input, setInput] = useState('')
  /** 处理中的会话集合：可能多任务并行（A 在跑，切去 B 又发一轮），每个会话独立记账 */
  const [busySet, setBusySet] = useState<Record<string, boolean>>({})
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [queue, setQueue] = useState<string[]>([])
  const [qCollapsed, setQCollapsed] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)

  const dirRef = useRef<string | undefined>(p.project?.path)
  const sidRef = useRef(p.sessionId)
  const texts = useRef<Map<string, string>>(new Map())
  const toolRaw = useRef<Map<string, string>>(new Map())
  const roles = useRef<Map<string, 'user' | 'assistant'>>(new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 本轮发送前已存在的消息 id：用于判断本轮是否已开始产出
  const turnBase = useRef<Set<string>>(new Set())
  // 打字机：partID → 已吐出的字符数；ticker 定时器；被插队的队列项下标
  const shown = useRef<Map<string, number>>(new Map())
  const ticker = useRef<number | null>(null)
  const hijack = useRef<number | null>(null)
  // 草稿首发创建的会话：跳过一次历史重载，避免闪掉乐观插入的用户消息
  const justCreated = useRef('')
  // 写入/编辑进行中的内容预览（partID → 已流出的文件内容）
  const [previews, setPreviews] = useState<Record<string, string>>({})
  // 本轮开发任务清单（todo.write / todo.updated 事件驱动，完成项中划线）
  const [todos, setTodos] = useState<TodoItem[]>([])
  // 内核自动重试提示（session.status retry 事件驱动，恢复出结果即清除）
  const [retryNote, setRetryNote] = useState('')

  dirRef.current = p.project?.path
  sidRef.current = p.sessionId

  /** 当前查看的会话是否在处理中——别的会话在跑时，这里必须是 false（不显示思考、不排队） */
  const busy = p.sessionId !== '' && !!busySet[p.sessionId]

  /** busySet 的同步镜像 + 修改入口：事件回调（effect 只注册一次）里要用最新值 */
  const busySetRef = useRef<Record<string, boolean>>({})
  /** 同理，onBusy prop 取最新引用，防事件闭包用到旧函数 */
  const onBusyRef = useRef(p.onBusy)
  onBusyRef.current = p.onBusy
  function markBusy(sid: string, running: boolean) {
    if (!sid) return
    const next = { ...busySetRef.current }
    if (running) next[sid] = true
    else delete next[sid]
    busySetRef.current = next
    setBusySet(next)
    onBusyRef.current(sid, running)
  }

  // 模型级联菜单：仅用户自建（启用）且配有模型的提供商，一级=提供商、二级=模型
  const groups: ModelGroup[] = p.settings
    .filter((x) => x.enabled && x.id && x.models.length)
    .map((c) => ({ id: c.id, label: c.name || c.id, models: c.models.map((m) => ({ mid: m })) }))

  // 无选中或选中已失效（提供商被停用/删除/模型被改）时，自动落到第一个可用模型。
  // 关键：设置尚未加载完成时绝不能跑校验——此刻 groups 为空，会把用户的存档值误判失效清掉。
  useEffect(() => {
    if (!p.settingsReady) return
    const i = p.model.indexOf('/')
    const valid =
      i > 0 && groups.some((g) => g.id === p.model.slice(0, i) && g.models.some((m) => m.mid === p.model.slice(i + 1)))
    if (!valid) p.onModelChange(groups[0] ? `${groups[0].id}/${groups[0].models[0].mid}` : '')
  }, [p.model, p.settings, p.settingsReady])

  // 切换项目/会话：先清旧内容再拉历史（项目切换瞬间 sessionId 为空）
  useEffect(() => {
    if (justCreated.current && justCreated.current === p.sessionId) {
      justCreated.current = ''
      return
    }
    texts.current.clear()
    toolRaw.current.clear()
    shown.current.clear()
    setPreviews({})
    setQueue([])
    setTodos([])
    setRetryNote('')
    if (!p.sessionId) {
      setMsgs([])
      setInput('')
      return
    }
    oc.messages(p.sessionId, p.project?.path)
      .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [p.sessionId, p.project?.path])

  // 订阅内核事件：token 级增量 + part 快照 + 会话空闲
  useEffect(() => {
    const off = window.qingniao.onEvent((raw) => {
      const e = raw as { type: string; properties: Record<string, unknown> }
      if (e.type === 'message.updated') {
        const info = e.properties.info as MessageView['info'] | undefined
        if (info) roles.current.set(info.id, info.role)
      } else if (e.type === 'message.part.delta') {
        const pr = e.properties as { sessionID: string; messageID: string; partID: string; field: string; delta: string }
        if (pr.sessionID !== sidRef.current) return
        if (pr.field === 'text' || pr.field === 'reasoning')
          setMsgs((prev) => appendDelta(prev, pr, texts.current, roles.current, shown.current, startTicker))
        else if (pr.field === 'input') {
          // 工具入参流：累积原始 JSON，抽取 content/command 做打字预览
          const rawStr = (toolRaw.current.get(pr.partID) ?? '') + pr.delta
          toolRaw.current.set(pr.partID, rawStr)
          const contentShown = extractToolContent(rawStr)
          if (contentShown) setPreviews((prev) => ({ ...prev, [pr.partID]: contentShown }))
        }
      } else if (e.type === 'message.part.updated') {
        const part = e.properties.part as Part
        if (part.sessionID !== sidRef.current) return
        if (part.type === 'tool' && part.state?.status !== 'running') {
          setPreviews((prev) => {
            if (!(part.id in prev)) return prev
            const next = { ...prev }
            delete next[part.id]
            return next
          })
        }
        setMsgs((prev) => applySnapshot(prev, part, texts.current, roles.current, shown.current, startTicker))
      } else if (e.type === 'todo.updated') {
        const pr = e.properties as { sessionID?: string; todos?: TodoItem[] }
        if (pr.sessionID !== sidRef.current) return
        setTodos(pr.todos ?? [])
      } else if (e.type === 'session.idle') {
        const idleSid = (e.properties as { sessionID?: string }).sessionID
        if (!idleSid || !busySetRef.current[idleSid]) return
        // 处理中的会话空闲：无论用户是否切走都要清该会话的 busy（防切回时残留"正在思考"）
        markBusy(idleSid, false)
        const isCurrent = idleSid === sidRef.current
        if (!isCurrent) return
        setTodos([])
        setRetryNote('')
        oc.messages(sidRef.current, dirRef.current)
          .then((list) => hydrate(list, shown.current, texts.current))
          .then((hydrated) => setMsgs(hydrated))
          .catch(() => { /* 事件流已展示内容 */ })
        p.onRefreshSessions()
      } else if (e.type === 'session.status') {
        // 内核自动重试（限流/断网）：只给当前会话一行可见提示，不吞 busy（本轮还在跑）
        const pr = e.properties as { sessionID?: string; status?: { type: string; message?: string } }
        if (pr.sessionID === sidRef.current && pr.status?.type === 'retry')
          setRetryNote(pr.status.message ? humanizeError(pr.status.message) : '连接模型失败，自动重试中…')
        else if (pr.sessionID && busySetRef.current[pr.sessionID]) setRetryNote('')
      } else if (e.type === 'qingniao.sse.reconnected') {
        // SSE 桥断线重连：断开期间可能漏掉 session.idle，busy 会话做一次轻量重同步
        for (const s of Object.keys(busySetRef.current)) {
          if (!s) continue
          oc.messages(s, s === sidRef.current ? dirRef.current : undefined)
            .then((list) => {
              // 该会话最后一条助手消息已有完整文本 → 视为已完成，清 busy
              const last = [...list].reverse().find((m) => m.info.role === 'assistant' && (m.parts.some((x) => x.type === 'text' && x.text)))
              if (last) markBusy(s, false)
            })
            .catch(() => {})
          if (s === sidRef.current) {
            setTodos([])
            oc.messages(s, dirRef.current)
              .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
              .catch(() => {})
          }
        }
      } else if (e.type === 'qingniao.kernel.unhealthy') {
        // 主进程自动重启内核后，本地 busy 状态全部失效，做一次整体重同步
        setError('内核连接异常，正在自动恢复…')
        for (const s of Object.keys(busySetRef.current)) markBusy(s, false)
        if (sidRef.current) {
          setTodos([])
          oc.messages(sidRef.current, dirRef.current)
            .then((list) => setMsgs(hydrate(list, shown.current, texts.current)))
            .catch(() => {})
        }
      } else if (e.type === 'session.error') {
        const pr = e.properties as { sessionID?: string; error?: { message?: string } }
        if (pr.sessionID && busySetRef.current[pr.sessionID]) markBusy(pr.sessionID, false)
        if (pr.sessionID !== sidRef.current) return
        const msg = pr.error?.message ?? '未知错误'
        setError(humanizeError(msg))
      }
    })
    return off
  }, [])

  // 打字机心跳：每帧把未吐完的 text part 匀速推进
  function startTicker() {
    if (ticker.current != null) return
    ticker.current = window.setInterval(() => {
      let pending = false
      texts.current.forEach((full, id) => {
        if ((shown.current.get(id) ?? 0) < full.length) pending = true
      })
      if (!pending) {
        if (ticker.current != null) { clearInterval(ticker.current); ticker.current = null }
        return
      }
      setMsgs((prev) =>
        prev.map((m) => {
          let changed = false
          const parts = m.parts.map((pt) => {
            if (pt.type !== 'text') return pt
            const full = texts.current.get(pt.id)
            if (full == null || pt.text === full) return pt
            const n0 = shown.current.get(pt.id) ?? 0
            const step = Math.max(2, Math.ceil((full.length - n0) / 6))
            const n = Math.min(full.length, n0 + step)
            shown.current.set(pt.id, n)
            changed = true
            return { ...pt, text: full.slice(0, n) }
          })
          return changed ? { ...m, parts } : m
        })
      )
    }, 24)
  }
  useEffect(() => () => { if (ticker.current != null) clearInterval(ticker.current) }, [])

  // 队列消费：本轮结束后自动发下一条；被"立即执行"插队的按下标优先
  useEffect(() => {
    if (busy || !queue.length) return
    let i = 0
    if (hijack.current != null) {
      i = Math.min(hijack.current, queue.length - 1)
      hijack.current = null
    }
    const text = queue[i]
    setQueue((q) => q.filter((_, k) => k !== i))
    runPrompt(text)
  }, [busy, queue])

  // 点新任务/点任务：光标自动落进输入框
  useEffect(() => {
    if (p.focusSignal > 0) taRef.current?.focus()
  }, [p.focusSignal])

  useEffect(() => {
    const el = scrollRef.current
    // 用户在往上翻时不打扰，贴底时才跟随
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [msgs, busy])

  function onMsgsScroll() {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = near
    setAtBottom(near)
  }

  function jumpBottom() {
    atBottomRef.current = true
    setAtBottom(true)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }

  // 执行中每秒累计用时
  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const t = setInterval(() => setElapsed((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  async function send() {
    const text = input.trim()
    if (!text) return
    setInput('')
    setError('')
    if (busy) {
      setQueue((q) => [...q, text])
      return
    }
    await runPrompt(text)
  }

  async function runPrompt(text: string) {
    let sid = p.sessionId
    if (!sid) {
      // 草稿：首次发送才真正创建会话；标题直接用用户这句话，避免 "New session - 时间戳"
      const title = text.length > 30 ? text.slice(0, 30) + '…' : text
      try {
        const s = await oc.createSession(p.project?.path, title)
        s.title = title
        sid = s.id
        sidRef.current = s.id
        justCreated.current = s.id
        p.onDraftCreated(s)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    markBusy(sid, true)
    atBottomRef.current = true
    setAtBottom(true)
    const tmpId = 'tmp-' + Date.now()
    turnBase.current = new Set(msgs.map((m) => m.info.id))
    const optimistic: MessageView = {
      info: { id: tmpId, role: 'user', sessionID: sid },
      parts: [{ id: tmpId + '-p', sessionID: sid, messageID: tmpId, type: 'text', text }]
    }
    setMsgs((prev) => [...prev, optimistic])
    try {
      await oc.prompt(sid, p.project?.path, text, parseModel(p.model))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      // 本轮所属会话置空闲（若 session.idle 已清过则幂等无副作用；仅当前仍停在本轮会话时清——
      // 队列插队已在本会话开新轮时不能误清新轮）
      if (sidRef.current === sid && busySetRef.current[sid]) markBusy(sid, false)
      // 已切走（新任务草稿/别的会话）：界面缓冲归切走时加载的新会话所有，绝不清理，避免盖掉正在流式的新任务
      if (sidRef.current !== sid) return
      toolRaw.current.clear()
      setPreviews({})
      try {
        const list = await oc.messages(sid, p.project?.path)
        setMsgs(hydrate(list, shown.current, texts.current))
        startTicker()
      } catch { /* 保留已渲染内容 */ }
    }
  }

  /** 队列项立即执行：中断当前任务，插队优先 */
  function queueSend(i: number) {
    if (busy && sidRef.current) {
      hijack.current = i
      oc.abort(sidRef.current).catch(() => { /* 已结束 */ })
    } else {
      const text = queue[i]
      setQueue((q) => q.filter((_, k) => k !== i))
      runPrompt(text)
    }
  }

  function queueEdit(i: number) {
    const text = queue[i]
    setQueue((q) => q.filter((_, k) => k !== i))
    setInput(text)
  }

  return (
    <main className="main">
      <div className="msgs" ref={scrollRef} onScroll={onMsgsScroll}>
        <div className="col">
          {error && (
            <div className="errbar">
              <AlertCircle size={14} /> <span>{error}</span>
              <button className="icon-btn" onClick={() => setError('')}>
                <X size={14} />
              </button>
            </div>
          )}
          {msgs.length === 0 && !busy && (
            <div className="empty">
              说出你的需求：写代码、查资料、整理文件都可以
              <br />
              任务在左侧项目文件夹内执行，模型可在下方切换。
            </div>
          )}
          {msgs.map((m, idx) =>
            m.info.role === 'user' ? (
              <UserBubble key={m.info.id} text={m.parts.filter((x) => x.type === 'text').map((x) => x.text).join('')} />
            ) : (
              <div key={m.info.id} className="amsg">
                {m.parts.map((part) => (
                  <PartView key={part.id} part={part} projectPath={p.project?.path} preview={previews[part.id]} />
                ))}
                {busy && idx === msgs.length - 1 && (
                  <span className="stream-dots"><i /><i /><i /></span>
                )}
              </div>
            )
          )}
          {busy && !msgs.some((m) => m.info.role === 'assistant' && !turnBase.current.has(m.info.id)) && (
            <div className="amsg busyline">
              <LoaderCircle size={13} className="spin" />
              正在思考，已用时 {fmtElapsed(elapsed)}
            </div>
          )}
          {busy && (
            <div className="busychip">
              <LoaderCircle size={11} className="spin" />
              <span>任务执行中 · {fmtElapsed(elapsed)}</span>
              {retryNote && <span className="retry-note">{retryNote}</span>}
              <button className="icon-btn" title="停止本轮" onClick={() => sidRef.current && oc.abort(sidRef.current).catch(() => {})}>
                <Square size={11} fill="currentColor" strokeWidth={0} />
              </button>
            </div>
          )}
          {todos.length > 0 && <TodoCard todos={todos} />}
        </div>
      </div>

      {!atBottom && (
        <div className="jumpwrap">
          <button className="jump" title="回到底部" onClick={jumpBottom}>
            <ArrowDown size={16} />
          </button>
        </div>
      )}

      {queue.length > 0 && (
        <div className="qbar">
          <div className="col">
            <button className="qhead" onClick={() => setQCollapsed((v) => !v)}>
              {qCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              任务队列 · {queue.length} 条
              <span className="q-sub">排队等当前任务完成</span>
            </button>
            {!qCollapsed &&
              queue.map((t, i) => (
                <div key={i} className="qitem" title={t}>
                  <span className="qi-no">{i + 1}</span>
                  <span className="qi-text">{t}</span>
                  <span className="qacts">
                    <button className="icon-btn" title="立即执行（中断当前任务）" onClick={() => queueSend(i)}>
                      <Send size={13} />
                    </button>
                    <button className="icon-btn" title="移回输入框编辑" onClick={() => queueEdit(i)}>
                      <Pencil size={13} />
                    </button>
                    <button className="icon-btn danger" title="删除" onClick={() => setQueue((q) => q.filter((_, k) => k !== i))}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="cwrap">
        <div className="cbox col">
          <textarea
            ref={taRef}
            className="ctext"
            value={input}
            rows={2}
            placeholder={busy ? '当前任务执行中，输入新需求可加入队列' : '说出你的需求，Enter 发送 / Shift+Enter 换行'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="crow">
            {/* 左端常驻当前项目名：让用户一眼知道这轮操作落在哪个文件夹 */}
            {p.project && (
              <span className="crow-proj" title={p.project.path}>
                <Folder size={13} />
                <span className="crow-proj-name">{p.project.name}</span>
              </span>
            )}
            <span className="spacer" />
            <ModelPicker groups={groups} value={p.model} onChange={p.onModelChange} />
            {busy ? (
              <button className="send-round" onClick={() => sidRef.current && oc.abort(sidRef.current)} title="停止本轮">
                <Square size={15} fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button className="send-round" disabled={!input.trim()} onClick={send} title="发送">
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

/**
 * 拉取的全量消息进入渲染前：登记全文进 texts，
 * 并把仍在打字的 part 截回当前已显示长度（其余直接显示）
 */
function hydrate(list: MessageView[], shown: Map<string, number>, texts: Map<string, string>): MessageView[] {
  for (const m of list) {
    for (const pt of m.parts) {
      if (pt.type === 'text' && pt.text) {
        texts.set(pt.id, pt.text)
        const n = shown.get(pt.id) ?? pt.text.length
        shown.set(pt.id, Math.min(n, pt.text.length))
      }
    }
  }
  return list.map((m) => ({
    ...m,
    parts: m.parts.map((pt) => {
      if (pt.type !== 'text' || !pt.text) return pt
      const n = shown.get(pt.id) ?? pt.text.length
      return n < pt.text.length ? { ...pt, text: pt.text.slice(0, n) } : pt
    })
  }))
}

/** message.part.delta：往对应 part 追加 token 增量（快照未到前先建占位） */
function appendDelta(
  list: MessageView[],
  pr: { sessionID: string; messageID: string; partID: string; field: string; delta: string },
  texts: Map<string, string>,
  roles: Map<string, 'user' | 'assistant'>,
  shown: Map<string, number>,
  ensureTicker: () => void
): MessageView[] {
  const full = (texts.get(pr.partID) ?? '') + pr.delta
  texts.set(pr.partID, full)
  ensureTicker()
  const n = shown.get(pr.partID) ?? 0
  // 类型判定：OpenCode 的 reasoning 增量 field 同样是 text，不能靠 field。
  // part.updated 快照（带权威 type）先于 delta 到达，命中已有 part 就沿用其类型；
  // 兜底 field 推断，避免快照未到时误把思维链打成正文。
  let type: string = pr.field === 'reasoning' ? 'reasoning' : 'text'
  for (const m of list) {
    const hit = m.parts.find((x) => x.id === pr.partID)
    if (hit) {
      type = hit.type
      break
    }
  }
  const part: Part = { id: pr.partID, sessionID: pr.sessionID, messageID: pr.messageID, type, text: full.slice(0, n) }
  return upsertPart(list, part, roles)
}

/** message.part.updated：parts 全量快照（登记全文，打字进度由 ticker 追） */
function applySnapshot(
  list: MessageView[],
  part: Part,
  texts: Map<string, string>,
  roles: Map<string, 'user' | 'assistant'>,
  shown: Map<string, number>,
  ensureTicker: () => void
): MessageView[] {
  let patched = part
  if (part.type === 'text') {
    texts.set(part.id, part.text ?? '')
    ensureTicker()
    const n = shown.get(part.id) ?? 0
    patched = n < (part.text?.length ?? 0) ? { ...part, text: (part.text ?? '').slice(0, n) } : part
  } else if (part.type === 'reasoning') {
    texts.set(part.id, part.text ?? '')
    ensureTicker()
    const n = shown.get(part.id) ?? 0
    patched = n < (part.text?.length ?? 0) ? { ...part, text: (part.text ?? '').slice(0, n) } : part
  }
  return upsertPart(list, patched, roles)
}

function upsertPart(
  list: MessageView[],
  part: Part,
  roles: Map<string, 'user' | 'assistant'>
): MessageView[] {
  const next = [...list]
  const mi = next.findIndex((m) => m.info.id === part.messageID)
  if (mi < 0) {
    next.push({
      info: { id: part.messageID, role: roles.get(part.messageID) ?? 'assistant', sessionID: part.sessionID },
      parts: [part]
    })
    return next
  }
  const msg = next[mi]
  const pi = msg.parts.findIndex((x) => x.id === part.id)
  next[mi] = {
    ...msg,
    parts: pi < 0 ? [...msg.parts, part] : msg.parts.map((x, i) => (i === pi ? part : x))
  }
  return next
}

/**
 * 折叠容器：内容超过 maxPx 高时收起，露出渐隐的尾部 + 「展开全文」。
 * 用实测高度判定（比字数/行数更准），内容变化时自动复测。
 */
function Collapsible({
  children,
  maxPx,
  forceText
}: {
  children: ReactNode
  /** 折叠阈值（px） */
  maxPx: number
  /** 判定用纯文本；不传则只看高度 */
  forceText?: string
}) {
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // 文本变化即复测（流式输出时先不高，长到超阈值才出现按钮）
  useEffect(() => {
    const el = ref.current
    if (el) setOver(el.scrollHeight > maxPx + 8)
  }, [forceText, maxPx])
  const clipped = over && !open
  return (
    <div className="cbl">
      <div
        ref={ref}
        className={clipped ? 'cbl-body clipped' : 'cbl-body'}
        style={clipped ? { maxHeight: maxPx } : undefined}
      >
        {children}
      </div>
      {over && (
        <button className="cbl-toggle" onClick={() => setOpen((v) => !v)}>
          <ChevronDown size={12} className={open ? 'up' : undefined} />
          {open ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  )
}

/** 用户消息气泡：超过 6 行自动折叠，点击展开全文 */
function UserBubble({ text }: { text: string }) {
  return (
    <div className="umsg">
      <div className="ubox">
        <Collapsible maxPx={150} forceText={text}>
          <div className="ubub">{text}</div>
        </Collapsible>
      </div>
    </div>
  )
}

/** 开发任务清单卡：todo.updated 驱动，完成项打勾 + 中划线，进行项转圈，序号 + 优先级标签 */
const PRIORITY_META: Record<string, { label: string; cls: string }> = {
  high: { label: '高', cls: 'high' },
  medium: { label: '中', cls: 'medium' },
  low: { label: '低', cls: 'low' },
}

function TodoCard({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todo-card">
      <div className="todo-head">
        <ListChecks size={13} />
        任务清单
        <span className="todo-prog">{done}/{todos.length}</span>
      </div>
      {todos.map((t, i) => {
        const p = PRIORITY_META[t.priority ?? 'medium']
        return (
          <div key={i} className={'todo-item ' + t.status}>
            <span className="todo-idx">{i + 1}</span>
            <span className="todo-box">
              {t.status === 'completed' ? (
                <Check size={13} />
              ) : t.status === 'in_progress' ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <span className="todo-dot" />
              )}
            </span>
            <span className="todo-text">{t.content}</span>
            <span className={'todo-pri ' + p.cls}>{p.label}</span>
          </div>
        )
      })}
    </div>
  )
}

/** OpenCode 工具名 → 中文标签与图标（按小写查找，兼容大小写变体） */
const TOOL_META: Record<string, { name: string; icon: ReactNode }> = {
  read: { name: '读取', icon: <FileText size={13} /> },
  write: { name: '写入', icon: <FilePlus size={13} /> },
  edit: { name: '编辑', icon: <Pencil size={13} /> },
  apply_patch: { name: '应用补丁', icon: <FileDiff size={13} /> },
  patch: { name: '应用补丁', icon: <FileDiff size={13} /> },
  bash: { name: '终端', icon: <Terminal size={13} /> },
  shell: { name: '终端', icon: <Terminal size={13} /> },
  execute: { name: '执行', icon: <Terminal size={13} /> },
  glob: { name: '查找文件', icon: <Search size={13} /> },
  grep: { name: '搜索内容', icon: <Search size={13} /> },
  codesearch: { name: '代码搜索', icon: <Search size={13} /> },
  webfetch: { name: '抓取网页', icon: <Globe size={13} /> },
  websearch: { name: '网络搜索', icon: <Globe size={13} /> },
  task: { name: '子任务', icon: <Bot size={13} /> },
  todowrite: { name: '待办清单', icon: <ListChecks size={13} /> },
  todo_write: { name: '待办清单', icon: <ListChecks size={13} /> },
  question: { name: '提问', icon: <HelpCircle size={13} /> },
  skill: { name: '技能', icon: <Sparkles size={13} /> },
  retry: { name: '重试', icon: <RotateCw size={13} /> },
  invalid: { name: '无效调用', icon: <AlertCircle size={13} /> }
}

/** 内核工具的英文系统消息 → 中文 */
function cnOutput(text: string): string {
  return text
    .replace(/^Edit applied successfully\.?/i, '编辑已应用。')
    .replace(/^Wrote file successfully\.?/i, '文件写入成功。')
    .replace(/^Update applied successfully\.?/i, '修改已应用。')
    .replace(/^Aborted\.?/i, '已中止。')
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 秒数 → 中文时长：1秒 / 45秒 / 1分20秒 */
function fmtElapsed(s: number): string {
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? `${m}分钟` : `${m}分${r}秒`
}

/** 从流式工具入参（JSON 片段，可能不完整）中抽出要展示的文本 */
function extractToolContent(raw: string): string {
  const m = /"(?:content|newString|new_string|command|text|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)
  if (!m) return ''
  let s = m[1]
  if (/(?:^|[^\\]\\{2\})*(\\{1,3}|\\u[0-9a-fA-F]{1,3})$/.test(s)) s = s.replace(/(\\{1,3}|\\u[0-9a-fA-F]{1,3})$/, '')
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
}

/** 文件扩展名 → highlight.js 语言 */
function extLang(file: string): string | undefined {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', php: 'php', rb: 'ruby', kt: 'kotlin', swift: 'swift',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sql: 'sql',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', env: 'properties', properties: 'properties',
    md: 'markdown', html: 'xml', xml: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less',
    sh: 'bash', bash: 'bash', bat: 'dos', cmd: 'dos', ps1: 'powershell', dockerfile: 'dockerfile',
    txt: 'plaintext', log: 'plaintext', proto: 'protobuf', graphql: 'graphql', lua: 'lua', r: 'r', dart: 'dart', scala: 'scala'
  }
  return map[ext]
}

/** 解析子任务（task）工具输出：剥掉 <task>/<task_result> XML 包装，只取正文 */
function parseTaskOutput(raw: string): string | null {
  const m = /<task_result>\n?([\s\S]*?)<\/task_result>/.exec(raw)
  return m ? m[1].trim() : null
}

/** 解析 read 工具输出：文件取 <content> 剥行号；目录取 <entries> 只列条目，剥掉 path/type 包装 */
function parseReadOutput(raw: string): { code: string; file?: string; list?: string[] } | null {
  const p = /<path>([^<]*)<\/path>/.exec(raw)
  const e = /<entries>\n?([\s\S]*?)\n?<[^\n]*entries>/i.exec(raw)
  if (e && !/<content>/i.test(raw)) {
    const lines = e[1].trim().split('\n').filter(Boolean)
    const list = lines.filter((l) => !/^\((\d+) entries?\)$/.test(l))
    return { code: '', file: p?.[1], list }
  }
  const c = /<content>\n?([\s\S]*?)<\/content>/.exec(raw)
  if (!c) return null
  const code = c[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\d{1,6}:(?=\s)\s?/, ''))
    .join('\n')
  return { code: code.trimEnd(), file: p?.[1] }
}

/** 目录条目视图：文件列表 + 数量 */
function DirList({ list, file }: { list: string[]; file?: string }) {
  return (
    <div className="step-list">
      <div className="step-list-head" title={file ?? ''}>{file ? relTarget(file) : '目录'} · {list.length} 项</div>
      {list.map((f) => (
        <div key={f} className="step-list-item" title={f}>{f}</div>
      ))}
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toolTarget(part: Part, projPath?: string): string {
  const inp = part.state?.input ?? {}
  // 子任务用 description，其余工具用各自的目标字段
  let raw = str(inp.description) || str(inp.filePath) || str(inp.path) || str(inp.command) || str(inp.pattern) || str(inp.url)
  // 兜底内核生成的英文摘要（如 "5 todos"）→ 中文化
  const t = str(part.state?.title)
  if (!raw) raw = /todos?/i.test(t) ? `${t.replace(/\s*todos?\.?/i, '条任务').trim()} 任务` : t
  const cut = raw.length > 90 ? raw.slice(0, 90) + '…' : raw
  return relTarget(cut, projPath)
}

/** 展示用：绝对路径裁剪为项目相对路径 */
function relTarget(s: string, projPath?: string): string {
  if (!s || !projPath) return s
  const base = projPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const n = s.replace(/\\/g, '/')
  if (n.toLowerCase().startsWith(base.toLowerCase() + '/')) return n.slice(base.length + 1)
  return s
}

function PartView({ part, projectPath, preview }: { part: Part; projectPath?: string; preview?: string }) {
  // 正文过长（代码大段粘贴/长回答）自动收起，点「展开全文」看全
  if (part.type === 'text' && part.text) {
    return (
      <Collapsible maxPx={520} forceText={part.text}>
        <Markdown text={part.text} />
      </Collapsible>
    )
  }
  if (part.type === 'reasoning') {
    return <StepLine icon={<Brain size={13} />} name="思考" status={part.text ? 'completed' : 'running'} body={<CodeBlock text={part.text ?? ''} />} />
  }
  if (part.type === 'tool') {
    const meta = TOOL_META[(part.tool ?? '').toLowerCase()] ?? { name: part.tool ?? '工具', icon: <Wrench size={13} /> }
    const st = part.state?.status ?? 'pending'
    const tool = (part.tool ?? '').toLowerCase()
    const rawOut = cnOutput(st === 'error' ? str(part.state?.error) : str(part.state?.output))
    let body: ReactNode
    if (rawOut && tool === 'read') {
      const parsed = parseReadOutput(rawOut)
      body = parsed?.list ? <DirList list={parsed.list} file={parsed.file} /> : parsed ? <CodeBlock text={parsed.code} file={parsed.file} /> : <CodeBlock text={rawOut} />
    } else if (rawOut && (tool === 'write' || tool === 'edit' || tool === 'patch' || tool === 'apply_patch')) {
      body = <CodeBlock text={rawOut} diff />
    } else if (rawOut && tool === 'task') {
      const inner = parseTaskOutput(rawOut)
      body = inner !== null ? <Markdown text={inner} /> : <CodeBlock text={rawOut} />
    } else if (rawOut) {
      body = <CodeBlock text={rawOut} />
    }
    return (
      <StepLine
        icon={meta.icon}
        name={meta.name}
        status={st}
        target={toolTarget(part, projectPath)}
        preview={preview}
        body={body}
      />
    )
  }
  return null
}

/** 一行式过程条目：图标 + 中文名 + 目标；running 时展示实时写入预览，详情默认折叠点击展开 */
/** 工具中文标签 → 进行时文案（running 状态下跟在名字后面的动词） */
function doingLabel(name: string): string {
  switch (name) {
    case '思考': return '正在思考'
    case '读取': return '正在读取'
    case '写入': case '编辑': case '应用补丁': return '正在写入'
    case '查找文件': case '搜索内容': case '代码搜索': return '正在搜索'
    case '终端': case '执行': return '正在执行'
    case '抓取网页': case '网络搜索': return '正在查询'
    case '子任务': return '正在执行子任务'
    case '待办清单': return '正在整理任务'
    default: return '进行中'
  }
}

function StepLine({
  icon,
  name,
  target,
  status,
  preview,
  body
}: {
  icon: ReactNode
  name: string
  target?: string
  status: string
  preview?: string
  body?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const expandable = !!body
  const running = status === 'running'
  const previewRef = useRef<HTMLPreElement>(null)

  // 预览内容增长时自动滚到底
  useEffect(() => {
    const el = previewRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [preview])

  return (
    <div className={'step' + (open ? ' open' : '') + (running ? ' running' : '')}>
      <button
        type="button"
        className="step-sum"
        disabled={!expandable}
        onClick={() => expandable && setOpen((v) => !v)}
      >
                <span className="step-icon">{running ? <LoaderCircle size={13} className="spin" /> : icon}</span>
        <span className="step-name">{name}</span>
        {running && <span className="step-doing">{doingLabel(name)}</span>}
        {target && <span className="step-target" title={target}>{target}</span>}
        {status === 'error' && <AlertCircle size={13} className="step-err" />}
        {expandable && <ChevronDown size={13} className={'step-chev' + (open ? ' up' : '')} />}
      </button>
      {running && preview && (
        <div className="step-preview">
          <pre ref={previewRef} className="step-preview-code">
            {preview}
          </pre>
          <span className="caret" />
        </div>
      )}
      {open && <div className="step-body">{body}</div>}
    </div>
  )
}

/** 展开详情代码块：diff 着色 / highlight.js 语法高亮 / 纯文本 */
function CodeBlock({ text, file, diff }: { text: string; file?: string; diff?: boolean }) {
  if (diff) {
    return (
      <pre className="step-code">
        {text.split('\n').map((l, i) => (
          <span key={i} className={l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : undefined}>
            {l}
            {'\n'}
          </span>
        ))}
      </pre>
    )
  }
  let html = escapeHtml(text)
  try {
    const lang = file ? extLang(file) : undefined
    if (text.length < 20000) {
      html = lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value
    }
  } catch {
    /* 高亮失败回退纯文本 */
  }
  return (
    <pre className="step-code">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}
