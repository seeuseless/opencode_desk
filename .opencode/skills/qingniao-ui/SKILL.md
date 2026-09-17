---
name: qingniao-ui
description: 青鸟（QingNiao）桌面应用的界面改动约定，涵盖字体栈与字体授权红线、主题变量与派生规则、自绘控件约束。当需要修改 src/renderer 下的样式或组件、调整主题配色、增删界面元素时使用。
---

## 何时使用

编辑 `src/renderer/index.css`、`src/renderer/components/*.tsx`、`src/renderer/theme.ts`
或 `src/renderer/themeColors.ts` 之前，先按本技能核对约束。

## 字体（改动前必读）

- **正文栈**：`"Noto Sans SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`，字号 15px。
  思源黑体自带拉丁字形，中英混排时字重才一致。**不要退回以 `Segoe UI` 打头的旧栈**——
  那个栈里英文走 Segoe UI、中文全落微软雅黑，一行内两套字形，是长文阅读疲劳的主因。
- **等宽栈**：`"Sarasa Mono SC", "Cascadia Mono", Consolas, monospace`。
  `Consolas` 没有汉字，单用它会让代码块里的中文注释 fallback 到宋体。
- **行高**：正文 1.75，用户气泡 1.7。中文方块字需要比拉丁文更大的行距。
- **不要加** `-webkit-font-smoothing: antialiased`：Mac 上好看，Windows 上会让字更细更糊。
- **授权红线**（不可越）：
  - 可打包进安装包：Noto Sans SC、Sarasa Gothic、Cascadia（均为 SIL OFL 1.1）。
  - 禁止随包分发：微软雅黑、等线 DengXian、Segoe UI——微软专有授权，只能引用系统字体。

## 配色

- 所有颜色走 CSS 变量（`--bg` / `--fg` / `--accent` / `--side-bg` / `--expand-bg` 等），
  内置主题在 `theme.ts` 的 `THEMES` 里定义，不要在组件里写死色值。
- 自定义主题由 `themeColors.ts` 的 `deriveVars()` 派生；新增派生变量要同步补 `DERIVED_KEYS`。

## 控件与结构

- 不使用原生 `<select>`、原生菜单、原生文件对话框以外的浏览器控件：
  下拉用 `components/Menu.tsx`，弹窗用 `components/Modal.tsx`，开关用 `components/Switch.tsx`。
- 图标一律来自 `lucide-react`，不手写内联 SVG。
- 窗口无原生边框（`frame: false`），标题栏是自绘的 `components/Titlebar.tsx`，
  窗口控制通过 preload 暴露的 `winMin` / `winMax` / `winClose` 调用。
- 主进程与渲染层之间的所有能力都要经 `electron/preload/index.ts` 的 `api` 对象暴露，
  渲染层只通过 `window.qingniao.*` 调用，不直接使用 ipcRenderer。

## 数据落盘位置

- 应用层设置：`~/.qingniaoai/settings.json`（UI 唯一事实源），内核配置由 `config.ts` 生成。
- 项目记忆：`<项目>/.qingniao/memory/`，跟项目走，不进应用配置目录。
