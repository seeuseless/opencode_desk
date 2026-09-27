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
- **内核 shell 必须 固定 Git Bash**：opencode 1.18.31 在 Windows 上 agent 工具默认 shell 探测顺序 pwsh→powershell→git bash→cmd，不配置就弹可见 PowerShell 窗口（用户严禁 PowerShell）。writeOpencodeConfig 现写 `shell: <bash 路径>`（agentShell()：Windows 先 OPENCODE_GIT_BASH_PATH 环境变量再 PATH 扫 git.exe 反推 bin/bash.exe；**mac/Linux 给 short name "bash" 走 PATH，不写死路径**）；qingniao-tools.md 常驻指令明令禁止 powershell/pwsh/cmd /c 与 PowerShell 语法。
- **退出必须杀内核进程树**：adapter.shutdown()（quitting 标记阻断退出后任何 start/spawn，防重启间隙产出孤儿内核）+ stop() 用 taskkill /T /F 杀整棵树（p.kill() 只杀内核，MCP/pty 子进程会变孤儿，pty shell 默认还是 pwsh）。index.ts 在 window-all-closed 与 before-quit 双入口都调 shutdown。
- **中断容错**：渲染层 turnErrorOf 收尾对账（session.idle / SSE 重连 / session.error / runPrompt finally 四处接入），断流错误透传成红色错误条；空壳/半截截断自动续跑。
- **访问权限档位**在 设置→通用（全局配置），底部工具行不再有权限按钮；升「完全控制」仍走 App 的二次确认弹窗。
- 底部工具行没有内置浏览器图标（只有右上角标题栏入口）。

## 主题/样式
- 主题用 `:root[data-theme='...']` 切换；浅色（light）下浮层类 UI 要灰调（--fg2），不要 accent/绿/红扎眼色。
