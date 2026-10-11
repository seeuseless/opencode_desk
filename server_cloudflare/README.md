# 青鸟平台服务端

平台的**唯一服务端实现**（Hono + TypeScript），一套代码两种部署形态：

- **云端**：Cloudflare Workers + D1——用户不需要在本机装/跑任何服务，桌面端「平台地址」填 Workers URL 即可。
- **本地**：Node（≥ 22.5）+ 内置 `node:sqlite`——数据不出本机，`npm start` 就跑。

协议口径见 [docs/服务端API契约.md](../docs/服务端API契约.md)，桌面端与手机端零改动。
前端（登录页 /ide/login、手机端、后台管理）是顶层 `../web/` 的 Vite 产物，两种形态共用。

## 两种形态的差异（仅基础设施，协议不变）

| 项 | 云端（Workers） | 本地（Node） |
|---|---|---|
| 数据库 | D1（云端 SQLite） | `node:sqlite` 文件，默认 `~/.qingniao-server/qingniao.db`（首启自动建表） |
| 静态资源 | 平台 assets（`../web/dist`） | 入口自己服务 `../web/dist` + SPA 兜底 |
| 密码哈希 | PBKDF2-SHA256（Web Crypto） | 同款 |
| 一次性授权码 | D1 表 `ide_pairs`（取出即删） | 同款 |
| 事件实时性 | 挂起轮询（1.2s 一查、最多挂 25s） | 同款 |
| 健康采集 | Cron Trigger 每分钟一轮 | `setInterval` 每分钟一轮（同口径） |
| 时间显示 | 统一 UTC（`TZ_HOURS` 调日界，默认 +8） | 同款 |
| 业务限流 | 未实现（CF 自带 DDoS 防护） | 未实现 |
| CPU 限制 | 免费版 10ms（PBKDF2 报 1102 就调低 `PBKDF2_ITERS`） | 无 |

首个注册的账号自动成为**管理员**（`scripts/init-admin.mjs` 可代初始化）；其余注册都是 member。

## 目录

```
wrangler.jsonc   # Workers 配置（D1、静态资产、cron、vars）
schema.sql       # 建表（幂等：云端用 wrangler d1 execute，本地首启自动执行）
src/app.ts       # 应用本体（Hono，与运行时无关）——两个入口共用
src/index.ts     # Workers 入口：fetch + scheduled（健康采集）
src/local/       # 本地部署入口：main.ts（Node HTTP + 静态资源 + 定时采集）、d1.ts（D1→node:sqlite 适配）
src/db.ts        # 基础设施：时间/随机/哈希、错误与分页、后台任务助手
src/auth.ts      # Bearer 鉴权中间件
src/ide.ts       # /api/ide/*：pair/token/me/logout、desk 中转、device 手机端、usage
src/gateway.ts   # /api/ide/v1/*：models + chat/completions（SSE 流式转发 + 计费）
src/ai.ts        # 模型/上游/用量数据访问与计费口径
src/device.ts    # 设备/指令/事件数据访问
src/admin.ts     # /api/settings、/api/auth/*、/api/admin/*（后台全集）
src/upstream.ts  # 测 Key/探测/自动获取模型/导入 + 健康采集落库
scripts/init-admin.mjs  # 初始化超管账号（幂等，可重复跑）
```

## 本地部署（npm start）

```bash
cd server_cloudflare
npm install
npm run build:web     # 构建前端产物 web/dist（前端源码在 ../web/）
npm start             # http://127.0.0.1:35000，数据库 ~/.qingniao-server/qingniao.db
```

环境变量：`PORT`（默认 35000，与桌面端本机发现约定一致）、`QINGNIAO_DB`（库文件路径）、
`TZ_HOURS`（统计日界，默认 +8）、`PBKDF2_ITERS`、`PUBLIC_URL`。

首次启动：浏览器开 `http://127.0.0.1:35000/ide/login`，注册第一个账号
（验证码固定 `000000`，它是管理员）→ 桌面端平台地址保持默认即可自动发现本机服务。

