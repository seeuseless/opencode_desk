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
- **处理中/busy 状态三条铁律（2026-09-29 踩坑定版）**：① 轮询兜底（1.2s 消息轮询）发现 busy 会话的末条消息带 error 文本 → 自动清 busy + 补错误条，兜住「失败只写进消息不推 session.error 事件」的静默死局；② running 工具 part 快照流进且该会话不 busy → 重新认领 busy（停止按钮随之回来），但用 `userStopMarks`（停止动作时间戳，对比 part.state.time.start）排除用户刚停过的会话，防重启残留 running 把 busy 顶死；③ PartView 组内「并行 running 兜转圈」只在 live（busy）时生效，回合中止后残留 running 按中断标红，不留假活行。
- **工具行渲染：相邻重复归组 ×N**：`partRows()` 把同工具+同目标的连续调用（可夹思考块）归成一组，仅最后一个 part 代表渲染挂 ×N；正文/异工具/异目标断开组；组尾 error 不合并（打转信号要逐行可见）。MCP 工具行名走 TOOL_META 前缀映射（media_*/music_*/tts_*/asr_*/vision_*/panel_*，内核按 serverInfo.name 加前缀注册）。
- **生成类轮询全程零输出（2026-09-29 用户定版）**：media/music MCP 的 check_* 轮询期间模型**不输出任何文字**——连拿到 task_id 时的「生成中，请稍候」也不要说（用户明确反馈这种文件不用 AI 输出，界面上工具行 ×N 归组 + 「处理中」状态已经足够）；只有完成/失败时输出一次结果。工具描述、create 回执、check 回执、内部注释四处已同步成同一口径。
- **内核 shell 必须 固定 Git Bash**：opencode 1.18.33 在 Windows 上 agent 工具默认 shell 探测顺序 pwsh→powershell→git bash→cmd，不配置就弹可见 PowerShell 窗口（用户严禁 PowerShell）。writeOpencodeConfig 现写 `shell: <bash 路径>`（agentShell()：Windows 先 OPENCODE_GIT_BASH_PATH 环境变量再 PATH 扫 git.exe 反推 bin/bash.exe；**mac/Linux 给 short name "bash" 走 PATH，不写死路径**）；qingniao-tools.md 常驻指令明令禁止 powershell/pwsh/cmd /c 与 PowerShell 语法。
- **退出必须杀内核进程树**：adapter.shutdown()（quitting 标记阻断退出后任何 start/spawn，防重启间隙产出孤儿内核）+ stop() 用 taskkill /T /F 杀整棵树（p.kill() 只杀内核，MCP/pty 子进程会变孤儿，pty shell 默认还是 pwsh）。index.ts 在 window-all-closed 与 before-quit 双入口都调 shutdown。
- **中断容错**：渲染层 turnErrorOf 收尾对账（session.idle / SSE 重连 / session.error / runPrompt finally 四处接入），断流错误透传成红色错误条；空壳/半截截断自动续跑。
- **访问权限档位**在 设置→通用（全局配置），底部工具行不再有权限按钮；升「完全控制」仍走 App 的二次确认弹窗。
- 底部工具行没有内置浏览器图标（只有右上角标题栏入口）。

## 主题/样式
- 主题用 `:root[data-theme='...']` 切换；浅色（light）下浮层类 UI 要灰调（--fg2），不要 accent/绿/红扎眼色。
