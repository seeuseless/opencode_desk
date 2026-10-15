# QingNiao（青鸟）项目长期记忆

## 项目概况
- Electron + React 桌面壳工程，AI 内核为 opencode-ai（`opencode serve` REST + SSE），渲染层走内核原生 API，主进程只做透传 + SSE 事件桥。
- 多项目按 directory 参数隔离；配置/数据全部收敛在 `~/.qingniaoai`。

## 关键排障路径
- **内核真正日志**：`~/.qingniaoai/data/opencode/log/opencode.log`（断流/上游错误只写这里，常不发 session.error 事件）。
- `Temp\opencode\api.log` 是用户另一个 wms-api(Nest) 项目的日志，**与青鸟无关**。
- SSE 遥测：`~/.qingniaoai/qn-event-telemetry.json`；查会话原文用 SQLite `~/.qingniaoai/data/opencode/opencode.db`（内核按目录隔离，查不到换 directory）。
- **内核 1.18.31 事件流陷阱**：`GET /event` 按目录流，不带 `?directory=` 只有心跳；跨项目必须 `GET /global/event`，每行 `{directory, project, payload:{type, properties}}` 解包 payload，`type:'sync'` 跳过（adapter.ts openEventBridge 已修）。
- **relay.markBusy 关态记布尔不 delete**（sessions.list 每轮对账会重推 busy:false 废事件）。
- 消息 error 结构：`info.error = { name, data: { message } }`。

## 架构要点（定版）
- **busy 状态三条铁律**：① 1.2s 轮询兜底发现 busy 会话末条消息带 error → 清 busy + 补错误条；② running part 快照流入且该会话不 busy → 重新认领 busy，但用 `userStopMarks`（对比 part.state.time.start）排除用户刚停过的；③ 「并行 running 兜转圈」只在 live（busy）时生效，回合中止残留 running 按中断标红。
- **工具行渲染：相邻重复归组 ×N**：`partRows()` 同工具+同目标连续调用归组，仅末个 part 渲染挂 ×N；组尾 error 不合并。MCP 工具行名走 TOOL_META 前缀映射（media_*/music_*/tts_*/asr_*/vision_*/panel_* 等）。
- **生成类轮询全程零输出**：media/music 的 check_* 轮询期间模型不输出任何文字，只有完成/失败输出一次（用户定版）。
- **内核 shell 固定 Git Bash**：writeOpencodeConfig 写 `shell: <bash 路径>`（agentShell()：Windows 先 OPENCODE_GIT_BASH_PATH 再 PATH 扫 git.exe 反推；mac/Linux 给 "bash"）；qingniao-tools.md 明令禁止 powershell/pwsh/cmd。
- **退出必须杀内核进程树**：adapter.shutdown()（quitting 标记）+ Windows taskkill /T /F；**POSIX spawn 内核必须 detached:true**，退出 `process.kill(-pid,'SIGTERM')`。index.ts 双入口（window-all-closed + before-quit）调 shutdown。
- **内置 MCP 一律 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（nodeExec()/nodeEnv() 成对），禁止裸 'node'**。MCP 脚本在 `client/resources/mcp/*.mjs`（打包后 resourcesPath），index.ts 有 xxxMcpPath() + setXxxMcp()，config.ts writeOpencodeConfig 注册 mcp.xxx。
- 中断容错：turnErrorOf 收尾对账四处接入（session.idle / SSE 重连 / session.error / runPrompt finally）。
- 权限档位在 设置→通用（全局）；底部工具行无权限按钮、无浏览器图标（浏览器只有标题栏入口）。

## 限免模型已整条下线（2026-10-15 用户定版）
- **不要再实现任何「自动加载免费/限免模型」**。原 Zen 免 KEY 池 + openrouter/unorouter `:free` 清单的自动同步链路（ipc `zen:refresh`、`zen.ts`、`freemodels.ts`、preload `freeRefresh`、App visibilitychange effect、ModelPicker `onOpen`）已整体删除；Zen / openrouter / unorouter 的模型一律在设置页手填。
- **剔除口径只有一处**：`types.ts` 的 `isFreeModel(m)`（`free===true || effRatio===0`）+ `dropFreeModels(providers)`（老存档里的 `zenFree:true` 也一并剔；剔完一个不剩的整个 provider 消失）。消费点必须成对：`config.ts` 的 `usableProviders()`（内核配置 + resolveModel）与 `oc.ts` 的 `chatProviders()`（界面）。平台标限免的内置模型在 `platformProvider()` 与 `chatProviders()` 两处各加一道 `!isFreeModel(m)`。
- **服务端计费口径没动**（后台限免仍按 0 倍率计），只是客户端不再把限免模型提供给用户；`docs/内核Zen免费模型机制.md` 保留作机制记录（顶部有「已下线」标注），要恢复免 KEY 模型时不必重踩坑。

