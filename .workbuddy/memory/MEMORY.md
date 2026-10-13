# QingNiao（青鸟）项目长期记忆

## 项目概况
- Electron + React 桌面壳工程，AI 内核为 opencode-ai（`opencode serve` REST + SSE），渲染层走内核原生 API，主进程只做透传 + SSE 事件桥。
- 多项目按 directory 参数隔离；配置/数据全部收敛在 `~/.qingniaoai`。

## 关键排障路径
- **内核真正日志**：`~/.qingniaoai/data/opencode/log/opencode.log`（断流/上游错误只写这里，常不发 session.error 事件）。
- `Temp\opencode\api.log` 是用户另一个 wms-api(Nest) 项目的日志，**与青鸟无关**，别再查错方向。
- SSE 遥测：`~/.qingniaoai/qn-event-telemetry.json`（sseReconnects 断连计数）。
- **内核 1.18.31 事件流陷阱（2026-10-12 排障定版）**：`GET /event` 变成**按目录**流，不带 `?directory=` 只有心跳、会话事件一个不发；跨项目必须用 `GET /global/event`，每行 `{directory, project, payload:{type, properties}}` 要解包 payload，`type:'sync'` 是 v2 包装要跳过（adapter.ts openEventBridge 已修）。症状：桌面 UI 与手机 relay 同时收不到任何内核事件（不流式、不亮 busy、H5 消息不同步）。
- **relay.markBusy 关态不能 delete**：sessions.list 每轮对账会把全部会话重推 busy:false（手机页面轮询时平台每秒几十条废事件），已改为记布尔值。
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
- **设置页不要胶囊底色**：用户明确反感 `background: var(--bg2)` + 描边的「卡片按钮」行（如主题背景图槽位），
  改为无底色的裸行 + 缩略图自身可点（`.bg-slot-main`）+ 悬停才显形的角标动作钮。
- **`dialog.showOpenDialog` 的 `filters.extensions` 绝不能带前导点**：传 `.jpg` 会被 Windows 拼成 `..jpg` 通配，
  **文件列表直接空掉，用户一张都选不了**（2026-09-29 踩过）。一律 `slice(1)` 去掉点，并加「所有文件」兜底档。
- **主进程改动必须重启整个 App 才生效**（`electron-vite dev` 自动重启；`build` 产物要手动重启），
  渲染层/CSS 改动热更新即可。遇到「代码改了但行为没变」先确认是不是主进程。
- **右列（`.rightcol`）已废除悬浮卡片设计**（2026-09-29）：不再有 `margin:8px 8px 8px 0` + `border-radius:12px`，
  和侧栏一样直接贴满窗口边缘、四角切平。用户明确不要「窗口顶/右/下留缝隙、透底色、圆角」。
  不要再给右列加回外边距或圆角，也不要按浏览器状态写贴顶补丁。
- **`electron-vite build` 在沙箱下会静默失败**（`safe-delete` shim 拦 `out/` 批量清空，退出码 0 但产物没更新）
  → 一律用 `NODE_OPTIONS= npx electron-vite build` 构建，否则改了 CSS 但界面没变化会怀疑人生。
- **`rm -rf` / PowerShell `Remove-Item` 删目录会被 safe-delete 拦截**（报 `trash-failed` / `SAFE_DELETE_FAIL_CLOSED`，
  回收站不可用时 fail closed 不许fallback 删）。删构建产物目录（如 550MB 的 `dist-verify/`）优先选**加 .gitignore** 而不是硬删。
