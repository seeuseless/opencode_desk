# QingNiao — Open-source Work Assistant

[简体中文](./README.md) | English

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-seeuseless%2Fopencode__desk-181717?logo=github)](https://github.com/seeuseless/opencode_desk)
[![Release](https://img.shields.io/github/v/release/seeuseless/opencode_desk?label=release&color=blue)](https://github.com/seeuseless/opencode_desk/releases/latest)

![screenshot](screenshot/1.png)

## At a Glance

| Image generation: results appear inline in the chat | Proactive questions: confirmation cards before acting | Video generation: progress reported while polling |
| --- | --- | --- |
| ![Image gen](screenshot/2.png) | ![Questions](screenshot/3.png) | ![Video gen](screenshot/4.png) |

Named after the mythical messenger bird that runs errands and brings back the news, QingNiao is a desktop AI work assistant in the spirit of Tencent WorkBuddy, built entirely on open-source technology:

- **Agent kernel: [OpenCode](https://github.com/sst/opencode)**
  The main process launches `opencode serve` (REST + SSE) as the kernel with **native token-level streaming**
  (message.part.delta); tool execution, the todo list and session persistence are all handled by the kernel —
  the same ecosystem as the `opencode` terminal app
- **Desktop shell: Electron + React + TypeScript**
  The main-process adapter passes through OpenCode's native APIs (session/message/part/event) with zero
  protocol translation in the renderer; configuration is generated into `opencode.json`, and data directories
  are isolated under `~/.qingniaoai` via XDG environment variables

## Running

```bash
git clone https://github.com/seeuseless/opencode_desk.git
cd opencode_desk
yarn install       # first run downloads Electron and the OpenCode native binaries
yarn dev           # dev mode (desktop window)
yarn build         # compile main/preload/renderer
yarn typecheck     # type checking
yarn dist          # electron-builder Windows installer (CI adds --x64 --arm64 for dual arch)
yarn dist:mac      # electron-builder macOS dmg (CI adds --arm64 --x64 for dual arch)
```

> `npm install` / `npm run xxx` work too; `yarn.lock` pins versions and **yarn is recommended**.
> To switch registries, configure `.npmrc` — do not edit the `resolved` fields in `yarn.lock`
> (committing that breaks CI package fetching).

> **Download instead of building (for most users)**
>
> Grab a ready-made installer from [Releases](https://github.com/seeuseless/opencode_desk/releases/latest),
> or check for updates in the app under "Settings → About" and install with one click.
>
> | Platform | Installer |
> | --- | --- |
> | Windows (x64) | `QingNiao-Setup.exe` (fixed name, no version suffix) |
> | Windows (ARM64) | `QingNiao-Setup-arm64.exe` |
> | macOS (Apple Silicon) | `QingNiao-Setup-arm64.dmg` |
> | macOS (Intel) | `QingNiao-Setup-x64.dmg` |
>
> The file name uses `QingNiao` instead of the Chinese name: GitHub attachment names and the
> `releases/latest/download/<name>` direct link require URL escaping for non-ASCII characters,
> which makes Chinese file names unreliable to download. Only the **installer file names** are
> anglicized; the app itself and its shortcuts are still called 青鸟.
>
> - Windows builds are not code-signed, so SmartScreen may warn about an "unknown publisher" on first
>   run — choose "More info → Run anyway".
> - macOS builds are unsigned and un-notarized; on first launch, **right-click → "Open"** to bypass
>   Gatekeeper (double-clicking directly will be blocked).

## Releasing (bump version → push a tag; GitHub does the rest)

All installers are **built automatically by GitHub Actions** — there is no need (and no reason) to build
and upload packages locally. Bump the version, push a `v*` tag, and let CI handle the rest:

```
Bump the version in package.json (e.g. 1.0.1 — **must match the tag**)
  → add an entry with the same version at the top of CHANGELOG.md
  → commit && push
  → create and push the tag  ← this triggers CI
```

```bash
# 1. Bump the version + write the changelog (versions must match)
vim package.json          # "version": "1.0.1"
vim CHANGELOG.md          # add a ## v1.0.1 entry at the top

# 2. Commit and push
git commit -am "release: v1.0.1" && git push

# 3. Tag and push — CI takes over from here
git tag -a v1.0.1 -m "release v1.0.1" && git push origin v1.0.1
```

Once the tag is pushed, **GitHub Actions automatically** (`.github/workflows/release.yml`):

1. Builds on `windows-latest` and `macos-latest` **in parallel**, producing **dual-arch** packages per
   platform: Windows x64 + ARM64, macOS Apple Silicon + Intel (six attachments in total)
2. Verifies the artifacts (installer names, the kernel binary inside matches the package architecture,
   macOS permission bits) — cross-arch packages get the matching agent kernel swapped in by the
   beforePack hook, and the checks read PE / Mach-O headers to assert the architecture
3. Attaches the installers to the Release for that tag

The Windows and macOS builds run **in parallel**; a failure on the macOS line (e.g. no signing
certificate, runner flakiness) does not block the Windows release — the Windows installers still
appear in the Release as usual.

Users then see the update prompt in "Settings → About" — **no manual announcement needed**;
the in-app updater automatically claims the installer matching the current machine architecture.

> ⚠️ **Only the Windows x64 attachment name is fixed** (`QingNiao-Setup.exe`, re-uploaded under the same
> name each release). This is what makes in-app "one-click download" possible: it uses the fixed path
> `releases/latest/download/QingNiao-Setup.exe` and **never touches `api.github.com`** (often
> unreachable in mainland China). CI renames the x64 package to this fixed name before uploading;
> all other attachments (Windows ARM64, both macOS architectures) carry an `-<arch>` suffix
> (`QingNiao-Setup-arm64.exe`, `QingNiao-Setup-x64.dmg`, etc.). Historical versions are traced via
> git tags and their Release pages.

If a release fails, re-run it manually from the [Actions](https://github.com/seeuseless/opencode_desk/actions)
page: use `workflow_dispatch` and enter the tag to rebuild.

See [docs/发版与更新提示.md](./docs/发版与更新提示.md) for details (Chinese).

## Features

1. Project tree: add local folders as projects, expand/collapse independently, sort by recent activity, delete sessions (tasks)
2. Draft sessions: a new task stays off the list until the first message is sent; the title is that first message
3. Model providers: custom OpenAI **Chat Completions compatible** endpoints (Base URL + key, automatic model listing, enable/disable); switch models anytime in chat, persisted across restarts
4. Todo list: live view of AI dev tasks (driven by todo.updated), completed items ticked and struck through, running items spinning
5. Built-in browser and desktop control: one click enables Playwright MCP (the AI operates web pages directly) and computer-use-mcp (screenshots plus keyboard/mouse, requires a model with image input); custom MCP servers (local command / remote URL) are supported too
6. Task queue: messages sent while a task runs are queued, with jump-the-queue execution (interrupting the current task), editing and deletion
7. Step visualization: localized tool names, live write preview animation, diff/syntax-highlighted expanded details, Markdown rendering
8. Reliability: SSE auto-reconnect; humanized error messages (gateway errors, auth failures, etc.)
9. Themes: Minimal Light (default) + Dark + 10 classic pigment colors + fully custom color scheme
10. Custom titlebar and all controls (no native menus/dropdowns/dialogs), lucide icons, no hand-written SVG
11. Project memory: memory lives with the project in `.qingniao/memory/` (`MEMORY.md` long-term + `YYYY-MM-DD.md` daily log); new chats automatically inject the history (injections are not echoed in the chat), and after each turn the key points are appended automatically
12. Skills: visual `SKILL.md` management in Settings, grouped by **global / project**, with create, edit, rename, delete and open-folder; frontmatter is validated against kernel rules before saving (naming, required description, length); the model only ever sees "name + description" and reads the full text on demand, so nothing sits in the context window
13. Update checks: "Settings → About" checks new versions against GitHub Releases, shows release notes and supports **one-click download → install & restart**; downloads use the fixed `releases/latest/download/QingNiao-Setup.exe` address without touching `api.github.com`, so it works in mainland China

## Configuration & Data (local, isolated from ~/.config/opencode)

```
~/.qingniaoai/settings.json      Providers + MCP list (single source of truth for the UI; auto-migrated from legacy ~/.codexdesk / ~/.qingniao / ~/.justdo on first run)
~/.qingniaoai/opencode/          XDG_CONFIG_HOME: generated opencode.json + kernel data
~/.qingniaoai/data/              XDG_DATA_HOME: OpenCode session storage
~/.qingniaoai/state/             XDG_STATE_HOME
~/.qingniaoai/updates/           Update package downloads (downloaded via Settings → About; executed by "Install")
~/.qingniaoai/workspace/         Default "Tasks" project directory (previously scattered in ~/qingniaoai-workspace; migrated automatically on first launch)
~/.qingniaoai/media/             AI-generated images / videos / audio
```

The above is app-level data; **project memory is not here** — it lives in the folder added as a project,
traveling with the repository:

```
<project>/.qingniao/memory/MEMORY.md      Long-term project memory (architecture, conventions, etc.)
<project>/.qingniao/memory/YYYY-MM-DD.md  Daily work log, appended automatically after each turn
```

> The first message of a new chat reads both files and injects them as hidden context, so the AI starts
> with project background; the daily log is appended automatically by the app — no manual upkeep needed.

**Skills** are likewise plain files on disk; their locations follow the kernel's discovery rules, and only
two places are managed by QingNiao:

```
~/.qingniaoai/opencode/skills/<skill>/SKILL.md    Global skills, active for all projects
<project>/.opencode/skills/<skill>/SKILL.md       Project skills, active only while that project is open
```

> One skill = one directory named after the skill + a capitalized `SKILL.md`. The frontmatter must contain
> `name` (lowercase letters/digits/single hyphen, matching the directory name) and `description`;
> the kernel scans both locations at startup (also honoring `~/.claude/skills` and `~/.agents/skills`) and
> writes "name + description" into the skill tool description so the model knows when to load the full text.
> Because skills load at startup, adding/removing/editing one restarts the kernel automatically — the same
> mechanism as MCP changes.

> **Endpoint requirement**: custom providers go through `@ai-sdk/openai-compatible` and must support the
> OpenAI **Chat Completions API** (`/chat/completions` + `/models`).

## Structure

```
electron/main/adapter.ts   Kernel lifecycle: spawn opencode serve, SSE event bridge, REST pass-through
electron/main/config.ts    settings.json ↔ opencode.json generation, XDG isolation, key env injection
electron/main/updater.ts   In-app updates: check GitHub Releases → download → hand over to the installer
src/renderer/              React UI (oc.ts facade API, Markdown, step animations, todo card, queue)
scripts/
  gen-icon.mjs             Generate icon.png / icon.ico / icon.icns from SVG (run manually after icon changes)
  gen-deps.mjs             Snapshot dependencies into deps.json (data source for Settings → Dependencies)
  gen-update-meta.mjs      Generate update.json (repo coordinates + tag prefix; change it when the repo moves)
  check-kernel.mjs         Pre-packaging check that the kernel binary is real, not a placeholder
  smoke.mjs                Kernel smoke test
electron-builder.yml       Packaging config (artifact names, files whitelist, mac/win targets)
.github/workflows/release.yml  tag → build → upload Release attachments
```

## Third-party Components

The following open-source components are used at runtime; their copyrights and licenses follow their
upstream declarations:

| Component | License |
| --- | --- |
| [OpenCode](https://github.com/sst/opencode) (Agent kernel) | MIT |
| [Electron](https://www.electronjs.org) (incl. Chromium / Node.js) | MIT |
| [React](https://react.dev) | MIT |
| [Vite](https://vitejs.dev) / electron-vite / electron-builder | MIT |
| [lucide](https://lucide.dev) icons | ISC |
| highlight.js / react-markdown / remark-gfm / rehype-highlight | MIT / BSD-3-Clause |

See `package.json` and each project's upstream repository for the complete dependency list and licenses.

> **Fonts**: this project **bundles no font files**; the UI only references system-installed fonts, which
> does not constitute redistribution.
>
> - Body text prefers `Noto Sans SC` (Source Han Sans, SIL OFL 1.1) — same-family design for Chinese and
>   Latin with consistent weights; when absent it falls back to `Segoe UI Variable Text` / `Segoe UI` /
>   `Microsoft YaHei`.
> - Monospace prefers `Sarasa Mono SC` (SIL OFL 1.1, CJK width exactly 2× Latin for aligned mixing);
>   when absent it falls back to `Cascadia Mono` (SIL OFL 1.1) / `Consolas`.
>
> System font references are used instead of bundling because Microsoft YaHei, DengXian, Segoe UI, etc.
> are proprietary Microsoft-licensed fonts that may only be referenced from the system, not redistributed.

## License

[MIT License](./LICENSE) — Copyright © 2026 SeeUseLESS.

> **⚠️ Experimental product**
>
> This project is an **experimental product** under rapid iteration: features, UI, behavior and config
> formats may change at any time without notice, and defects or unfinished areas may exist. Do not use it
> in production environments that demand strict reliability, data safety or compliance. Back up your
> working directories before use — especially once the "Full Control" access level is enabled, which lets
> the AI read, write and run commands without asking.
>
> In short (per the MIT License): you may freely use, copy, modify, merge, publish, distribute, sublicense
> and/or sell copies of the software, provided the original copyright notice and this permission notice are
> included in substantial portions of the software or its copies.
>
> The software is provided "as is", **without warranty of any kind, express or implied**. The authors are
> not liable for any loss or problems caused by using the software (including but not limited to lost
> files, corrupted data, unintended AI actions, or property damage) — **all risks and consequences are
> borne by the user**.

The in-app Chinese disclaimer with the full item-by-item risk notes is available under
**Settings → About → Disclaimer & Terms**; its single source of truth is
[`src/renderer/lib/license.ts`](./src/renderer/lib/license.ts). It is a Chinese explanation of the MIT
warranty disclaimer; both apply in parallel, and the [MIT License](./LICENSE) governs licensing matters.
