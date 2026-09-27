# QingNiao（青鸟）项目长期记忆

## 项目概况
- Electron + React 桌面壳工程，AI 内核为 opencode-ai（`opencode serve` REST + SSE），渲染层走内核原生 API，主进程只做透传 + SSE 事件桥。
- 多项目按 directory 参数隔离；配置/数据全部收敛在 `~/.qingniaoai`。

## 关键排障路径
- **内核真正日志**：`~/.qingniaoai/data/opencode/log/opencode.log`（断流/上游错误只写这里，常不发 session.error 事件）。
- `Temp\opencode\api.log` 是用户另一个 wms-api(Nest) 项目的日志，**与青鸟无关**，别再查错方向。
- SSE 遥测：`~/.qingniaoai/qn-event-telemetry.json`（sseReconnects 断连计数）。
- 消息 error 结构：`info.error = { name, data: { message } }`；上游断流被内核统一标为 `MessageAbortedError`（不能再无条件静默它）。

## 架构要点（2026-09-27 定版）
- **中断容错**：渲染层 turnErrorOf 收尾对账（session.idle / SSE 重连 / session.error / runPrompt finally 四处接入），断流错误透传成红色错误条；空壳/半截截断自动续跑。
- **自动重试**：scheduleRetry 排 10s 定时器自动续跑，最多 10 次（AUTO_RETRY_DELAY=10_000 / AUTO_RETRY_MAX=10）；count 在 retries map 里跨轮保留（scheduleRetry 里**绝不能先 cancelRetry**，会清零计数）；断网记 retryWaiters、onOnline 重排；userStopped（手动停止）不自动续。
- **本地服务面板**：底部 Server 图标（有服务才显示）+ 向上浮层；主进程 `net:listeners` 只跑 netstat+tasklist（**不跑 PowerShell**，用户明确反感），锚点=对话命令提取的端口（先剥离 `scheme://` 连接串）+ pty pid 直接命中；常见数据库端口（5432/3306/6379 等）硬过滤；`net:kill` taskkill /T /F。
- **访问权限档位**在 设置→通用（全局配置），底部工具行不再有权限按钮；升「完全控制」仍走 App 的二次确认弹窗。
- 底部工具行没有内置浏览器图标（只有右上角标题栏入口）。

## 主题/样式
- 主题用 `:root[data-theme='...']` 切换；浅色（light）下浮层类 UI 要灰调（--fg2），不要 accent/绿/红扎眼色。
