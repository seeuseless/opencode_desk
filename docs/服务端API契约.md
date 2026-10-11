# 服务端 API 契约（`/api/ide/*`）

> **唯一事实来源。** 改协议必须同时改三处：本文档、`server/` 实现、`client/electron/main/` 调用方。
>
> 本文档由 `opencode_desk_token_plan`（Laravel 实现）逐字段核对而来，Go 重写版必须 1:1 兼容——
> 桌面端 `platform.ts` / `relay.ts` 里的 URL、请求体、响应字段一个都不能改。

## 0. 通用约定

| 项 | 值 |
|---|---|
| Base path | `/api` |
| 鉴权 | `Authorization: Bearer {token}`（IDE token，10 年有效） |
| 请求头 | `Content-Type: application/json`、`Accept: application/json` |
| 成功 | 2xx，JSON 体 |
| 失败 | 4xx/5xx，`{"message": "中文可读原因"}` |
| 401 | `{"message": "未登录或授权已失效"}` |
| 时间格式 | `Y-m-d H:i:s`（设备/流水）；`Y-m-d H:i`（积分记录）；ISO8601（token 过期时间） |
| 分页信封 | `{"items":[],"total":N,"page":P,"per_page":R,"pages":T}` |

**双因子（中转通道专用）**：`ide/desk/*` 除 Bearer 外，请求体还必须带 `device_id` + `secret`。
二维码泄露的人只知道 token，冒充不了桌面端拉指令。

---

## 1. 鉴权（`IdeAuthController`）

### 1.1 `POST /api/ide/pair` — 生成一次性授权码

网页端已登录（`auth:sanctum`）后调用，桌面端登录链路第 2 步。

请求：`{ "device": "青鸟 · Windows · HOST" }`（`device` 可选，≤100 字）

响应 200：
```json
{
  "code": "48位随机串",
  "expires_in": 600,
  "app_url": "qingniao://auth?code=xxx",
  "user": { "id": 1, "name": "张三", "email": "a@b.c" }
}
```
- 授权码一次性、10 分钟有效；换 token 时即刻作废，重放无效。
- 账号被禁用（`status != active`）→ 403 `账号已被禁用`。

### 1.2 `POST /api/ide/token` — 授权码换长期 token

公开接口（无 Bearer），靠一次性码鉴权。限流 30 次/分钟。

请求：`{ "code": "xxx", "device": "青鸟 · Windows · HOST" }`（`device` 可选，≤100 字）

响应 200：
```json
{
  "token": "plainTextToken",
  "expires_at": "2036-10-07T09:00:00+00:00",
  "user": { "id": 1, "name": "张三", "email": "a@b.c" },
  "gateway": "http://127.0.0.1:35000/api/ide/v1"
}
```
- token 有效期 10 年，可吊销。
- 授权码无效/过期 → 422 `授权码无效或已过期，请重新登录`
- 用户不存在或禁用 → 403 `账号不存在或已被禁用`
- 同时写一条登录日志（`device` 记为 `青鸟 · {device}`）。

### 1.3 `GET /api/ide/me` — 自检

Bearer。响应 200：
```json
{
  "user": { "id": 1, "name": "张三", "email": "a@b.c" },
  "token": { "id": 5, "name": "ide:青鸟", "expires_at": "2036-10-07T09:00:00+00:00" },
  "gateway": "http://127.0.0.1:35000/api/ide/v1"
}
```

### 1.4 `POST /api/ide/logout` — 吊销当前 token

Bearer。删除当前 access token。响应 200：`{ "message": "已退出登录" }`

---

## 2. 网关（`IdeGatewayController`）

### 2.1 `GET /api/ide/v1/models` — 可用模型清单

Bearer。响应 200：
```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-flash",
      "object": "model",
      "created": 1759852800,
      "owned_by": "官方 / 中转站A",
      "name": "deepseek-v4-flash",
      "builtin": true,
      "ratio": 1.0,
      "free": false,
      "discount": null,
      "discount_label": null,
      "effective_ratio": 1.0,
      "upstreams": [
        { "name": "官方", "model": "deepseek-v4-flash", "status": "ok" }
      ]
    }
  ]
}
```

