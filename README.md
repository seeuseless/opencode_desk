# 青鸟 QingNiao — 开源工作助手

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

![screenshot](screenshot/1.png)

取意神话中替人出行、把事办成带回消息的信使鸟，对标腾讯 WorkBuddy 形态的桌面 AI 工作助手，全开源技术栈：

- **Agent 内核：[OpenCode](https://github.com/sst/opencode)**
  主进程拉起 `opencode serve`（REST + SSE）作为内核，**原生 token 级流式**（message.part.delta），
  工具执行、任务清单（todo）、会话持久化均由内核负责；终端形态 `opencode` 同生态
- **桌面壳：Electron + React + TypeScript**
  主进程适配器透传 OpenCode 原生 API（session/message/part/event），渲染层零协议翻译；
  配置经 `opencode.json` 生成，数据目录经 XDG 环境变量隔离在 `~/.qingniaoai`

## 运行

```bash
npm install        # 首次会下载 Electron 与 OpenCode 原生二进制
npm run dev        # 开发模式（桌面窗口）
npm run build      # 编译 main/preload/renderer
npm run typecheck  # 类型检查
npm run dist       # electron-builder 打 Windows 安装包
npm run dist:mac   # electron-builder 打 macOS dmg/zip（需 .icns，npm install 自动生成）
```

> **macOS 支持**
> - 内核二进制：`opencode-ai` 通过 npm optional 依赖自动拉取对应架构（`opencode-darwin-arm64` / `opencode-darwin-x64`），`npm install` 后无需额外下载。
> - 可执行位：`postinstall` 自动 `chmod +x node_modules/opencode-ai/bin/*`（mac 上 npm 装的二进制常缺 x）。
> - 图标：`postinstall` 用 `sips` + `iconutil` 从 `resources/icon.png` 生成 `resources/icon.icns`。
> - 签名：有 Apple Developer 账号直接 `npm run dist:mac`；个人自用/无账号用 `npm run dist:mac:unsigned` 跳过签名（Gatekeeper 会拦截，需右键打开）。

## 功能

1. 项目树：添加本地文件夹为项目、独立展开/收起、按最近活动排序、会话（任务）删除
2. 草稿会话：新任务不发首条消息不占列表；标题 = 首条消息
3. 模型提供商：自定义 OpenAI **Chat Completions 兼容**端点（Base URL + Key，自动拉取模型列表，可启停），聊天内随时切换并跨重启持久
4. 任务清单：AI 开发任务实时展示（todo.updated 驱动），完成项打勾 + 中划线，进行项转圈
5. 内置浏览器：一键开启 Playwright MCP，AI 可直接操作网页；同时支持添加自定义 MCP（本地命令 / 远程 URL）
6. 任务队列：执行中继续发任务自动排队，支持插队执行（中断当前）、编辑、删除
7. 步骤可视化：中文工具名、写入实时预览动画、diff/语法高亮展开详情、Markdown 渲染
8. 可靠性：SSE 断线自动重连；错误人性化提示（网关错误、鉴权失败等翻译成中文）
9. 主题：简约浅（默认）+ 深色 + 4 套彩色浅色（晴空蓝/奶油暖米/薄荷青绿/淡粉蔷薇），强调色自动派生气泡/边框/路径文字色
10. 自绘标题栏与全部控件（无原生菜单/下拉/弹窗），图标库 lucide，无手写 SVG

## 配置与数据（本机，与用户 ~/.config/opencode 隔离）

```
~/.qingniaoai/settings.json      提供商 + MCP 列表（UI 唯一事实源，首次自动从旧 ~/.codexdesk / ~/.qingniao / ~/.justdo 迁移）
~/.qingniaoai/opencode/          XDG_CONFIG_HOME：生成的 opencode.json + 内核数据
~/.qingniaoai/data/              XDG_DATA_HOME：OpenCode 会话存储
~/.qingniaoai/state/             XDG_STATE_HOME
~/qingniaoai-workspace/          默认"工作台"项目目录
```

> **端点要求**：自定义提供商走 `@ai-sdk/openai-compatible`，需支持 OpenAI **Chat Completions API**（`/chat/completions` + `/models`）。

## 结构

```
electron/main/adapter.ts   内核生命周期：spawn opencode serve、SSE 事件桥、REST 透传
electron/main/config.ts    settings.json ↔ opencode.json 生成、XDG 目录隔离、密钥 env 注入
src/renderer/              React 界面（oc.ts 门面 API、Markdown、步骤动画、任务清单、队列）
scripts/                   gen-icon 图标生成、smoke 内核冒烟
```

## 第三方组件

本项目在运行时依赖以下开源组件，各自的版权与许可按其上游声明生效：

| 组件 | 许可 |
| --- | --- |
| [OpenCode](https://github.com/sst/opencode)（Agent 内核） | MIT |
| [Electron](https://www.electronjs.org)（含 Chromium / Node.js） | MIT |
| [React](https://react.dev) | MIT |
| [Vite](https://vitejs.dev) / electron-vite / electron-builder | MIT |
| [lucide](https://lucide.dev) 图标 | ISC |
| highlight.js / react-markdown / remark-gfm / rehype-highlight | MIT / BSD-3-Clause |

完整依赖清单及许可见 `package.json` 与各项目上游仓库。

## 许可

[MIT License](./LICENSE) — 版权 © 2026 QingNiao (青鸟)。

简言之：你可以自由使用、复制、修改、合并、发布、分发、再授权及销售本软件及其副本，
只需在副本或软件的重要部分中保留原始版权声明与本许可声明。软件按"原样"提供，不作任何保证。