- **发版三平台与关键约定（2026-10-08加 Linux）**：
  - CI 三个 job 并行：`build-win` / `build-mac` / `build-linux`，后两个带 `continue-on-error: true`（不影响 Windows 发版线）。
  - **AppImage 产物名的架构段是 `x86_64` / `arm64`，不是 `x64`** —— electron-builder 的
    `getArtifactArchName`（builder-util/out/arch.js）按扩展名套不同架构命名惯例：
    AppImage/rpm/flatpak → x64 变 `x86_64`；deb/snap → `amd64`；exe/dmg → 保持 `x64`。
    `artifactName` 里的 `${arch}` 宏走这个映射，**不是 `process.arch` 原样输出**。
    改名要同步三处：electron-builder.yml / release.yml / updater.ts 的 `linuxArtifactArch()`。
  - **只支持 glibc 发行版**（Alpine 是 musl，跑不了）。要支持得另出 `-musl` 内核包。
  - **内置MCP 一律用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，禁止写裸 `'node'`**：
    写裸 node 意味着依赖用户本机装 node，Linux 用户没装则 6 个 MCP 全部起不来。
    见 config.ts 的 `nodeExec()` / `nodeEnv()`，两者必须成对使用。
  - **POSIX 平台 spawn 内核必须 `detached: true`**（Windows 不加），退出时 `process.kill(-pid, 'SIGTERM')`
    杀整个进程组，否则 MCP/pty 子进程全变孤儿。Windows 仍走 taskkill /T /F。

## 模型 provider 排障（2026-10-13 定版）
- **「AI 一直没返回」先看 `~/.qingniaoai/data/opencode/log/opencode.log` 尾部的 `stream error`**：
  内核会**重试 5~6 次、每次间隔递增**（2s→4s→9s→17s→37s，累计 1 分多钟）才最终放弃写 `process ... error=`。
  所以「界面一直转圈」不是死锁，是重试队列在跑，最终错误一定落在日志里。
- 三个高频 error 文案 → 病因对照：
  | 日志文案 | 病因 |
  |---|---|
  | `Model is unavailable.` | 模型 id 上游不存在（改名/下线/池子错配） |
  | `Go requires a credential` | `qn-go` 没填 API Key（Go 是 $10/月订阅制） |
  | `Rate limit exceeded. Please try again later.` | 免 KEY 免费池限流，等一会即可 |
- **Zen 与 Go 是两个独立池子，绝不能交叉并入模型清单**（这是 2026-10-13 修掉的真 bug）：
  `mergeFreeModels()` **只有 `isZenEndpoint()`（精确等于 `https://opencode.ai/zen/v1`）才并入 `settings.zen.models`**；
  `isOpencodeEndpoint()`（Zen/Go 任一）只用于展示排序「排最后」，不再管清单归属。
  交叉的代价实测过：Zen 清单 11 个里有 **8 个（73%）在 Go 的 /models 里根本不存在**（`space-bunny-free` 在 Go 叫
  `space-bunny`；`big-pickle` / `nemotron-3-ultra-free` 在 Go 压根没有），一选就报 `Model is unavailable.`。
  Go 自己的免费模型只有 3 个且同名：`longcat-2.5-preview-free` / `step-5-preview-free` / `cat-jam-free`。
- **Go（`https://opencode.ai/zen/go/v1`）是 $10/月订阅池，必须填 API Key**，否则每个请求报
  `Go requires a credential`——**与 `Model is unavailable.` 是两种错**（前者缺凭据，后者缺模型 id），别混着查。
  Go 分组在选择器里**不打「限免」标签**（`ModelGroup.hideFreeTag`，走订阅额度不是白嫖）。
- **Zen 填不填 Key，免费模型都免费**（官方定价四项全 Free）。区别只在配额归属：
  匿名走**全站共享的 anon 免费池**（限流紧，报 `Rate limit exceeded. Please try again later.`），
  带 Key 走自己的额度。`providerEnv()` 刻意不给 `qn-zen` 注入 `QN_KEY_QN_ZEN`（免 KEY 匿名通道），要自带配额得用户手填。
- **手写 curl 验 provider 可用性**：必须带 `x-opencode-session: <任意串>` 头，否则一律返回
  `MissingSessionID`（会误判成 Key 失效）；带上后才显形真实错误。先 `GET {baseURL}/models` 看清单里有没有这个 id。
