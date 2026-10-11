/**
 * 青鸟平台服务端 · 本地部署入口（Node ≥ 22.5 直接跑 TS，无需编译步骤）。
 * 与 Workers 入口共用 app.ts 应用本体，差别只在运行时三件事：
 *   · 数据库：node:sqlite 适配成 D1 形状（库文件默认 ~/.qingniao-server/qingniao.db，首启自动建表）
 *   · 静态资源：自己服务顶层 web/dist（Workers 上由平台 assets 处理）
 *   · 定时任务：setInterval 每分钟一轮健康采集（Workers 上是 cron trigger）
 * 启动：npm start；端口 PORT（默认 35000，与桌面端的本机发现约定一致）。
 */
import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { serve } from '@hono/node-server'
import { app } from '../app.ts'
import { probeRound } from '../upstream.ts'
import type { AppEnv } from '../auth.ts'
import { LocalD1 } from './d1.ts'

const port = Number(process.env.PORT) || 35000
const dbPath = process.env.QINGNIAO_DB || join(homedir(), '.qingniao-server', 'qingniao.db')
mkdirSync(dirname(dbPath), { recursive: true })
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA journal_mode = WAL') // 服务端与运维脚本可能同时开库，WAL 读写不互斥
// 建表：schema.sql 全部 IF NOT EXISTS，幂等（Workers 上由 wrangler d1 execute 完成）
db.exec(readFileSync(resolve(import.meta.dirname, '../../schema.sql'), 'utf8'))

const env = {
  DB: new LocalD1(db) as never,
  PUBLIC_URL: process.env.PUBLIC_URL || '',
  TZ_HOURS: process.env.TZ_HOURS || '8',
  PBKDF2_ITERS: process.env.PBKDF2_ITERS || '100000'
} as AppEnv['Bindings']

// 健康采集：与 Workers 的 cron trigger 同节拍
setInterval(() => probeRound(env.DB).catch(() => {}), 60_000)

// 静态资源：顶层 web/dist（Vite 产物），/api 与 /up 之外的路径先按文件命中，SPA 兜底回 index.html
const webRoot = resolve(import.meta.dirname, '../../../web/dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

async function serveAsset(pathname: string): Promise<Response | null> {
  const file = normalize(join(webRoot, decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'))
  if (file !== webRoot && !file.startsWith(webRoot + sep)) return null
  try {
    const s = await stat(file)
    if (!s.isFile()) return null
    return new Response(await readFile(file), {
      headers: { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' }
    })
  } catch {
    return null
  }
}

serve({
  port,
  fetch: async (req, info) => {
    const url = new URL(req.url)
    if (url.pathname === '/up' || url.pathname.startsWith('/api/')) return app.fetch(req, env)
    // 登录日志里的 IP：node:http 的远端地址塞进 X-Forwarded-For，clientIP 统一从那读
    const ip = info.incoming.socket.remoteAddress ?? undefined
    if (ip && !req.headers.get('x-forwarded-for')) {
      const h = new Headers(req.headers)
      h.set('X-Forwarded-For', ip)
      req = new Request(req.url, { method: req.method, headers: h, body: req.body, duplex: 'half' } as RequestInit)
    }
    return (await serveAsset(url.pathname)) ?? (await serveAsset('/index.html')) ??
      new Response('前端资源未构建：请先在 web/ 下执行 npm run build', { status: 500 })
  }
})

console.log(`[qingniao-server] http://127.0.0.1:${port}   数据库 ${dbPath}`)