## 云端部署（Cloudflare Workers）

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

# 4.5 已有部署升级时：schema.sql 加了新表要重跑一次（幂等，不影响已有数据）
npx wrangler d1 execute qingniao --remote --file=./schema.sql

# 5. 初始化超管（部署后跑一次；users 空表时注册免邮件验证码、可设兜底密码）
node scripts/init-admin.mjs https://qingniao-server.<你的子域>.workers.dev
# 可指定邮箱与密码：node scripts/init-admin.mjs <baseURL> <email> <password>（不传密码则随机生成）
```

部署完成会输出形如 `https://qingniao-server.<你的子域>.workers.dev` 的地址。

### 部署后验证

```bash
curl https://qingniao-server.<子域>.workers.dev/api/health
# {"ok":true,"service":"qingniao-server",...}
```

浏览器打开 `https://…/ide/login`：注册第一个账号 → 点「打开青鸟 APP」→ 桌面端弹登录确认 → 完成。

⚠ 后台当前没有「改密码」功能，超管密码（脚本输出或你注册时填的）务必保存；
丢了只能删掉 `users` 表里那行后重跑脚本。

## 邮件与验证码登录

1. 超管用**密码登录**后台（邮件还没配时这是唯一途径）；
2. 侧栏「邮件设置」填 SMTP（QQ 邮箱 smtp.qq.com 465、163 smtp.163.com 465、Gmail smtp.gmail.com 587，
   密码用邮箱的「授权码」）→ **发送测试邮件**确认通了；
3. 右上角「修改邮箱」把初始化的假邮箱（admin@qingniao.local 收不到信）换成真实邮箱——新邮箱收码验证；
4. 之后注册 / 登录全部走**邮箱验证码**（密码登录保留作管理员兜底）。登录页默认方式跟着
   「邮件是否已配置」自动切换。验证码 10 分钟有效、60 秒重发节流、错 5 次作废。

## 桌面端接入

- **本地**：什么都不用填——桌面端启动时自动发现本机 35000 段的服务（`PORT` 顺延也能找到）。
- **云端**：设置 → 关于 → 远程 URL 填 Workers URL（如 `https://qingniao-server.<你的子域>.workers.dev`），
  保存即重接。出厂默认**不内置**任何云端地址：workers.dev 子域含 Cloudflare 账号的注册信息
  （手机号等），写进公开仓库等于泄露；打包时想内置可以用环境变量 `QINGNIAO_PLATFORM_URL`。

之后桌面端登录、网关调用、手机扫码遥控、使用量统计全部走该服务端。

## 运营（配模型）

登录后台（`/`）：上游管理里添加一个 OpenAI 兼容上游（Base URL 自带 `/v1`，如
`https://api.deepseek.com/v1`）→ 加 API Key → 「自动获取模型」→ 导入到模型库 →
在模型库里设置倍率/限免 → 完成。桌面端「内置模型」里就能看到。

## 本地开发

```bash
npm start             # 本地形态（改动 src/ 后手动重启）
npm run dev           # wrangler dev（http://127.0.0.1:8787，云端形态联调）
npm run typecheck     # tsc --noEmit（主工程 + src/local 各一份 tsconfig）
npm run build:web     # 构建前端（../web → ../web/dist）
```

## 注意事项

- **本地形态跑 TS 无需编译**：`node src/local/main.ts` 直接跑（Node 22.5+ 的 type stripping），
  因此源码不能用 TS 参数属性（`constructor(private x)`）这类需要转换的语法。
- **网关上游被 CF 防护拦截**：个别 LLM 上游会挑战 Cloudflare 出口 IP；遇到时改用本地形态跑
  （桌面端平台地址在云上与本地之间二选一），或换上游。
- **自定义域名**：在 Cloudflare 控制台给 Worker 绑自定义域后，把 `PUBLIC_URL` 变量设为该域名
  （响应里的 gateway 字段、设备二维码 URL 会用它）。
- **改协议**：契约文档、`server_cloudflare/`、`client/electron/main/` 三处同步。