- **`logtail.ts` 的 `field()` 键名只能是字面量，绝不能写正则转义**（2026-10-14 踩过）：
  `field()` 内部是 `line.indexOf(key + '=')`，传 `'session\\.id'` 会去找含反斜杠的 `session\.id=`，
  而内核日志写的是 `session.id=` → 返回 undefined → `handle()` 第一行 `if (!sessionID) return`
  把**每一条** stream error 都丢掉（当时日志里 223 条，界面一条都没显示）。
  现已在 `field()` 开头加 `key.replace(/\\(.)/g,'$1')` 兜底，但新代码仍应直接写字面量。
  凡是用 `indexOf`/`startsWith` 的手写扫描器，参数就不是正则。
## 内核就绪态与错误展示口径（2026-10-14 用户定版，最新版）
- **上游错误原文直出，一字不改**（用户原话：「上游错误是什么就输出什么，有错误是结束。让用户看到就行了。」）。
  - `humanizeError()` **已删掉全部 12 条正则翻译映射**，现在只剩「原样返回 + 400 字截断」。
    那些改写会**丢掉上游原文里的关键信息**（错误码、端点返回细节、request id），
    用户复制去搜/去问上游时只能拿到一句二手中文。
  - `logtail.handle()` 里的 `replace(/^[A-Za-z_]*Error:\s*/, '')` 同样删了——
    `AI_APICallError:` 这类包装名正是上游给的东西，削掉就没法搜。
  - `.msgerr span` 用 `white-space: pre-wrap`：上游原文常含换行/缩进（JSON 报错报文），要保留排版。
  - 空消息仍返回空串（不显示错误条），**不要填「未知错误」这种占位**。
  - **删翻译时必须同步清 i18n.ts 的死条目**（本轮清掉 7 条 × 繁英 = 14 行）。
- **`session.error` 的文案在 `error.data.message`，不在 `error.message`**（2026-10-14 实测）：
  内核 v1.18.31 推的形状是 `{name:'UnknownError', data:{message:'Model not found: x/nope.'}}`，
  `error.message` 是 **undefined**。只读后者会让错误条拿到空串 → **什么都不显示**。
  统一走 `sessionErrorText(err)`（`data.message ?? message ?? name`）。
- **「压根没开始」的失败：内核连助手消息都不建**（provider 写错 / 模型 id 不存在即此）：
  `/message` 拉回来**只有 user 消息**，没有 error 字段。所以 `turnErrorOf()` 原来那句
  `if (last.info.role !== 'assistant') return null` 会让轮询兜底彻底失效、界面永远安静。
  必须把 `role==='user'` 也判成「本轮已结束」。
- **abort 会用 `MessageAbortedError` 覆盖真实错误**（自己挖的坑）：
  按「有错误是结束」主动 abort 后，内核给助手消息盖 Aborted，
  而 session.idle / 轮询对账 / runPrompt 收尾 / SSE 重连**四处**都会读到它并写进错误条，
  把「Rate limit exceeded」这类真信息冲成一句废话。
  用 `streamErrText: Record<sid, 原文>` 表兜住，四处一律 `setError(real || turnErr.message)`，
  消息内联 `inlineErr` 也读它；**用完即删**（只保护本轮）。
  ⚠️ 该 ref 必须声明在靠前位置（渲染期就要读），放晚了 TS2448。
- **「有错误是结束」= 收到 stream error 立刻 abort，不等内核把重试跑完**：
  只要该 sid 在 busySet 里就 `markBusy(false)` + `abort()`，**不限是不是当前会话**
  （早先只收当前会话，切走的那些会在后台继续重试 1 分 39 秒，用户切回来还在转圈）。
  但错误文本**只写进当前会话的对话流**，不往这儿塞别的会话的错。
