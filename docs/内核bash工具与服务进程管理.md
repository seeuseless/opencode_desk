# 内核 bash 工具机制与对话服务进程管理

> 以代码为准，改动后同步。内核版本依据：opencode-ai 1.18.31（二进制字符串探查结论）。

## 内核 bash 工具的执行模型（1.18.31 实测结论）

- **Windows 上的 shell 决策**：环境变量 `SHELL` 指向的 shell 优先；未设时按
  `pwsh → powershell → git bash（经 git 定位 bin/bash.exe，可用 OPENCODE_GIT_BASH_PATH 强制）→ COMSPEC(cmd.exe)` 取第一个存在者。
  开发者机器上大概率落到 **PowerShell**。工具的 bash 语法命令在 PS 下靠 PS 的兼容行为跑（grep/sleep 等不存在）。
- **超时**：默认 **120s**，工具参数最大 600s；超时后内核 `taskkill /pid <shell> /f /t` 杀整树。
- 输出捕获上限 1MB（超限截断）；工具 structuredOutput 带 `output/exit/truncated/warnings`。
- **「终端运行中」卡死的根因**：AI 用 `nohup … &` 启动常驻服务时，Windows 宿主 shell
  （PS 5.1 语法报错整行不执行 / PS7 后台 job 的子进程占住输出管道 / cmd 下服务被**前台**执行）
  不会真正后台化 → 工具跑满 120s 超时，模型重试再卡 → 界面一直「终端运行中」（30s 后出现该提示，
  发新消息可中止接管，见 ChatView 的 terminalBlocked）。
- 防卡的正解：让服务**脱离内核 shell 会话**——PowerShell `Start-Process`（新控制台、父退出无关联）。

## 对话服务进程管理（已实现）

链路：**注入约定 → AI 回显 PID → 渲染层解析登记 → 主进程存储/对账 → 对话内进程卡**。

| 环节 | 位置 |
|---|---|
| 约定文本 `SERVICE_RULES` + 前缀 `SERVICE_CTX_PREFIX` | `client/src/renderer/oc.ts` |
| 每会话首轮注入（`svcCtxSids` 去重，失败回滚下轮重试） | `ChatView.tsx` runPrompt（markBusy 前） |
| 解析登记：`message.part.updated` 里 bash 类工具 completed 后正则抓 `QN_SERVICE_PID=(\d+)`，**在会话过滤 return 之前**（切走会话不漏登记）；端口从命令猜（`--port/PORT=/：NNNN`） | `ChatView.tsx` 事件 effect + `cmdPortOf` |
| 存储/存活对账/杀进程树 | `client/electron/main/procstore.ts`（`~/.qingniaoai/service-procs.json`，按会话 id 分组；list 时 prune 死进程=外部关闭自动同步） |
| IPC | `proc:list / proc:add / proc:kill`（`main/index.ts`，桥在 `preload/index.ts`） |
| UI：`.svc-card` 进程卡（命令摘要+端口+PID+停止），8s 轮询刷新 | `ChatView.tsx` 对话流末尾（TodoCard 后）；样式在 `index.css` |
| 退出确认：窗口 `close` 拦截，`procAliveCount()>0` 时弹「服务在跑」确认；更新器静默升级与用户确认后经 `markQuitConfirmed` 豁免 | `main/index.ts` createWindow + `procstore.ts` |

## 平台服务端端口策略（35000 起，避开常用端口）

- 服务端本地形态默认端口 35000（`server_cloudflare/src/local/main.ts`，被占即启动失败需换 `PORT`）——刻意避开 80/81/3000/8080 这类常用段，不与用户自己的服务（goerp 等）抢 9002。
- 桌面端默认平台地址 `DEFAULT_PLATFORM_URL = http://127.0.0.1:35000`（`electron/main/types.ts`）。
- **发现跟随**：`server.ts` 的 `ensure()` 在写内核配置前跑——配置地址（回环）探不到 `/api/health` 时自动扫 `35000..35099` 再兼容旧段 `9002..9101`，找到自己的 server（health 返回 `ok:true`）就 `setPlatform({ baseUrl })` 落盘并重写内核配置（登录态不动）；没找到每 60s 重试。环境变量 `QINGNIAO_PLATFORM_URL` 与远程域名不猜。
- 契约文档示例地址已同步 35000（`docs/服务端API契约.md`）；`web/vite.config.ts` 开发代理同。

验证命令：`cd client && npm run typecheck && npm run build`；Go 侧 `cd server && go build ./...`。

约定命令（AI 侧，外层单引号在 PS/bash 宿主下都不展开内层 `$`）：

```
powershell -NoProfile -Command '$env:GOERP_ADDR=":9002"; $p = Start-Process -FilePath ".\goerp.exe" -WorkingDirectory "." -WindowStyle Hidden -PassThru; Write-Output ("QN_SERVICE_PID=" + $p.Id)'
```
