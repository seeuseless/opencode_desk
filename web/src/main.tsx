import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"

// iOS Safari 禁双指捏合放大：gesturestart 一触发就是捏合手势，preventDefault 掐掉。
// 与 index.html 的 meta（user-scalable=no）+ index.css 的 touch-action 组成三层禁缩放，
// 个别忽略 meta 的 WebView 容器也能兜住；只禁缩放，不影响页面滚动。
document.addEventListener("gesturestart", (e) => e.preventDefault())

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
)