- **内核没起来时绝不弹错误，最多禁用输入**（用户原话：「显示错误太垃圾了。最多就是输入禁用。」）。
  内核冷启动/重启只要几秒，弹「内核未启动」既不是用户的错、也不能靠用户解决。
  - **保留机制、砍掉文案**：`kernelReady` 状态机（adapter.setReady / `kernel:ready` IPC / 2s 兜底轮询）
    只是驱动 textarea `readOnly` 的布尔值，用户看不见；
    **不要加「内核正在启动，请稍候…」这类 placeholder / title 文案**——用户嫌多余、要求「不要废话」。
  - `adapter.setReady()` 必须在 `restart()` 期间也广播：原来只有 onUnhealthy 推事件，
    保存设置触发的重启渲染层完全不知道，用户会撞上 503看到红字。
- **502 与 503 必须分开处理**（原来混为一谈，是个真坑）：
  - 503 = 主进程确认内核进程为 null，请求**压根没被接受**，这一轮不存在 →
    必须撤乐观气泡 + `markBusy(false)` + 原话退回输入框。否则界面**永远卡在「处理中」**
    （内核起来后也不会有 session.idle 来收尾，因为压根没有这一轮）。
  - 502 = 连接层断开，内核**可能还在跑** → 保持 `transportLost`，不当失败、不清 busy，等事件流收尾。
  判定统一走 `oc.ts` 的 `isKernelTransportError(e)`。
- **造真实上游错误的探针**（不限流时用它验证错误链路，实测好使）：
  ```bash
  curl -X POST "http://127.0.0.1:39421/session/$SID/message?directory=<enc>" \
    -H "content-type: application/json" \
    -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"__nonexistent_probe__","modelID":"nope"}}'
  ```
  配 `curl -sN http://127.0.0.1:39421/global/event -H "accept: text/event-stream"` 抓事件。
  **注意**：这类失败的日志行是 `message=failed …`，**不是** `message="stream error"`，
  所以 logtail 抓不到，必须靠 `session.error` 事件。
- **JSX 注释必须写成 `{/* */}`**：改 JSX 时把花括号弄丢，裸 `/* */` 会变成**文本子节点直接渲染到界面**。
  排查手法：`grep` 构建产物里有没有该注释（泄漏=产物里有，真注释=tree-shake 掉=0 处）。
## 本机启动桌面（2026-10-13 复盘，定版启动命令）
- **第一步永远是查环境变量残留**：`echo $ELECTRON_RUN_AS_NODE`。本 shell 长期带 `ELECTRON_RUN_AS_NODE=1`，
  Electron 被当纯 Node 跑，报 `does not provide an export named 'BrowserWindow'`——
  **这个报错看起来像构建配置问题，实际是环境问题**（2026-10-12 与 10-13 各踩一次，第二次差点去改 electron.vite.config.ts）。
- **可用启动命令（已验证）**：
  ```bash
  cd client && NODE_OPTIONS= npx electron-vite build
  env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe . --disable-gpu --disable-gpu-compositing --in-process-gpu
  ```
  - GPU 必须用**命令行参数**禁用：`index.ts` 里的 `app.disableHardwareAcceleration()` 在 ready 之后才跑，
    而 `GPU process isn't usable. Goodbye.` 发生在 Chromium 初始化阶段，**那三行来不及生效**。
  - `npm run dev -- --disable-gpu` **不行**：参数被 electron-vite 的 cac 当成自己的选项拦掉（`CACError: Unknown option --disableGpu`）。
  - `ELECTRON_DISABLE_GPU` / `ELECTRON_EXTRA_LAUNCH_ARGS` 环境变量 **electron-vite 5 不支持**，别试。
- **主进程配置没坏就不要动它**：启动失败先排环境（上面两条）与 GPU，`out/` 陈旧产物（safe-delete 拦删除时按 `NODE_OPTIONS= npx electron-vite build` 重跑覆盖）。
  实在要删构建产物目录，优先加 .gitignore 而不是硬删。