**口径（必须一致）**：
- 只列 `enabled = true` 的模型；排序 `sort DESC, id DESC`（与后台列表同序）。
- **没有上游能提供的模型不对外暴露**（`availableUpstreamModels()` 为空则过滤掉）。
- `id` 就是模型名（后台「模型」菜单里填的名字），用户选到的就是它。
- `owned_by` = 各上游名去重后 ` / ` 连接；无上游名时 `"platform"`。
- `ratio` 是原价倍率；`effective_ratio` 才是真正扣分的：限免为 0，打折后已乘折扣。
- `discount_label`：`0.2 → "0.2x"`，无折扣返回 `null`。
- `upstreams[].status`：`unknown` / `ok` / `error`。
- 扩展字段（`name`/`builtin`/`ratio`/`free`/`discount`/`discount_label`/`effective_ratio`/`upstreams`）
  严格 OpenAI 客户端会忽略，但青鸟要用，必须给。

### 2.2 `POST /api/ide/v1/chat/completions` — 对话转发

Bearer。请求：
```json
{
  "model": "deepseek-v4-flash",
  "messages": [ { "role": "user", "content": "hi" } ],
  "stream": true,
  "temperature": 0.7,
  "tools": []
}
```
- `model` 必填 ≤190 字；`messages` 必填非空数组；`stream` 可选布尔。
- **除 `model` 外的所有字段原样转发**（`temperature` / `tools` / `response_format` 等一律带上）。
- 流式时自动补 `stream_options: { include_usage: true }`（上游没带的话），否则没法计费。

响应：
- `stream=false` → 上游原始 JSON 原样返回（200）。
- `stream=true` → `Content-Type: text/event-stream`，逐块透传，响应头：
  `Cache-Control: no-cache`、`X-Accel-Buffering: no`、`Connection: keep-alive`。

错误：
- 模型不存在或无可用上游 → 404 `模型不存在或没有可用上游：{model}`
- 所有上游与 Key 均失败 → 502 `所有上游与 API Key 均调用失败：{lastError}`
- 模型无任何可用上游 → 503 `该模型还没有可用上游：请在上游里「自动获取模型」或补一把可用 Key`

**故障转移口径**：
- 候选顺序 = 各上游（按 `sort, id` 升序）× 各上游内可用 Key。
- Key 排序：状态 `ok`(0) < `unknown`(1) < `error`(2)，同状态按 `last_used_at` 最久未用优先。
- **只在还没开始回包的阶段重试**（连不上、401、429、5xx）。一旦开始推流就不切换——
  否则用户会看到两段拼接的回答。
- 每次重试都重写 `model` 字段为「该上游里对应的模型标识」（不同上游对同一模型的标识可能不同）。

**计费**：按 `effectiveRatio()`（限免 0、打折已乘折扣）。流式下上游把 usage 放在最后一块，
边转发边扫出来，流结束后再入账——计费不阻塞用户看输出。

---

## 3. 中转通道 · 桌面端（`IdeDeskController`）

前缀 `/api/ide/desk`，全部要 Bearer + `device_id`/`secret` 双因子。

### 3.1 `POST /register` — 注册/复用本机设备

请求：`{ "name": "青鸟 · Windows · HOST", "platform": "Windows", "rotate": false }`
- `name` 必填 ≤100 字；`platform` 可选 ≤60 字；`rotate` 可选布尔。

响应 200：
```json
{
  "id": 1, "name": "青鸟 · Windows · HOST", "platform": "Windows",
  "token": "64位随机串", "secret": "64位随机串",
  "path": "/ide/device/xxx", "url": "http://127.0.0.1:35000/ide/device/xxx",
  "enabled": true, "online": true, "mobile_online": false,
  "last_seen_at": "2026-10-07 09:00:00", "mobile_seen_at": null,
  "created_at": "2026-10-07 09:00:00"
}
```
- 同一账号下同名设备**复用**（重装应用不换二维码）；`rotate=true` 只换 `token`，`secret` 不动。
- `secret` **只在注册时下发一次**，列表接口不回传。
- 注册即「桌面端此刻活着」的证据：顺手点亮 `last_seen_at`。

### 3.2 `GET /devices` — 我账号下的所有桌面端

Bearer（无需双因子）。响应 200：设备对象数组（不含 `secret`），按 `id` 倒序。

### 3.3 `DELETE /devices/{device}` — 吊销一台桌面端

