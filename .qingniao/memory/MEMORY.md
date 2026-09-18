# 项目记忆

## 技术栈
- Electron + React (renderer) + TypeScript (main/electron)
- 内核是 OpenCode，通过 MCP 扩展工具
- 前端在 `src/renderer`，主进程在 `electron/main`，MCP 脚本在 `resources/`

## 面板浏览器（panel_*）
- 主进程 `electron/main/index.ts` 维护一个本地 HTTP 控制端点（startPanelApi，端口 39521 起找可用），MCP server（`resources/panel-mcp.mjs`，独立 node 进程）通过这个端点操作主进程的 webview
- 面板 webview 用 `persist:webpanel` 分区（与用户看的是同一个浏览器，共享登录态）
- `panelWc` 在 `app.on('web-contents-created')` 里按 session 匹配找到，`ensurePanel()` 没开就发 `qingniao.browser.open` 等它创建
- 操作在 `panelOp(action, body)`：navigate / snapshot / click / type，type 时 ref 来自 snapshot
- snapshot 给可见元素打 `data-qref` 编号（SNAP_JS），输出 AI 可读清单

## 浏览器对话与收藏夹
- 内置浏览器开着且有页面时，发消息前会 noReply 注入 `BROWSER_CTX_PREFIX`（␞␞浏览器上下文␞␞）上下文：当前页面 URL + 「对话针对页面、用 panel_* 工具、别动项目文件」；按 sid+url 去重（browserCtxRef），编辑重发（resendMessage）时清空记录强制重注。与 MEMORY_PREFIX 同机制：AI 可见、界面不渲染（isCtxOnly）
- 面板当前 URL 由 BrowserPanel 经 `onUrl` 回传（did-navigate，含用户手输导航），存 ChatView 的 panelUrl
- 收藏夹：地址栏星标（页面标题作显示名，hostOf 兜底域名），localStorage `qingniao.bookmarks`；全屏时面板顶部渲染 bp-marks 收藏条

## 约定
- 用户回复「1」= 写 git 提交日志并 push（全局约定，跨项目）
- 禁止上传 `.git` 目录下文件；禁止生成 `nul` / `null` 文件（已在 `.gitignore` 加 `/.git/`、`/nul*`、`/null*` 规则兜底）
- 应用 `Menu.setApplicationMenu(null)`：Ctrl+R 等加速键无效，改完代码窗口不会自动重载；验证新 UI 要重启 `npm run dev`

## 踩坑记录
### 2026-09-18 panel_type 受控输入「填完就消失」
- 现象：AI 让填数据，填完界面像「一点就消失」，手动输入正常
- 根因：旧实现直接 `el.value = text` + 合成 `input`/`change` 事件。React/Vue 受控组件的 value 追踪器在原生 setter 里实现，直接赋值被追踪器拦回旧值，框架 state 没更新，页面表现像没填/消失
- 修复：用 `Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)` 绕过追踪器，再补发 input/change；textarea 没有可用 setter 直接赋值；SELECT 按 option value/text 匹配
- 位置：`electron/main/index.ts` 的 `panelOp` action==='type' 分支

### 2026-09-18 读取「文件不存在」不当错误标红
- 现象：AI 写前探测 `.qingniao/memory/MEMORY.md` 等路径，read 报 File not found 时界面右侧显示红色错误图标，用户误以为出错了
- 修复：`ChatView.tsx` 的 PartView tool 分支加 `readMiss`（st==='error' && tool==='read' && 错误以 "File not found:" 开头），传给 StepLine 的 `hideErr` 属性，据此省略右侧 AlertCircle。这类读缺失是正常探索，不是错误
- 位置：`src/renderer/components/ChatView.tsx` 的 `PartView`（tool 分支）+ `StepLine`