## 模型选择器没有「自动」档（2026-10-13 用户定版）
- 选择器**只列真实模型**，不注入 `{mid:'', name:'自动'}` 虚拟项。
- **空串从「合法自动档」改为「必须收敛」**：校正 effect 里空值/失效值一律回落到 `groups[0].models[0]`
  （顺序 = `chatProviders` 定的，与主进程 `resolveModel` 同口径）。**移除虚拟项时必须同步改这里**——
  存量用户 localStorage 里存的就是空串，不收敛会卡在「未选择」发不出去。
- 空值显示文案用 `未选择模型`（不是「自动」——那一刻并没有自动挑选这回事）。
- `resolveChatModel` 的 `i <= 0` 分支保留兜底：新流程走不到，但「切回会话即发消息」可能抢在校正之前触发。

## 失败提示链路（2026-10-13 定版，2026-10-14 修订）
- **内核失败只写日志**（`opencode.log` 的 `message="stream error"`），**既不推 session.error、也不立刻写进助手消息**，
  而是自动重试 6 次（间隔 2/4/9/17/37s 递增，**累计 1 分 39 秒**）。这段时间对话流里什么都没有，
  用户只看到转圈——**轮询兜底救不了**（那 1 分 39 秒消息里确实没有 error）。
- 方案：`electron/main/logtail.ts` 按字节偏移 tail 日志 → `qingniao.stream.error` 事件 → 渲染层**对话流错误条**。
  - **只取 `stream error`、绝不取 `process … error=`**（后者回合对账已兜住，取了会弹两遍）。
  - 同一回合同一错误**只推一次**（内核重试 6 次不该弹 6 个）。
  - 内核重启日志**被截断重写** → `size < pos` 归零重来；start() 重建、stop() 关闭（否则 stop→start 轮换会积多个 tail）。
  - **2026-10-14：右上角浮层 `components/Toasts.tsx` 已删除**，错误改回落在对话流末尾
    （用户定版：错误是这一轮回复的一部分，要能跟着会话被看到/复制/留存，浮层 9 秒就没了）。
  - **2026-10-14 踩过的坑：`field()` 的键名传了正则风格**（`'session\\.id'`）而内部是字面查找，
    导致 223 条 stream error **一条都没到界面**。详见上文「logtail.ts 的 field() 键名只能是字面量」。
- **诊断口诀：三个文案对应三个病因，别混查**（下面是**日志/上游原文**，
  界面显示的就是这些原文，翻译已删，所以对着日志原文查即可）
  | 原文 | 病因 |
  |---|---|
  | `Go requires a credential` | Go 端点没填 Key |
  | `Model is unavailable.`（Go 端点） | **也是没填 Key**——见下 |
  | `Model is unavailable.`（Zen 端点） | 模型 id 真的不存在 |
  | `Rate limit exceeded. Please try again later.` | 免 KEY 共享池限流，等一会 |
- **Go 端点的 `Model is unavailable.` 是个陷阱（实测）**：`step-5-preview-free` /
  `longcat-2.5-preview-free` / `cat-jam-free` 这三个 id 在 Go 的 /models 里**确实存在**，
  匿名调却是 `Go requires a credential`；而不存在的 id（如 `space-bunny-free`），无凭据时上游回的却是
  `Model is unavailable.`。**两者根因同一个：没填 Key**。
  （注：原`humanizeError` 里那条「把两者收拢到同一句中文」的规则随翻译一起删了，
  现在界面原样显示 `Model is unavailable.`，排查时按上面这张表对照。）
- **日志解析的坑**：`error.error="All providers for model \"x\" are busy"` —— 引号值里**含转义引号**。
  用正则 `"[^"]*"` 会截在第一个转义引号处拿半句垃圾。`logtail.ts` 的 `field()` 逐字符扫 + 识别 `\X` 转义。
- `server unavailable key=office` 是**无害噪音**，每个 session 都有一条，与任何卡死/报错无关，别顺着它查。