Bearer。非本人设备 → 404 `该客户端不存在`。响应 200：`{ "message": "该客户端授权已吊销" }`

### 3.4 `POST /pull` — 认领指令（桌面端每 1.2 秒一次）

请求：`{ "device_id": 1, "secret": "..." }`

响应 200：
```json
{
  "rpcs": [ { "id": 12, "method": "session.send", "params": { "sessionId": "s1", "text": "hi" } } ],
  "mobile": false
}
```
- 一次最多 5 条（`PULL_LIMIT`），按 `id` 升序。
- 取走即置 `running` + `picked_at`。
- **超时重派**：上一轮取走但 90 秒没回结果的，先放回 `pending` 再取（进程被杀/内核重启时手机会一直转圈）。
- `mobile` = 有没有手机正连着（桌面端左栏图标绿点认它，认领循环顺路带回，不额外发请求）。
- 双因子失败 → 403 `设备身份校验失败，请重新登录青鸟`

### 3.5 `POST /result` — 回填指令结果

请求：`{ "device_id": 1, "secret": "...", "id": 12, "ok": true, "result": {…}, "error": null }`
- `id` 必填整数；`ok` 必填布尔；`result` 可选任意 JSON（原样存字符串）；`error` 可选 ≤2000 字。

响应 200：`{ "message": "ok" }`。指令不存在 → 404 `指令不存在`

### 3.6 `POST /events` — 批量上报内核事件

请求：
```json
{
  "device_id": 1, "secret": "...",
  "events": [ { "type": "message.delta", "payload": { "sessionID": "s1", "text": "你" } } ]
}
```
- `events` 必填数组，最多 200 条；`events.*.type` 必填 ≤80 字；`events.*.payload` 可选数组。

响应 200：`{ "message": "ok" }`
- 顺手清理：只留最近 5 分钟（`EVENT_TTL_MINUTES`）的事件。

---

## 4. 中转通道 · 手机端（`IdeDeviceController`）

前缀 `/api/ide/device`，**不需要登录**——二维码里的 token 就是凭证。

### 4.1 `GET /{token}` — 落地信息

限流 120 次/分。`token` 必须是 64 位随机串，否则 404 `链接无效`。

响应 200：
```json
{
  "device": {
    "id": 1, "name": "青鸟 · Windows · HOST", "platform": "Windows",
    "online": true, "last_seen_at": "2026-10-07 09:00:00"
  },
  "user": { "name": "张三", "email": "a@b.c" }
}
```
- 设备不存在或已禁用 → 404 `链接已失效：请在电脑上换一张二维码`
- 每次请求顺手记 `mobile_seen_at`（5 秒内已记过则跳过，判定在线窗口是 20 秒）。

### 4.2 `POST /{token}/rpc` — 下发一条指令

限流 300 次/分。请求：`{ "method": "session.send", "params": {…} }`

`method` 白名单（与桌面端 `relay.ts` 的 `run()` 一一对应，改动要两边一起）：
```
projects.list / models.list / sessions.list / session.create
session.messages / session.send / session.stop
```

响应 200：`{ "id": 12, "status": "pending" }`
- 电脑不在线 → 409 `电脑不在线：请确认青鸟已打开、账号已登录、且「移动端连接」已开启`
- method 不在白名单 → 422 校验错误

### 4.3 `GET /{token}/rpc/{rpc}` — 取指令结果（手机每 500ms 轮询）

限流 600 次/分。响应 200：
```json
{ "id": 12, "status": "done", "result": {…}, "error": null }
```
- `status`：`pending` / `running` / `done` / `failed`
- **超时就地对账**：`pending`/`running` 且创建超过 120 秒（`RPC_TIMEOUT`）→ 改 `failed`，
  `error = "电脑长时间没有响应"`。
- 指令不属于该设备 → 404 `指令不存在`

### 4.4 `GET /{token}/events` — 增量拉事件

限流 600 次/分。Query：`cursor`（上次拿到的最大 id，默认 0）

响应 200：
```json
{
  "cursor": 45,
  "online": true,
  "events": [ { "id": 44, "type": "message.delta", "payload": { "sessionID": "s1", "text": "你" } } ]
}
```
- 一次最多 300 条，按 `id` 升序；`cursor` 取本页最大 id（空页则原样返回）。

---

## 5. 用量与积分（`IdeUsageController`）

