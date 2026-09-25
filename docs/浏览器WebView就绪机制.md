# 浏览器 WebView 就绪机制

> 以代码为准，改动后同步。

## 关键结论

- React 的 `<webview ref>` 赋值只代表元素已挂载，不代表 Electron guest 已完成 attach；`getURL`、`loadURL`、前进后退等 `WebviewTag` 方法必须等到 `dom-ready`。
- `src` 负责 WebView 首次挂载导航；后续 URL 变化通过 `loadURL`，且渲染层用 `wvReady` 门控。
- WebView 尚未 ready 时，地址栏输入暂存到 `pendingUrlRef`，收到 `dom-ready` 后补导航。
- 主进程的 `web-contents-created` 也早于首次 `dom-ready`；`ensurePanel` 必须同时满足 WebContents 存在、未销毁且 `panelDomReady` 为真。

## 关键触点

- `src/renderer/components/ChatView.tsx`：`BrowserPanel` 监听 `dom-ready`，统一保护 WebView 方法调用。
- `electron/main/index.ts`：记录面板 WebContents 的 `dom-ready` 状态，面板 MCP 操作前等待真实就绪。

## 验证命令

```text
npm run typecheck
npm run build
```
