# 青鸟平台服务端 · Cloudflare Workers 版

把平台服务端跑在 Cloudflare Workers 上：**用户不需要在本机装/跑 server**，桌面端「平台地址」填
Workers 的 URL 即可。协议与 Go 版（`../server/`）**1:1 兼容**——
[docs/服务端API契约.md](../docs/服务端API契约.md) 是唯一事实来源，桌面端与手机端零改动。

## 与 Go 版的差异（仅基础设施，协议不变）

| 项 | Go 版 | Workers 版 |
|---|---|---|
| 运行时 | 单二进制 + SQLite 文件（~/.qingniaoai/server.db） | Workers + **D1**（云端 SQLite） |
| 前端（登录页/手机端/后台） | go:embed | **直接复用** `../server/internal/web/dist` 作为静态资产，零重写 |
| 密码哈希 | scrypt | PBKDF2-SHA256（Web Crypto 原生；云库是全新建的，不与 Go 版互认） |
| 一次性授权码 | 进程内存（10 分钟） | D1 表 `ide_pairs`（取出即删，一次性语义不变） |
| 事件实时性 | 跨请求唤醒（长轮询秒级） | 挂起轮询（1.2s 一查、最多挂 25s）——由桌面端 1.2s 推送节奏兜底 |
| 健康采集 | 进程内 10 秒节拍守护 | Cron Trigger 每分钟一轮（每轮每个上游只探一个模型，口径一致） |
| 时间显示 | 服务器本地时区 | 统一 UTC（统计「日界」可用 `TZ_HOURS` 调，默认 +8） |
| 业务限流 | 进程内滑动窗口 | 未实现（CF 自带 DDoS 防护；需要时接 Rate Limiting binding） |
| 上游代理 UpstreamProxy | 支持 | 不可能（Workers 无出口代理配置） |

首个注册的账号自动成为**管理员**（对应 Go 版首启动 ensureAdmin）；其余注册都是 member。

## 目录

```
wrangler.jsonc   # Workers 配置（D1、静态资产、cron、vars）
schema.sql       # D1 建表（与 Go 版 migrate 逐字段一致 + ide_pairs）
src/index.ts     # 入口：fetch（Hono）+ scheduled（健康采集）
src/db.ts        # 基础设施：D1 助手、时间/随机/哈希、错误与分页
src/auth.ts      # Bearer 鉴权中间件
src/ide.ts       # /api/ide/*：pair/token/me/logout、desk 中转、device 手机端、usage
src/gateway.ts   # /api/ide/v1/*：models + chat/completions（SSE 流式转发 + 计费）
src/ai.ts        # 模型/上游/用量数据访问与计费口径
src/device.ts    # 设备/指令/事件数据访问
src/admin.ts     # /api/settings、/api/auth/*、/api/admin/*（后台全集）
src/upstream.ts  # 测 Key/探测/自动获取模型/导入 + 健康采集落库
```

## 部署步骤

前置：Node 18+；一个 Cloudflare 账号（免费版可用，Workers 免费额度每天 10 万请求）。

```bash
cd server_cloudflare
npm install

# 1. 登录 Cloudflare（浏览器授权一次）
npx wrangler login

# 2. 建 D1 数据库，把输出的 database_id 填进 wrangler.jsonc 的 d1_databases
npx wrangler d1 create qingniao

# 3. 初始化表结构（远程）
npx wrangler d1 execute qingniao --remote --file=./schema.sql

# 4. 部署（首次会自动创建 Worker）
npm run deploy
```

部署完成会输出形如 `https://qingniao-server.<你的子域>.workers.dev` 的地址。

## 部署后验证

```bash
curl https://qingniao-server.<子域>.workers.dev/api/health
# {"ok":true,"service":"qingniao-server",...}
```

浏览器打开 `https://…/ide/login`：注册第一个账号（验证码固定 `000000`，它是管理员）→
点「打开青鸟 APP」→ 桌面端弹登录确认 → 完成。

## 桌面端切换到云上平台

设置 → 平台地址（或青鸟登录入口）把平台地址改成 Workers URL，例如：

```
https://qingniao-server.<你的子域>.workers.dev
```

之后桌面端登录、网关调用、手机扫码遥控、使用量统计全部走云上。

## 运营（配模型）

登录 `https://…/` 进后台（与 Go 版同一套前端页面）：上游管理里添加一个 OpenAI 兼容上游
（Base URL 自带 `/v1`，如 `https://api.deepseek.com/v1`）→ 加 API Key → 「自动获取模型」→
导入到模型库 → 在模型库里设置倍率/限免 → 完成。桌面端「内置模型」里就能看到。

## 本地开发

```bash
npm run db:local      # 初始化本地 D1
npm run dev           # wrangler dev（http://127.0.0.1:8787，前端资产同样生效）
npm run typecheck     # tsc --noEmit
```

## 注意事项

- **免费版 CPU 限制 10ms**：登录/注册的 PBKDF2 可能触发 1102 超限，把 `PBKDF2_ITERS`
  调低（如 25000）或上 Workers 付费版（$5/月，CPU 30s）。
- **网关上游被 CF 防护拦截**：个别 LLM 上游会挑战 Cloudflare 出口 IP；遇到时该上游在本机
  Go 版跑（桌面端平台地址只在云上与本地之间二选一），或换上游。
- **自定义域名**：在 Cloudflare 控制台给 Worker 绑自定义域后，把 `PUBLIC_URL` 变量设为该
  域名（响应里的 gateway 字段、设备二维码 URL 会用它）。
- **改协议**：契约文档、`server/`、`server_cloudflare/`、`client/electron/main/` 四处同步。
