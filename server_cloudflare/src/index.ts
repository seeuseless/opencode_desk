/**
 * 青鸟平台服务端 · Cloudflare Workers 入口。
 * fetch = Hono app（/api/* 全集）；scheduled = 健康采集（每分钟，每上游探一个模型）。
 * 应用本体在 app.ts；本地部署入口在 local/main.ts。
 */
import { app } from './app.ts'
import type { AppEnv } from './auth.ts'
import { probeRound } from './upstream.ts'

export default {
  fetch: app.fetch,
  /** 健康采集（wrangler triggers.crons）：每分钟一轮，每轮每个上游只探一个模型。 */
  async scheduled(_controller: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(probeRound(env.DB))
  }
}
