/**
 * 青鸟平台服务端 · Hono 应用本体（与运行时无关）。
 * 两个入口共用它：index.ts（Cloudflare Workers）与 local/main.ts（本地 Node 部署）。
 * 协议口径见 docs/服务端API契约.md，改这里必须同步改契约与桌面端调用方。
 */
import { Hono } from 'hono'
import type { AppEnv } from './auth.ts'
import { ApiError } from './db.ts'
import { ide } from './ide.ts'
import { gw } from './gateway.ts'
import { admin } from './admin.ts'

export const app = new Hono<AppEnv>()

app.get('/up', (c) => c.json({ ok: true }))

/** 桌面端启动时探测这个：通了就说明服务端活着（与 Go 版同款响应）。 */
app.get('/api/health', async (c) => {
  await c.env.DB.prepare(`SELECT 1`).first()
  return c.json({ ok: true, service: 'qingniao-server', version: '1.0.0', port: 0, db: 'cloudflare-d1' })
})

app.route('/api/ide', ide)
app.route('/api/ide/v1', gw)
app.route('/api', admin)

// 未匹配的 /api/* 路径：明确 404，不能落进 SPA 兜底（否则接口错误被吞成 HTML）
app.notFound((c) => c.json({ message: '接口不存在' }, 404))

// 统一错误出口：业务错误回 {message}，其余按 500
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ message: err.message }, err.status as never)
  console.error('[server]', err)
  return c.json({ message: '服务端内部错误' }, 500)
})