## 主题/样式
- 主题 `:root[data-theme='...']`；浅色浮层 UI 用灰调（--fg2），不要扎眼色。
- 设置页不要胶囊底色（裸行 + 缩略图可点 + 悬停显形动作钮）；右列 `.rightcol` 贴满窗口边缘无圆角缝隙（勿回退）。
- **`dialog.showOpenDialog` 的 filters.extensions 不带前导点**（带点 → 文件列表空）。
- **主进程改动必须重启 App**；渲染层/CSS 热更新。
- **`electron-vite build` 沙箱静默失败** → 一律 `NODE_OPTIONS= npx electron-vite build`。
- **`rm -rf`/Remove-Item 删目录被 safe-delete 拦**（trash-failed / SAFE_DELETE_FAIL_CLOSED），删产物优先加 .gitignore。

## 发版三平台
- CI 三 job 并行 build-win/mac/linux，后两个 continue-on-error。
- **AppImage 架构段是 `x86_64`/`arm64` 非 `x64`**（getArtifactArchName 按扩展名映射）；改名同步 electron-builder.yml / release.yml / updater.ts `linuxArtifactArch()` 三处。
- 只支持 glibc 发行版（musl 需另出包）。

## 模型 provider 排障（2026-10-14 定版）
- **「AI 一直没返回」先看 opencode.log 尾部 `stream error`**：内核重试 5~6 次（2/4/9/17/37s 递增，累计 1 分 39 秒）才放弃，界面转圈不是死锁。
- **错误文案对照（上游原文直出，翻译已删）**：
  | 原文 | 病因 |
  |---|---|
  | `Go requires a credential` | Go 端点没填 Key |
  | `Model is unavailable.`（Go 端点） | **也是没填 Key**（存在的 id 匿名调也报这个/报 credential） |
  | `Model is unavailable.`（Zen 端点） | 模型 id 真不存在 |
  | `Rate limit exceeded. ...` | 免 KEY 共享池限流，等一会 |
- **Zen 与 Go 是两个独立池子绝不交叉**：Go 是 $10/月订阅池必须 Key，`Go requires a credential` 就是没填 Key。Go 侧仅 3 个免费模型 `longcat-2.5-preview-free`/`step-5-preview-free`/`cat-jam-free`（2026-10-15 起限免模型下线，这几个要用手填）。Zen 填不填 Key 都能用（区别只是 anon 共享池 vs 自有配额，anon 限流会报 `Rate limit exceeded.`）；providerEnv() 刻意不给 qn-zen 注入 QN_KEY_QN_ZEN。**Zen 清单的自动同步与 mergeFreeModels 已删除，见上面「限免模型已整条下线」一节。**
- **手写 curl 验 provider** 必须带 `x-opencode-session: <任意串>` 头，否则误报 MissingSessionID。先 GET {baseURL}/models 查 id。
- **`logtail.ts` 的 `field()` 键名只能是字面量**（内部 indexOf 字面查找，传 `session\\.id` 找不到 `session.id=` → 全部 stream error 被丢弃）。已加反转义兜底，新代码仍写字面量。日志值含转义引号（`"All providers for model \"x\" ..."`），正则 `"[^"]*"` 会截半句——field() 逐字符扫识别 `\X`。
- **失败只落日志**：`message="stream error"` 才是流错误；`message=failed` 是压根没开始（provider/模型 id 错），logtail 抓不到，靠 session.error 事件。`server unavailable key=office` 是无害噪音。
- 造真实错误探针：POST /session/$SID/message 带 `model:{providerID:"__nonexistent_probe__",modelID:"nope"}`，配 GET /global/event 抓事件。

