/**
 * 模拟桌面端：登录 → 注册设备 → 轮询认领手机 rpc → 执行 → 回结果，并按桌面 relay 的口径上报事件。
 * 用途：本地起服务后跑它，手机页面（/ide/device/{token}）就能全流程实测。
 */
const BASE = 'http://127.0.0.1:35011'
const EMAIL = 'real@local.test'
const PASS = 'root123456'

const post = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {})
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path}: ${data?.message || res.status}`)
  return data
}

// 1. 登录（空库时走初始化窗口注册）
let login
try {
  login = await post('/api/auth/login', { email: EMAIL, password: PASS })
} catch {
  login = await post('/api/auth/register', { email: EMAIL, password: PASS, name: '超管' })
}
console.log('[fake-desk] 登录成功')

// 2. 注册设备
const dev = await post('/api/ide/desk/register', { name: '模拟桌面 · 测试机', platform: 'Windows' }, login.token)
console.log('[fake-desk] 设备已注册，手机页地址:', BASE + dev.path)

// 3. 状态：两个项目、每个项目几条任务、一个完整会话的历史
const projects = [
  { id: 'p1', path: 'D:/demo/web', name: 'web 商城' },
  { id: 'p2', path: 'D:/demo/api', name: 'api 服务' }
]
let taskSeq = 3
const tasks = {
  'D:/demo/web': [
    { id: 's1', title: '优化首页加载速度', updated: Date.now() - 3600e3, busy: false },
    { id: 's2', title: '修复购物车数量不刷新', updated: Date.now() - 86400e3, busy: false },
    { id: 's3', title: '接入新的支付渠道', updated: Date.now() - 2 * 86400e3, busy: false },
    { id: 's4', title: '重构用户中心页面', updated: Date.now() - 3 * 86400e3, busy: false },
    { id: 's5', title: '排查白屏问题', updated: Date.now() - 4 * 86400e3, busy: false },
    { id: 's6', title: '整理组件库文档', updated: Date.now() - 5 * 86400e3, busy: false },
    { id: 's7', title: '升级依赖版本', updated: Date.now() - 6 * 86400e3, busy: false }
  ],
  'D:/demo/api': [{ id: 's10', title: '补齐订单导出接口', updated: Date.now() - 7200e3, busy: false }]
}
const histories = {
  s1: [
    { role: 'user', parts: [{ id: 'u1', type: 'text', text: '首页首屏要 4 秒才出来，帮我查一下为什么这么慢，最好能压到 1 秒以内' }] },
    {
      role: 'assistant',
      parts: [
        { id: 'r1', type: 'reasoning', text: '用户反馈首屏 4 秒。常见原因：包体积过大、无代码分割、图片未压缩、接口串行。先看构建产物与网络瀑布。' },
        { id: 'r2', type: 'tool', tool: 'read', status: 'completed', detail: 'src/main.tsx' },
        { id: 'r3', type: 'tool', tool: 'bash', status: 'completed', detail: 'npm run build && du -sh dist' },
        { id: 'r4', type: 'text', text: '查完了，**首屏慢有三个原因**，按影响从大到小：\n\n## 1. 路由没做代码分割\n`main.tsx` 一次性 import 了全部页面，首屏就要下载 1.8MB 的 JS。改成 `React.lazy` 后只有 320KB。\n\n## 2. 首页大图没压缩\n`hero.png` 有 4.2MB，转 WebP 并压到 180KB，肉眼无差。\n\n## 3. 首屏接口串行\n用户信息和公告是顺序请求的，改成 `Promise.all` 并行。\n\n改完后的效果:\n\n| 指标 | 之前 | 之后 |\n| --- | --- | --- |\n| 首屏时间 | 4.1s | 0.9s |\n| JS 体积 | 1.8MB | 320KB |\n\n```ts\nconst Home = lazy(() => import(\'./pages/Home\'))\nconst [user, notice] = await Promise.all([fetchUser(), fetchNotice()])\n```\n\n要我直接把这三种改法落到代码里吗？' }
      ]
    },
    { role: 'user', parts: [{ id: 'u2', type: 'text', text: '改吧，顺便把路由都分割了' }] },
    {
      role: 'assistant',
      parts: [
        { id: 'r5', type: 'tool', tool: 'edit', status: 'completed', detail: 'src/main.tsx' },
        { id: 'r6', type: 'tool', tool: 'edit', status: 'completed', detail: 'src/router/index.ts' },
        { id: 'r7', type: 'text', text: '已全部改完：路由懒加载、图片压缩脚本、首屏并行请求，本地构建通过。' }
      ]
    }
  ]
}