前缀 `/api/ide/usage`，全部 Bearer。

### 5.1 `GET /summary` — 一次请求喂满整个使用量页面

Query：`from` / `to`（可选，`YYYY-MM-DD`）

响应 200：
```json
{
  "from": "2026-09-08", "to": "2026-10-07",
  "points": 1234, "exempt": false,
  "range":  { "calls": 10, "tokens": 5000, "points": 50 },
  "today":  { "calls": 1,  "tokens": 500,  "points": 5 },
  "yesterday": { "calls": 2, "tokens": 1000, "points": 10 },
  "all":    { "calls": 10, "tokens": 5000, "points": 50 },
  "days":   [ { "label": "2026-09-08", "calls": 1, "tokens": 500, "points": 5 } ],
  "models": [ { "label": "deepseek-v4-flash", "calls": 10, "tokens": 5000, "points": 50 } ],
  "series": {
    "dates": [ "2026-09-08", "…" ],
    "models": [ { "label": "deepseek-v4-flash", "tokens": 5000, "points": [500, 0, 0] } ]
  }
}
```

**口径**：
- 区间默认最近 30 天（`from` 空 → 29 天前 00:00；`to` 空 → 今天 23:59:59）；`from > to` 时交换。
- `today` / `yesterday` / `all` 是固定口径，不随区间变化。
- `points` = 当前积分余额；`exempt` = 是否管理员（管理员不参与计费，客户端渲染成「不限」，
  且**所有 points 字段恒为 0**，历史行里留有扣分也按 0 算）。
- `days`：按天升序，最多 400 天。
- `models`：按 tokens 降序，最多 100 个。
- `series`：每天 × 每模型交叉，最多 8 条线（`SERIES_MODELS`）、366 天（`SERIES_DAYS`）；
  缺数据的天补 0；按总 tokens 降序。

### 5.2 `GET /logs` — 积分流水（分页）

Query：`type`（可选，`consume`/`grant`/`adjust`）、`page`、`per_page`（默认 20，最大 100）

响应 200：
```json
{
  "items": [ { "id": 1, "change": -5, "after": 1234, "type": "consume",
              "type_label": "消耗", "remark": "deepseek-v4-flash · 500 token",
              "created_at": "2026-10-07 09:00" } ],
  "total": 1, "page": 1, "per_page": 20, "pages": 1
}
```
- `type_label`：`consume`→`消耗`、`grant`→`发放`、其他→`调整`
- 按 `id` 倒序。

### 5.3 `GET /records` — 每次消耗明细（分页）

Query：`page`、`per_page`（默认 20，最大 100）

响应 200：
```json
{
  "items": [ { "id": 1, "model": "deepseek-v4-flash", "ratio": 1.0,
              "prompt_tokens": 400, "completion_tokens": 100, "total_tokens": 500,
              "points": 5, "created_at": "2026-10-07 09:00" } ],
  "total": 1, "page": 1, "per_page": 20, "pages": 1
}
```

---

## 6. 后台管理（精简范围）

