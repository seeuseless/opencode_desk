# 青鸟 QingNiao — 开源工作助手

简体中文 | [English](./README-EN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-seeuseless%2Fopencode__desk-181717?logo=github)](https://github.com/seeuseless/opencode_desk)
[![Release](https://img.shields.io/github/v/release/seeuseless/opencode_desk?label=release&color=blue)](https://github.com/seeuseless/opencode_desk/releases/latest)

![screenshot](screenshot/1.png)

## 界面速览

| 生图：对话内直接嵌出生成结果 | 主动提问：动手前先弹卡片确认需求 | 生视频：轮询期间逐条播报进度 |
| --- | --- | --- |
| ![生图](screenshot/2.png) | ![提问](screenshot/3.png) | ![生视频](screenshot/4.png) |

取意神话中替人出行、把事办成带回消息的信使鸟，对标腾讯 WorkBuddy 形态的桌面 AI 工作助手，全开源技术栈：

- **Agent 内核：[OpenCode](https://github.com/sst/opencode)**
  主进程拉起 `opencode serve`（REST + SSE）作为内核，**原生 token 级流式**（message.part.delta），
  工具执行、任务清单（todo）、会话持久化均由内核负责；终端形态 `opencode` 同生态
- **桌面壳：Electron + React + TypeScript**
  主进程适配器透传 OpenCode 原生 API（session/message/part/event），渲染层零协议翻译；
  配置经 `opencode.json` 生成，数据目录经 XDG 环境变量隔离在 `~/.qingniaoai`

## 运行

```bash
git clone https://github.com/seeuseless/opencode_desk.git
cd opencode_desk/client
yarn install       # 首次会下载 Electron 与 OpenCode 原生二进制
yarn dev           # 开发模式（桌面窗口）
yarn build         # 编译 main/preload/renderer
yarn typecheck     # 类型检查
yarn dist          # electron-builder 打 Windows 安装包（CI 上加 --x64 --arm64 出双架构）
yarn dist:mac      # electron-builder 打 macOS dmg（CI 上加 --arm64 --x64 出双架构）
yarn dist:linux    # electron-builder 打 Linux AppImage + deb（CI 上加 --x64 --arm64 出双架构双格式）
```

> **服务端独立运行**：平台服务端（`server_cloudflare/`，一套 TypeScript 代码）是独立进程，桌面端不负责拉起——
> 安装包只含桌面端。部署形态二选一：**Cloudflare Workers 云端**（免费额度即可）或**本地部署**（Node + SQLite，
> `npm start` 即跑）。桌面端启动时探测 `{平台地址}/api/health`：本地部署会自动发现本机服务；云端在
> 「设置 → 关于 → 远程 URL」里填一次。详见 [服务端 server_cloudflare](#服务端-server_cloudflare)。

> 用 `npm install` / `npm run xxx` 亦可；仓库内 `client/yarn.lock` 锁定版本，**推荐 yarn**。
> 换源请在 `client/.npmrc` 里配，不要改 `client/yarn.lock` 里的 `resolved`（commit 上去会影响 CI 拉包）。

> **下载安装（普通用户不必自己编译）**
>
> 到 [Releases](https://github.com/seeuseless/opencode_desk/releases/latest) 直接下载
> 已构建好的安装包；也可以在应用内「设置 → 关于」里检查更新并一键下载安装。
>
> | 平台 | 安装包 |
> | --- | --- |
> | Windows（x64） | `QingNiao-Setup.exe`（文件名固定不含版本号） |
> | Windows（ARM64） | `QingNiao-Setup-arm64.exe` |
> | macOS（Apple Silicon） | `QingNiao-Setup-arm64.dmg` |
> | macOS（Intel） | `QingNiao-Setup-x64.dmg` |
> | Linux（x64，glibc） | `QingNiao-Setup-x86_64.AppImage` / `QingNiao-Setup-amd64.deb` |
> | Linux（ARM64，glibc） | `QingNiao-Setup-arm64.AppImage` / `QingNiao-Setup-arm64.deb` |
>
> 文件名用英文 `QingNiao` 而非中文「青鸟」：GitHub 附件名与
> `releases/latest/download/<名>` 直链对非 ASCII 字符要 URL 转义，中文名下载不稳。
> 只是**安装包文件名**这样，应用本身和快捷方式仍然叫「青鸟」。
>
> - Windows 未做代码签名，SmartScreen 首次运行可能提示"未知发布者"，选「更多信息 → 仍要运行」。
> - macOS 未做签名与公证，首次打开需**右键 →「打开」**绕过 Gatekeeper（直接双击会被拦下）。
> - Linux 交付 **AppImage + deb 双格式**：AppImage 下载后先 `chmod +x QingNiao-Setup-x86_64.AppImage` 再运行（部分浏览器下载会丢可执行位）；
>   deb 用 `sudo apt install ./QingNiao-Setup-amd64.deb` 安装，自带菜单项。两者都**只支持 glibc 发行版**
>   （Debian / Ubuntu / Fedora / Arch 等），Alpine 是 musl libc 跑不了这个包。
>   应用内更新在 Linux 上是「下载完手动替换旧文件」（AppImage 没有 Windows 那种安装器可挂；deb 同理手动重装/替换）。
> - Linux 附件名里的架构段有两套命名：`x86_64`（AppImage）与 `amd64`（deb），都不是笔误——
>   这是 electron-builder 对两种格式分别套用的 Linux 惯例命名（x64 的两种映射），arm64 在两种格式下都叫 `arm64`。

## 功能

1. 项目树：添加本地文件夹为项目、独立展开/收起、按最近活动排序、会话（任务）删除
2. 草稿会话：新任务不发首条消息不占列表；标题 = 首条消息
3. 模型提供商：自定义 OpenAI **Chat Completions 兼容**端点（Base URL + Key，自动拉取模型列表，可启停），聊天内随时切换并跨重启持久
4. 任务清单：AI 开发任务实时展示（todo.updated 驱动），完成项打勾 + 中划线，进行项转圈
5. 内置浏览器与桌面控制：一键开启 Playwright MCP（AI 可直接操作网页）与 computer-use-mcp（AI 可截屏并操控键鼠，需模型支持图片输入）；同时支持添加自定义 MCP（本地命令 / 远程 URL）
6. 任务队列：执行中继续发任务自动排队，支持插队执行（中断当前）、编辑、删除
7. 步骤可视化：中文工具名、写入实时预览动画、diff/语法高亮展开详情、Markdown 渲染
8. 可靠性：SSE 断线自动重连；错误人性化提示（网关错误、鉴权失败等翻译成中文）
9. 主题：简约浅（默认）+ 深色 + 4 套彩色浅色（晴空蓝/奶油暖米/薄荷青绿/淡粉蔷薇），强调色自动派生气泡/边框/路径文字色
10. 自绘标题栏与全部控件（无原生菜单/下拉/弹窗），图标库 lucide，无手写 SVG
11. 项目记忆：记忆随项目走，存于项目目录 `.qingniao/memory/`（`MEMORY.md` 长期约定 + `YYYY-MM-DD.md` 每日流水）；新对话自动注入历史上下文（注入内容不回显在聊天里），每轮结束后自动追加「用户提问 + AI 结论」要点
12. 技能（Skills）：设置页可视化管理 `SKILL.md`，按**全局 / 项目**两组展示，支持新建、编辑、改名、删除与打开目录，保存前按内核规则校验 frontmatter（名称规范、描述必填、描述长度）；模型平时只看到「名称 + 描述」，判断需要才读全文，不占常驻上下文
13. 更新提示：设置 → 关于里检查新版本（对着 GitHub Releases 比版本号），有新版本就显示更新说明并支持**一键下载 → 立即安装重启**，全程不用去浏览器翻 Release 页；下载走 `releases/latest/download/QingNiao-Setup.exe` 固定地址，不经 `api.github.com`，国内可直连
14. 平台服务端（独立运行）：一套 TypeScript 代码（`server_cloudflare/`）两种部署形态——Cloudflare Workers 云端 / 本地 Node + SQLite；含 OpenAI 兼容网关、上游/模型管理、token 积分计费、手机中转、邮件验证码与后台运营界面
15. 手机端远程操作：扫码配对，手机在任意网络下查看项目/任务、收发消息、看 AI 实时输出；桌面端与手机通过平台中转（指令认领 + 事件回传），任务列表与聊天内容实时同步
## 配置与数据（本机，与用户 ~/.config/opencode 隔离）

```
~/.qingniaoai/settings.json      提供商 + MCP 列表（UI 唯一事实源，首次自动从旧 ~/.codexdesk / ~/.qingniao / ~/.justdo 迁移）
~/.qingniaoai/opencode/          XDG_CONFIG_HOME：生成的 opencode.json + 内核数据
~/.qingniaoai/data/              XDG_DATA_HOME：OpenCode 会话存储
~/.qingniaoai/state/             XDG_STATE_HOME
~/.qingniaoai/updates/           更新包下载目录（设置 → 关于里下载的安装包，点「立即安装」时执行它）
~/.qingniaoai/workspace/         默认"工作台"项目目录（旧版散在 ~/qingniaoai-workspace，首次启动自动迁到这里）
~/.qingniaoai/media/             AI 生成的图片 / 视频 / 音频
```

以上是应用层数据；**项目记忆不在这里**——它写在被添加为项目的那个目录里，跟仓库走：

```
<项目>/.qingniao/memory/MEMORY.md      项目长期记忆（架构约定、技术选型等）
<项目>/.qingniao/memory/YYYY-MM-DD.md  每日工作流水，每轮对话结束自动追加
```

> 新对话首发时读取这两个文件并作为隐藏上下文注入，AI 因此自带项目背景；日常的流水记录由应用自动追加，无需手动维护。

**技能（Skills）** 同样是磁盘上的文件，位置由内核的发现规则决定，只有两处会被青鸟管理：

```
~/.qingniaoai/opencode/skills/<技能名>/SKILL.md    全局技能，所有项目生效
<项目>/.opencode/skills/<技能名>/SKILL.md          项目技能，仅在打开该项目时生效
```

> 一个技能 = 一个以技能名命名的目录 + 一份大写 `SKILL.md`。frontmatter 必须含 `name`（小写字母/数字/单个连字符，须与目录名一致）与 `description`；
> 内核启动时扫描这两处（另行兼容 `~/.claude/skills`、`~/.agents/skills`），把「名称 + 描述」写进 skill 工具说明，模型据此判断何时加载全文。
> 因为只在启动时加载，设置页里增删改技能后会自动重启内核使其生效——与修改 MCP 的机制一致。

> **端点要求**：自定义提供商走 `@ai-sdk/openai-compatible`，需支持 OpenAI **Chat Completions API**（`/chat/completions` + `/models`）。

## 结构

本仓库是 **monorepo**：桌面客户端 + 平台服务端（一套实现，云端/本地两种部署）+ 服务端前端。

```
client/                      Electron 桌面端（一切都在 client/ 下跑）
  electron/main/            主进程
    adapter.ts              内核生命周期：spawn opencode serve、SSE 事件桥、REST 透传
    config.ts               settings.json ↔ opencode.json 生成、XDG 目录隔离、密钥 env 注入
    platform.ts / relay.ts  平台客户端与手机中转通道
    server.ts               服务端可用性探测（本地自动发现、远程 URL 重接）
    updater.ts              应用内更新：查 GitHub Releases → 下载 → 交给安装包升级
  src/renderer/             React 界面（oc.ts 门面 API、Markdown、步骤动画、任务清单、队列）
  scripts/
    gen-icon.mjs            从 SVG 生成 icon.png / icon.ico / icon.icns
    check-kernel.mjs        打包前校验内核二进制是真货而非占位脚本
    smoke.mjs               内核冒烟测试
  electron-builder.yml      打包配置（产物名、files 白名单、win/mac/linux 目标）
server_cloudflare/           平台服务端（唯一实现，Hono + TypeScript）
  src/app.ts                应用本体（Hono，与运行时无关）
  src/index.ts              Workers 云端入口（fetch + 健康采集 cron）
  src/local/                本地部署入口（node:sqlite 适配 D1、静态资源、定时健康采集）
  src/mail/                 SMTP 客户端与邮箱验证码
  src/admin.ts / ide.ts / gateway.ts / ai.ts / device.ts / upstream.ts   后台 / 手机中转 / 网关 / 计费
  schema.sql                建表（云端 wrangler 执行 / 本地首启自动执行）
web/                         服务端前端源码（登录页 / 手机端 / 后台管理），Vite 产物两端共用
docs/                        设计文档与 API 契约（服务端API契约.md 是唯一事实来源）
.github/workflows/release.yml  tag → 构建 → 上传 Release 附件
```

## 服务端 server_cloudflare

平台服务端是**一套 TypeScript 实现**（Hono），负责：

- **IDE 接口**：登录授权、模型清单、OpenAI 兼容网关（`/api/ide/v1/*`）
- **手机中转**：桌面端注册 / 指令认领 / 事件回传（`/api/ide/desk/*`）、手机端页面（`/api/ide/device/*`）
- **用量与积分**：token 计费（`ceil(tokens ÷ 1000 × 有效倍率)`）、消耗明细、积分流水
- **上游与模型管理**：OpenAI 兼容上游 CRUD、多 Key 故障转移、自动拉模型、健康采集
- **邮件验证码**：SMTP 发信、注册 / 登录 / 换邮箱的验证码（后台「邮件设置」里配置）
- **前端**：登录页、手机端、后台管理（顶层 `web/` 的 Vite 产物，两种部署形态共用）

### 两种部署形态

| 形态 | 说明 |
| --- | --- |
| **Cloudflare Workers 云端** | D1 数据库 + 平台静态托管；免费额度每天 10 万请求，用户不用装任何东西。部署五步见 [server_cloudflare/README](server_cloudflare/README.md) |
| **本地部署** | `npm install && npm run build:web && npm start`，Node ≥ 22.5 直接跑 TS；数据不出本机，桌面端自动发现 |

桌面端接入：本地部署什么都不用填（自动发现）；云端在「设置 → 关于 → 远程 URL」填 Workers/自定义域名地址。

### API 契约

`/api/ide/*` 的 URL、请求体、响应字段逐条记录在 [`docs/服务端API契约.md`](docs/服务端API契约.md)——
这是**改协议唯一要同步的地方**：服务端实现、桌面端调用方、契约文档三处一起改。

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

完整依赖清单及许可见 `client/package.json` 与各项目上游仓库。

> **字体**：本项目**不打包任何字体文件**，界面全部引用系统已装字体，不构成再分发。
>
> - 正文优先 `Noto Sans SC`（思源黑体，SIL OFL 1.1）——中英同源设计，混排字重一致，是长时间阅读的主选；
>   未安装时依次退回 `Segoe UI Variable Text` / `Segoe UI` / `Microsoft YaHei`。
> - 等宽优先 `Sarasa Mono SC`（更纱黑体，SIL OFL 1.1，中文宽度恰为英文 2 倍，中英混排对齐）；
>   未安装时退回 `Cascadia Mono`（SIL OFL 1.1）/ `Consolas`。
>
> 落到系统字体引用而非内置，是因为微软雅黑、等线、Segoe UI 等均为微软专有授权，只能随系统引用、不可再分发。

## 许可

[MIT License](./LICENSE) — 版权 © 2026 SeeUseLESS。

> **⚠️ 实验性产品**
>
> 本项目目前是**实验性产品**，处于持续快速迭代中：功能、界面、行为与配置格式可能随时变更
> 而不另行通知，且可能包含缺陷或未完善之处。请勿在要求严格可靠、数据安全或合规的生产环境中使用。
> 使用前建议先备份工作目录——尤其是启用「完全控制」访问权限后，AI 可不再询问直接读写与执行命令。
>
> 简言之（对应 MIT 授权）：你可以自由使用、复制、修改、合并、发布、分发、再授权及销售本软件及其副本，
> 只需在副本或软件的重要部分中保留原始版权声明与本许可声明即可。
>
> 软件按“原样”提供，**不作任何明示或暗示的保证**。作者不对因使用本软件而造成的任何损失或问题
> （包括但不限于文件丢失、数据损坏、被 AI 误操作、财产损失等）承担责任——**由此产生的一切风险
> 与后果由使用者自行承担**。

上述条款的完整中文版（含逐项风险说明）也在应用内可见：**设置 → 关于 → 《免责声明与使用条款》**，
正文唯一来源是 [`client/src/renderer/lib/license.ts`](./client/src/renderer/lib/license.ts)。该声明是对 MIT 中
免责条款的中文说明，两者并行适用；就软件许可事项以 [MIT License](./LICENSE) 为准。