// 4. 轮询认领
const events = []
const pushEvent = (type, payload) => events.push({ type, payload })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runRpc(rpc) {
  const p = rpc.params ?? {}
  switch (rpc.method) {
    case 'projects.list':
      return { projects }
    case 'models.list':
      return { models: [{ key: 'glm:glm-4.7', providerID: 'glm', modelID: 'glm-4.7', label: 'GLM-4.7' }] }
    case 'sessions.list':
      return { tasks: tasks[p.path] || [] }
    case 'session.messages':
      return { messages: histories[p.sessionId] || [] }
    case 'session.create': {
      const id = 's' + ++taskSeq
      tasks[p.path] = [{ id, title: p.title || '新任务', updated: Date.now(), busy: false }, ...(tasks[p.path] || [])]
      pushEvent('sessions.changed', { sessionID: id, directory: p.path })
      return { task: { id, title: p.title, updated: Date.now(), busy: false } }
    }
    case 'session.send': {
      const sid = p.sessionId
      histories[sid] = histories[sid] || []
      histories[sid].push({ role: 'user', parts: [{ id: 'u' + Date.now(), type: 'text', text: p.text }] })
      pushEvent('session.busy', { sessionID: sid, busy: true })
      pushEvent('session.changed', { sessionID: sid })
      // 模拟流式：思考 → 工具 → 正文逐字
      const reply =
        '收到。这个问题我拆成三步处理：\n\n1. 先定位根因\n2. 给出修复方案\n3. 直接落地代码\n\n先看现状：\n\n```bash\nnpm run build 2>&1 | tail -20\n```\n\n**结论**：主要是未做代码分割导致首屏 JS 过大。我已经在改了，稍等。'
      ;(async () => {
        const aid = 'a' + Date.now()
        pushEvent('session.busy', { sessionID: sid, busy: true })
        await sleep(600)
        pushEvent('session.changed', { sessionID: sid })
        // 思考增量（桌面端不下发思考增量，这里也不发）
        // 工具步骤
        pushEvent('session.changed', { sessionID: sid })
        await sleep(900)
        // 正文逐字流
        for (let i = 0; i < reply.length; i += 3) {
          pushEvent('message.delta', { sessionID: sid, text: reply.slice(i, i + 3) })
          await sleep(28)
        }
        // 落库
        const list = histories[sid]
        const last = list[list.length - 1]
        if (last && last.role === 'assistant') last.parts[last.parts.length - 1].text += reply
        else list.push({ role: 'assistant', parts: [{ id: aid, type: 'text', text: reply }] })
        pushEvent('session.changed', { sessionID: sid })
        pushEvent('session.busy', { sessionID: sid, busy: false })
        pushEvent('sessions.changed', { sessionID: sid, directory: p.path })
      })()
      return { started: true }
    }
    case 'session.stop': {
      pushEvent('session.busy', { sessionID: p.sessionId, busy: false })
      return { ok: true }
    }
    default:
      throw new Error('不认识的指令：' + rpc.method)
  }
}

let busy = false
setInterval(async () => {
  if (busy) return
  busy = true
  try {
    const r = await post('/api/ide/desk/pull', { device_id: dev.id, secret: dev.secret }, login.token)
    for (const rpc of r.rpcs ?? []) {
      try {
        const result = await runRpc(rpc)
        await post('/api/ide/desk/result', { device_id: dev.id, secret: dev.secret, id: rpc.id, ok: true, result }, login.token)
      } catch (e) {
        await post('/api/ide/desk/result', { device_id: dev.id, secret: dev.secret, id: rpc.id, ok: false, error: e.message }, login.token)
      }
    }
    if (events.length) {
      const batch = events.splice(0, events.length)
      await post('/api/ide/desk/events', { device_id: dev.id, secret: dev.secret, events: batch }, login.token)
    }
  } catch (e) {
    console.log('[fake-desk]', e.message)
  } finally {
    busy = false
  }
}, 500)

console.log('[fake-desk] 开始轮询认领…')
