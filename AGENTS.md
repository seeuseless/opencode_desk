# 项目指引

青鸟 QingNiao 是一个 **monorepo**：`client/` 是 Electron 桌面端，`server/` 是 Go 服务端，
两端通过 `/api/ide/*` 这套 HTTP 协议协作（协议细节见 [docs/服务端API契约.md](docs/服务端API契约.md)）。

## 目录

| 目录 | 内容 |
|---|---|
| `client/` | Electron + React 桌面端（原仓库根的全部内容迁入） |
| `server/` | Go 服务端：IDE 接口 + OpenAI 兼容网关 + 上游管理 + 积分计费 + 后台/手机端页面 |
| `docs/` | 调研结论与设计文档 |
| `scripts/` | 跨端构建脚本 |

## 约定

- **协议零漂移**：`/api/ide/*` 的 URL、请求体、响应字段以 `docs/服务端API契约.md` 为唯一事实来源。
  改协议必须同时改契约文档、`server/` 实现、`client/electron/main/` 调用方三处。
- 客户端自己的构建/打包配置都在 `client/` 内（`client/package.json`、`client/electron-builder.yml`），
  脚本用 `__dirname/..` 定位根，不要写死仓库根路径。
- 服务端编成**单二进制 + SQLite**，前端静态资源用 `go:embed` 内嵌；
- 服务端是**独立进程**，桌面端不负责拉起（`client/electron/main/server.ts` 只做健康探测）。
- 内核（opencode-ai）的能力调研结论放 `docs/`，当前有：
  [内核 variant 思考档位机制](docs/内核variant思考档位机制.md)、
  [内核附件 file part 与媒体上传机制](docs/内核附件file-part与媒体上传机制.md)、
  [计划任务立即执行链路](docs/计划任务立即执行链路.md)、
  [浏览器 WebView 就绪机制](docs/浏览器WebView就绪机制.md)、
  [代码模式与分栏工作台（含项目文件夹排序）](docs/代码模式与分栏工作台.md)、
  [界面多语言 i18n 机制](docs/界面多语言i18n机制.md)、
  [本机使用量统计](docs/本机使用量统计.md)。