## 错误展示与就绪态口径（2026-10-14 用户定版）
- **上游错误原文直出一字不改**：humanizeError 只剩原样返回 + 400 字截断；不削 `AI_APICallError:` 包装名；`.msgerr span` pre-wrap 保留排版；空错误不显示（不填占位文案）；删翻译必须同步清 i18n.ts 死条目。
- **`session.error` 文案在 `error.data.message`**（error.message 是 undefined）→ 统一 `sessionErrorText(err)`。
- **「压根没开始」的失败连助手消息都不建**：`turnErrorOf()` 对 `role==='user'` 也判「本轮已结束」，否则轮询兜底失效。
- **abort 会盖 `MessageAbortedError` 覆盖真错误**：用 `streamErrText: Record<sid,原文>` 表兜住，四处收尾一律 `setError(real || turnErr.message)`，用完即删；该 ref 声明靠前（渲染期要读，放晚 TS2448）。
- **「有错误是结束」**：收到 stream error 立刻 abort（该 sid 在 busySet 就 markBusy(false)+abort，不限当前会话），错误文本只写当前会话对话流。
- **内核没起来绝不弹错误，最多禁用输入**：kernelReady 状态机只驱动 textarea readOnly，不加 placeholder/title 文案；`adapter.setReady()` 在 restart() 期间也要广播。
- **502 与 503 分开**：503 = 内核进程 null 请求没被接受 → 撤乐观气泡 + 清 busy + 原话退回输入框；502 = 连接断但内核可能还在跑 → 保持 transportLost 等事件收尾。判定走 oc.ts `isKernelTransportError(e)`。
- 右上角浮层 Toasts.tsx 已删（2026-10-14），错误落对话流末尾（跟会话留存）；logtail 只取 `stream error` 不取 `process … error=`（回合对账已兜，取了弹两遍）；同一回合同一错误只推一次；内核重启日志截断重写 → `size < pos` 归零；stop() 关 tail 防 start 轮换积多个。
- **JSX 注释必须 `{/* */}`**：花括号丢失变文本子节点渲染上界面；排查 grep 构建产物。

## 本机启动桌面（定版命令）
- **第一步查 `echo $ELECTRON_RUN_AS_NODE`**：本 shell 长期残留 =1，Electron 被当纯 Node 报 `does not provide an export named 'BrowserWindow'`——是环境问题不是构建问题（已踩两次）。
- ```bash
  cd client && NODE_OPTIONS= npx electron-vite build
  env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe . --disable-gpu --disable-gpu-compositing --in-process-gpu
  ```
  - GPU 必须命令行参数禁用（app.disableHardwareAcceleration() 来不及）；`npm run dev -- --disable-gpu` 不行（cac 拦截）；ELECTRON_DISABLE_GPU / ELECTRON_EXTRA_LAUNCH_ARGS electron-vite 5 不支持。
- 主进程配置没坏不要动；启动失败先排环境变量与 GPU、陈旧 out/ 产物。

## 模型选择器没有「自动」档（用户定版）
- 只列真实模型，不注入虚拟项；空值/失效值一律回落 `groups[0].models[0]`（与主进程 resolveModel 同口径；**移除虚拟项必须同步改校正 effect**——存量 localStorage 存的是空串）。
- 空值显示「未选择模型」；resolveChatModel 的 `i <= 0` 兜底保留。

## AI 自报身份 / 记忆自我污染闭环（定版）
- 常驻指令 `qingniao-identity.md`（instructions 第一条）：身份写死「我是青鸟Open 桌面客户端的 AI 助手，基于 opencode，当前模型是 <模型名>」；模型名只写 api id 严禁 `xxx/yyy` 前缀；闲聊禁止写进项目记忆。
- 内核环境提示词保留 `You are powered by the model named ${api.id}`，删掉 `The exact model ID is ${providerID}/${api.id}`；若又报 provider/model 先查这条。
- **「模型答错纠正不过来」= 项目记忆自我污染闭环**：模型答错 → 写进 `<项目>/.qingniao/memory/YYYY-MM-DD.md` → ChatView 新会话 readMemory 整段注入 → 照抄旧答案。删记忆 + 加指令两边一起改。
- 内核二进制补丁必须等长替换且 npm install 会覆盖——临时手段，优先 instructions 注入层正式修法。