> 只做桌面端运营需要的五块：上游 / 模型 / 模型概况 / 用量 / 会员。
> 权限组、小程序装修、应用市场、邮件、协议管理、TOTP 全部**不做**。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 账号密码登录（后台前端用） |
| GET | `/api/auth/me` | 当前登录者 |
| GET | `/api/admin/ai-upstreams` | 上游列表 |
| POST | `/api/admin/ai-upstreams` | 新增上游 |
| GET | `/api/admin/ai-upstreams/{id}` | 上游详情（含 Key 与模型） |
| PUT | `/api/admin/ai-upstreams/{id}` | 改上游 |
| DELETE | `/api/admin/ai-upstreams/{id}` | 删上游 |
| POST | `/api/admin/ai-upstreams/{id}/keys` | 加一把 Key |
| PUT | `/api/admin/ai-upstreams/keys/{key}` | 改 Key |
| DELETE | `/api/admin/ai-upstreams/keys/{key}` | 删 Key |
| POST | `/api/admin/ai-upstreams/keys/{key}/test` | 测一把 Key |
| POST | `/api/admin/ai-upstreams/keys/{key}/probe` | 探测一把 Key 下的模型 |
| POST | `/api/admin/ai-upstreams/{id}/sync` | 自动获取模型 |
| POST | `/api/admin/ai-upstreams/{id}/import-models` | 导入到模型库 |
| POST | `/api/admin/ai-upstreams/{id}/test` | 测整个上游 |
| PUT | `/api/admin/ai-upstreams/models/{m}` | 改上游模型（启用/禁用） |
| DELETE | `/api/admin/ai-upstreams/models/{m}` | 删上游模型 |
| GET | `/api/admin/ai-models/models` | 模型库列表 |
| POST | `/api/admin/ai-models/models` | 加模型 |
| PUT | `/api/admin/ai-models/models/{m}` | 改模型 |
| DELETE | `/api/admin/ai-models/models/{m}` | 删模型 |
| POST | `/api/admin/ai-models/models/{m}/test` | 测模型 |
| POST | `/api/admin/ai-models/re-match` | 重新匹配上游模型 |
| GET | `/api/admin/ai-models/health` | 模型概况（按时间段） |
| GET | `/api/admin/ai-models/health/series` | 概况时间序列 |
| GET | `/api/admin/usage/overview` | 用量总览 |
| GET | `/api/admin/usage/stats` | 用量统计 |
| GET | `/api/admin/members` | 会员列表 |
| GET | `/api/admin/members/{id}` | 会员详情 |
| PUT | `/api/admin/members/{id}` | 改会员（含调积分） |
| GET | `/api/admin/members/{id}/logs` | 会员积分流水 |
| GET | `/api/admin/members/{id}/usages` | 会员用量 |
| GET | `/api/admin/dashboard` | 概览 |

后台接口统一 `auth:sanctum` + `admin` 角色校验。

---

## 7. 数据模型（SQLite）

```
users(id, name, email, password, role, points, status, created_at, updated_at)
personal_access_tokens(id, user_id, name, token_hash, ip_address, user_agent, expires_at, created_at)
login_logs(id, user_id, ip_address, device, user_agent, login_at, created_at)

ide_devices(id, user_id, name, platform, token, secret, lan_url, enabled,
            last_seen_at, mobile_seen_at, created_at, updated_at)
ide_rpcs(id, device_id, method, params, status, result, error,
         picked_at, finished_at, created_at, updated_at)
ide_events(id, device_id, type, payload, created_at)

ai_models(id, name, builtin, ratio, enabled, remark, sort, free, discount, created_at, updated_at)
ai_upstreams(id, name, driver, base_url, enabled, sort, remark, models_synced_at, created_at, updated_at)
ai_upstream_keys(id, upstream_id, name, api_key, enabled, status, latency_ms,
                 last_error, last_checked_at, last_used_at, created_at, updated_at)
ai_upstream_models(id, upstream_id, model_id, model, enabled, status, latency_ms,
                   last_error, last_checked_at, created_at, updated_at)
ai_usages(id, user_id, device_id, model, ratio, prompt_tokens, completion_tokens,
          total_tokens, points, source, created_at, updated_at)
point_logs(id, user_id, change, after, type, remark, operator_id, created_at, updated_at)
ai_model_health_checks(id, upstream_model_id, ok, latency_ms, error, created_at)
ai_model_health_days(id, model_id, day, total, ok, created_at)
settings(key, value, created_at, updated_at)
```

**关键口径**：
- `ai_upstream_keys.api_key` 密文存储，任何接口都不回传明文。
- `ai_upstream_models.model_id` 可为 NULL（未匹配到模型库）；`matchUpstreamModels()` 把同名的认领过来。
- `ide_events` 只留 5 分钟；`ide_rpcs` 超时 120 秒对账成 failed。
- 设备在线：`enabled && last_seen_at > now-90s`；手机在线：`mobile_seen_at > now-20s`。
- 积分扣减：`ceil(total_tokens / 1000 × effective_ratio)`，余额不足扣到 0 不出负数，
  实际扣除额记进 `ai_usages.points`。管理员不扣。

---

## 8. 模型健康采集

后台「Token Plan → 概况」的数据来源。守护进程模式：进程自己守 10 秒节拍，不用 cron。

- 每轮每个上游**只探一个模型**（同上游多模型轮换），避免并发限流——节拍是「上游」的，不是每个模型的。
- 探测结果写 `ai_model_health_checks`；按天聚合写 `ai_model_health_days`。
- 回看口径：≤ 1 天看时间轴，> 1 天看每天的稳定百分比。
