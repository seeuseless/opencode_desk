import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, session, shell, type OpenDialogOptions, type WebContents } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, appendFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join, relative, resolve, basename, isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { adapter } from './adapter.ts'
import { appendGlobalMemory, loadSettings, opencodeConfigDir, qingniaoHome, saveSettings, setAccess, setDataMcp, setMediaMcp, setMemoryMcp, setMobileEnabled, setOfficeMcp, setPanelMcp, setTtsMcp, setMusicMcp, setAsrMcp, setVisionMcp, setZen, usableProviders, writeOpencodeConfig, type Settings } from './config.ts'
import { fetchZenModels } from './zen.ts'
import { refreshRouterFreeModels } from './freemodels.ts'
import type { AccessLevel, DepItem } from './types.ts'
import { relay } from './relay.ts'
import { server } from './server.ts'
import { AUTH_PROTOCOL, platform } from './platform.ts'
import { handleGate, modelAuthList, rejectAllPending, replyModelAuth, revokeModelAuth, setModelAuthSink } from './gate.ts'
import { cancelDownload, checkUpdate, downloadUpdate, installUpdate, openReleasePage, setUpdateSink, updateState } from './updater.ts'
import type { SkillDraft, SkillItem, SkillScope } from './types.ts'
import { readSchedules, removeSchedule, reorderSchedules, runScheduleNow, startScheduler, upsertSchedule } from './scheduler.ts'
import type { ScheduleTask } from './types.ts'
import { localUsage } from './usage.ts'
import { delUiStore, loadUiStore, setUiStore } from './uistore.ts'
import { procAdd, procAliveCount, procKill, procList, markQuitConfirmed, quitConfirmed } from './procstore.ts'

/**
 * 主进程职责：
 * 1. 拉起 OpenCode 内核（`opencode serve`，REST + SSE），配置与会话存储隔离在 ~/.qingniaoai
 * 2. 渲染进程 REST 门面由 adapter 透传（OpenCode 原生 API，无协议翻译）
 * 3. 应用级 IPC：目录选择、设置读写（保存即重启内核）、provider 模型列表拉取
 * 4. 移动端中转通道（relay.ts）：手机扫码 → 平台 → 本机内核，手机在 4G 下也能遥控这台电脑
 */

let mainWin: BrowserWindow | null = null

// agent 的默认工作目录（"工作台"项目）。
// 收在 ~/.qingniaoai 内，**不放 ~/qingniaoai-workspace**——青鸟自己的东西（配置、会话、
// 生成的媒体、工作台）必须全部收敛到 ~/.qingniaoai 一个地方，不在用户家目录散落新目录
// （2026-09-24 用户反馈：右击任务打开的是 ~/qingniaoai-workspace，但生成文件在 ~/.qingniaoai，两处分裂）。
const workspace = join(qingniaoHome(), 'workspace')

/**
 * dev：node_modules/opencode-ai/bin；打包：resources/bin（electron-builder extraResources 拷贝）。
 *
 * ⚠️ 文件名**不能按平台猜**（这是 mac 版曾经的阻塞点，2026-09-22 修）：
 *   opencode-ai 的 postinstall.mjs 第 29 行把目标路径**写死**成 `bin/opencode.exe`——
 *   即使跑在 macOS 上也叫 `opencode.exe`（内容确实是 Mach-O，它靠 chmod 0o755 使其可执行，
 *   后缀只是名字）。所以「win32 才叫 .exe、mac 叫 opencode」的推断是错的，
 *   在 mac 上会去找一个永不存在的 bin/opencode → 内核拉不起来。
 *   （同时它的 package.json `bin.opencode` 也指向 ./bin/opencode.exe，两处一致。）
 *
 *   更稳的做法是**按存在性探测**：优先 .exe（上游的既定命名），退回到无后缀
 *   （万一将来上游改成平台化命名，这里也不用跟着改）。前缀由 electron-builder 的
 *   extraResources 整目录拷贝保证，两种名字都能到得了 resources/bin。
 */
function opencodeBin(): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'node_modules', 'opencode-ai', 'bin')
  const withExt = join(dir, 'opencode.exe')
  // 上游命名就是 opencode.exe；无后缀那份是防御性回退（见上方注释）
  return existsSync(withExt) ? withExt : join(dir, 'opencode')
}

function createWindow(): void {
  // 打包态图标由 extraResources 平铺到 resources 根（to: icon.png，不是 image/icon.png）；
  // dev 态读源码目录里的 resources/image/icon.png
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'image', 'icon.png')
  mainWin = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    title: '青鸟 QingNiao',
    icon: existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#ececec', // 与默认主题「简约浅」窗体底色一致，避免启动闪白/闪黑
    frame: false, // 去原生标题栏，用自绘 Titlebar（跟随主题）
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      // webviewTag：右侧浏览面板用 <webview> 直接渲染 AI 打开的网页
      webviewTag: true
    }
  })
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  const sendMax = (v: boolean) => mainWin?.webContents.send('win:maximized', v)
  mainWin.on('maximize', () => sendMax(true))
  mainWin.on('unmaximize', () => sendMax(false))
  // 真退出前的服务进程确认：对话里 AI 启动的服务还在跑时，退出（Alt+F4 / 托盘「退出」）先问一声。
  // 它们是独立进程、不会被退出带走，但退了之后对话里的服务进程卡就没了——用户只能去任务管理器找。
  // 点标题栏 X 只是隐藏到托盘，不走这里；更新器静默升级与用户确认过的退出被 quitConfirmed 豁免。
  mainWin.on('close', (e) => {
    if (quitConfirmed()) return
    const n = procAliveCount()
    if (!n) return
    e.preventDefault()
    void dialog
      .showMessageBox(mainWin!, {
        type: 'warning',
        message: `还有 ${n} 个 AI 启动的服务进程在运行`,
        detail:
          '退出青鸟不会关掉它们（会继续在后台运行），但对话里的服务进程卡会消失，之后只能在任务管理器里手动结束。\n\n仍然要退出吗？',
        buttons: ['仍然退出', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      .then(({ response }) => {
        if (response === 0) {
          markQuitConfirmed()
          app.quit()
        }
      })
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWin.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWin.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 渲染进程 → adapter 的 REST 门面
ipcMain.handle('opencode:api', (_e, path: string, opts?: { method?: string; body?: unknown }) =>
  adapter.api(path, opts?.method ?? 'GET', opts?.body as Record<string, unknown>)
)

ipcMain.handle('app:info', () => ({ workspace }))

// 渲染层 UI 数据（项目清单、排序、展开态、主题…）→ ~/.qingniaoai/ui-store.json
// 放主进程而不是 localStorage：后者按 origin 隔离，dev 与安装版会各存一份（见 uistore.ts）
ipcMain.handle('ui:store:get', () => loadUiStore())
ipcMain.handle('ui:store:set', (_e, req: { key: string; value: unknown }) => setUiStore(String(req?.key), req?.value))
ipcMain.handle('ui:store:del', (_e, key: string) => delUiStore(String(key)))

// 本机用量统计（设置 → 使用量）：从内核会话存储聚合，不依赖平台
ipcMain.handle('usage:local', (_e, range?: { from?: string; to?: string }) => localUsage(range?.from ?? '', range?.to ?? ''))

/**
 * 选目录对话框（左栏「选择文件夹」与对话区项目下拉共用）。
 *
 * **访问权限由系统对话框自己决定**：macOS 上这个对话框会带「完全访问 / 受限访问」选项，
 * 用户勾「完全访问」即把该目录授权给应用；Windows / Linux 上 showOpenDialog 本身
 * 就是完整授权，没有这一步。所以应用内不做权限模型、也不在此二次校验——
 * 真读不到时由内核在读写时报错，比在这里猜准确（见 App.tsx addProject 的说明）。
 *
 * `defaultPath` 只是让对话框开在常见位置、少点两下，不构成任何授权。
 */
ipcMain.handle('dialog:pickDir', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWin
  const opts: OpenDialogOptions = {
    title: '选择文件夹',
    buttonLabel: '选择',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: workspace
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? null : (r.filePaths[0] ?? null)
})

// 浏览面板的「在外部浏览器打开」：只放行网页地址
ipcMain.handle('openExternal', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
})

// 左侧文件夹右键菜单的「打开文件夹」：在系统文件管理器里定位项目目录
// 返回空串表示成功（shell.openPath 的约定），失败时返回原因交给渲染层弹提示
ipcMain.handle('folder:open', async (_e, target: string) => {
  const p = String(target ?? '').trim()
  if (!p) return '路径为空'
  if (!existsSync(p)) return '文件夹不存在或已被移动'
  return shell.openPath(p)
})

const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.htm', '.html', '.java',
  '.js', '.jsx', '.json', '.jsonc', '.kt', '.kts', '.less', '.lua', '.md', '.mjs',
  '.mts', '.php', '.pl', '.py', '.r', '.rb', '.rs', '.sass', '.scss', '.sh', '.sql',
  '.svelte', '.swift', '.toml', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml'
])
const CODE_FILE_NAMES = new Set(['Dockerfile', 'Gemfile', 'Makefile', 'Procfile'])
const CODE_IGNORED_DIRS = new Set([
  '.git', '.gradle', '.idea', '.next', '.nuxt', '.pytest_cache', '.venv', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules', 'out', 'target', 'venv',
  // 工具/应用各自的元数据与记忆目录（跟 .git、node_modules 一样对代码模式是噪音，不展示）
  '.opencode', 'opencode', '.qingai', '.qingniaoai', '.workbuddy', '.codebuddy'
])
const MAX_CODE_BYTES = 2 * 1024 * 1024

/** 项目被本地删除/移走后，所有 workspace:* 操作的统一兜底错误信息（渲染层可据此识别，也匹配 ENOENT） */
export const CODE_DIR_MISSING = '项目目录已被删除或移走，请从列表移除该项目后重新添加'

function workspaceRoot(projectPath: string): string {
  const candidate = resolve(String(projectPath ?? '').trim())
  if (!existsSync(candidate)) throw new Error(CODE_DIR_MISSING)
  const root = realpathSync(candidate)
  if (!statSync(root).isDirectory()) throw new Error('项目目录不存在')
  return root
}

function insideWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function workspaceFile(projectPath: string, filePath: string): { root: string; target: string } {
  const root = workspaceRoot(projectPath)
  const rel = String(filePath ?? '').trim()
  const target = resolve(root, rel)
  if (!insideWorkspace(root, target)) throw new Error('文件路径超出项目目录')
  return { root, target }
}

function workspaceTargetRealPath(root: string, target: string): string {
  if (existsSync(target)) {
    const real = realpathSync(target)
    if (!insideWorkspace(root, real)) throw new Error('文件已指向项目目录之外')
    return real
  }
  const parent = realpathSync(dirnameOf(target))
  if (!insideWorkspace(root, parent)) throw new Error('文件路径超出项目目录')
  return target
}

function dirnameOf(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return i > 0 ? filePath.slice(0, i) : filePath
}

function isCodeFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return CODE_FILE_NAMES.has(name) || (dot > 0 && CODE_EXTENSIONS.has(name.slice(dot).toLowerCase()))
}

ipcMain.handle('workspace:list', (_e, req: { projectPath: string; dirPath?: string }) => {
  const { root, target } = workspaceFile(req?.projectPath, req?.dirPath ?? '')
  const real = workspaceTargetRealPath(root, target)
  if (!statSync(real).isDirectory()) throw new Error('所选路径不是目录')
  return readdirSync(real, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink() && !CODE_IGNORED_DIRS.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: relative(root, join(real, entry.name)).split(sep).join('/'),
      type: entry.isDirectory() ? 'directory' as const : 'file' as const
    }))
    .filter((entry) => entry.type === 'directory' || isCodeFile(entry.name))
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
    )
})

ipcMain.handle('workspace:read', (_e, req: { projectPath: string; filePath: string }) => {
  const rel = String(req?.filePath ?? '').trim()
  let real: string
  if (isAbsolute(rel)) {
    // AI 会把文件写到项目外（diff 里记的是完整路径），审查面板「全文」按绝对路径直接读
    real = rel
  } else {
    const { root, target } = workspaceFile(req?.projectPath, rel)
    real = workspaceTargetRealPath(root, target)
  }
  const stat = statSync(real)
  if (!stat.isFile()) throw new Error('所选路径不是文件')
  if (stat.size > MAX_CODE_BYTES) throw new Error('文件超过 2 MB，暂不支持编辑查看')
  const content = readFileSync(real)
  if (content.includes(0)) throw new Error('这是二进制文件，暂不支持代码编辑')
  return { content: content.toString('utf8'), mtimeMs: stat.mtimeMs }
})

ipcMain.handle('workspace:write', (_e, req: {
  projectPath: string
  filePath: string
  content: string
  expectedMtimeMs: number
}) => {
  const { root, target } = workspaceFile(req?.projectPath, req?.filePath)
  const real = workspaceTargetRealPath(root, target)
  const current = existsSync(real) ? statSync(real) : null
  if (current && Math.abs(current.mtimeMs - req.expectedMtimeMs) > 0.5) {
    throw new Error('文件已被其他程序修改，请重新打开后再保存')
  }
  if (!current) throw new Error('文件已被删除，请重新打开后再保存')
  const content = Buffer.from(req.content, 'utf8')
  if (content.includes(0)) throw new Error('不能把二进制内容保存为代码文件')
  if (content.length > MAX_CODE_BYTES) throw new Error('文件超过 2 MB，暂不支持保存')
  writeFileSync(real, content)
  return { mtimeMs: statSync(real).mtimeMs }
})

/**
 * 代码编辑器「新建文件」：先弹系统「另存为」对话框选一个目标文件（默认落在当前目录），
 * 校验选中的路径**仍在项目目录内**后落盘一个空文件，返回相对路径给渲染层直接打开新 tab。
 * 用户取消返回 null。
 */
ipcMain.handle('workspace:newFile', async (_e, req: { projectPath: string; dirPath?: string }) => {
  const { root, target: dir } = workspaceFile(req?.projectPath, req?.dirPath ?? '')
  const realDir = workspaceTargetRealPath(root, dir)
  if (!statSync(realDir).isDirectory()) throw new Error('所选路径不是目录')
  const win = BrowserWindow.getFocusedWindow() ?? mainWin
  const opts = {
    title: '新建文件',
    buttonLabel: '新建',
    defaultPath: join(realDir, 'untitled.ts'),
    properties: ['createDirectory', 'showOverwriteConfirmation'] as ('createDirectory' | 'showOverwriteConfirmation')[]
  }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return null
  const target = resolve(root, r.filePath)
  if (!insideWorkspace(root, target)) throw new Error('文件路径超出项目目录')
  if (!existsSync(target)) writeFileSync(target, '') // 落盘空占位，编辑器打开后 Ctrl+S 正常覆盖
  return { path: relative(root, target).split(sep).join('/') }
})

/** 代码编辑器「新建文件夹」（右键目录菜单）：在指定目录下创建一个新目录 */
ipcMain.handle('workspace:newDir', (_e, req: { projectPath: string; parentDir: string; name: string }) => {
  const { root, target: parent } = workspaceFile(req?.projectPath, req?.parentDir)
  const realParent = workspaceTargetRealPath(root, parent)
  if (!statSync(realParent).isDirectory()) throw new Error('所选路径不是目录')
  const name = String(req?.name ?? '').trim()
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('文件夹名不合法')
  const target = resolve(realParent, name)
  if (!insideWorkspace(root, target)) throw new Error('文件路径超出项目目录')
  if (existsSync(target)) throw new Error('同名文件或文件夹已存在')
  mkdirSync(target, { recursive: false })
  return { path: relative(root, target).split(sep).join('/') }
})

/** 代码编辑器「删除」（右键文件/文件夹菜单）：文件直接删，文件夹递归删。
 *  仅能在项目目录内操作；删除前渲染层已弹确认框。 */
ipcMain.handle('workspace:delete', (_e, req: { projectPath: string; filePath: string }) => {
  const { root, target } = workspaceFile(req?.projectPath, req?.filePath)
  const real = workspaceTargetRealPath(root, target)
  if (real === root) throw new Error('不能删除项目根目录')
  rmSync(real, { recursive: true, force: true })
  return true
})

// 聊天里图片/视频的「保存」：远程地址先下载到内存，本地路径直接读文件，再弹系统另存为对话框
// 约定同 folder:open：返回空串表示成功（用户取消也算成功），失败返回原因
ipcMain.handle('media:save', async (_e, req: { source: string; name?: string }) => {
  const src = String(req?.source ?? '').trim()
  if (!src) return '地址为空'
  try {
    let buf: Buffer
    let suggested = String(req?.name ?? '').trim()
    if (/^data:/i.test(src)) {
      const m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(src)
      if (!m) return 'data 地址无法解析'
      const body = decodeURIComponent(m[3] ?? '')
      buf = m[2] ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8')
      if (!suggested) suggested = 'image.' + ((m[1] ?? '').includes('/') ? (m[1] as string).split('/')[1] : 'png')
    } else if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src)
      if (!r.ok) return `下载失败 HTTP ${r.status}`
      buf = Buffer.from(await r.arrayBuffer())
      if (!suggested) {
        suggested = decodeURIComponent(new URL(src).pathname.split('/').pop() ?? '') || 'media'
      }
    } else {
      let p = src
      if (/^file:\/\//i.test(p)) p = fileURLToPath(p)
      p = locateMediaFile(p)
      if (!existsSync(p)) return '文件不存在或已被移动'
      buf = readFileSync(p)
      if (!suggested) suggested = basename(p)
    }
    const win = BrowserWindow.getFocusedWindow() ?? mainWin
    const r = win
      ? await dialog.showSaveDialog(win, { defaultPath: suggested })
      : await dialog.showSaveDialog({ defaultPath: suggested })
    if (r.canceled || !r.filePath) return ''
    writeFileSync(r.filePath, buf)
    return ''
  } catch (err) {
    return String((err as Error).message ?? err)
  }
})

// 聊天内嵌显示本地媒体：渲染层（http 页面）加载不了 file://。
// 图片走 data URL；视频返回原始字节，渲染层转 blob URL 交给 <video>（data URL 会再膨胀三分之一，本地视频动辄几十 MB）
// 只放行表内扩展名，其他一律拒绝
const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}
const READ_VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v'
}
/** 配音结果内嵌播放放行的音频类型（与视频同理：只回字节，白名单外一律不放） */
const READ_AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac'
}
/** 模型转述生图结果时常把目录剥掉只剩裸文件名（"本地文件：xxx.png"）：无目录时到媒体目录兜底解析 */
function locateMediaFile(p: string): string {
  if (!p || /[\\/]/.test(p) || existsSync(p)) return p
  const cand = join(qingniaoHome(), 'media', p)
  return existsSync(cand) ? cand : p
}
/** 渲染层路径 → { 真实路径, 扩展名 }（file:// 还原、裸文件名媒体目录兜底；扩展名算上数字，.mp4 这类 [a-z]+ 匹配不上） */
function readMediaTarget(target: string): { p: string; ext: string } {
  let p = String(target ?? '').trim()
  if (/^file:\/\//i.test(p)) p = fileURLToPath(p)
  p = locateMediaFile(p)
  const ext = p.split(/[?#]/)[0].toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  return { p, ext }
}
ipcMain.handle('media:read', (_e, target: string) => {
  const { p, ext } = readMediaTarget(target)
  const mime = IMG_MIME[ext]
  if (!mime || !existsSync(p)) return ''
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`
})
// 本地视频内嵌播放：返回原始字节给渲染层转 blob URL；不放行图片以外的可执行等任意类型
ipcMain.handle('media:read-video', (_e, target: string): Uint8Array | null => {
  const { p, ext } = readMediaTarget(target)
  if (!READ_VIDEO_MIME[ext] || !existsSync(p)) return null
  try {
    return new Uint8Array(readFileSync(p))
  } catch {
    return null
  }
})
// 本地音频内嵌播放（配音结果）：与视频同一套路，只回字节，渲染层转 blob URL
ipcMain.handle('media:read-audio', (_e, target: string): Uint8Array | null => {
  const { p, ext } = readMediaTarget(target)
  if (!READ_AUDIO_MIME[ext] || !existsSync(p)) return null
  try {
    return new Uint8Array(readFileSync(p))
  } catch {
    return null
  }
})

// ---------- 聊天附件上传（输入框回形针）：图片转 data URL + 落盘媒体目录，视频/音频回 file:// ----------
// 落盘是为了让 AI 调 media MCP（图生图/图生视频）时能拿到一个稳定的本地路径引用，不受原文件移动删除影响
//
// 音频（mp3/wav/m4a…）与视频同一策略：**不读内容、不复制，直接回 file:// 原路径**。
// 语音转文字（asr MCP 的 transcribe_audio）要的就是这个绝对路径，内核按 file:// 本机读；
// 音频常常几 MB 起，转 data URL 塞进消息体只会白白撑大上下文。
const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
}
function pickName(ext: string): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `up-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}${ext}`
}
ipcMain.handle('media:pick', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWin
  const opts = {
    title: '上传图片、视频或音频',
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [
      {
        name: '图片、视频与音频',
        extensions: [
          'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg',
          'mp4', 'webm', 'mov',
          'mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac'
        ]
      },
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'] },
      { name: '视频', extensions: ['mp4', 'webm', 'mov'] },
      // 音频单列一档：用户要「语音转文字」时直接切这档，不用在一长串里找
      { name: '音频', extensions: ['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac'] }
    ]
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled) return []
  const out: { path: string; name: string; mime: string; url: string }[] = []
  const mediaDir = join(qingniaoHome(), 'media')
  for (const p of r.filePaths) {
    // 同上：[a-z]+ 会让 .mp4 这类带数字的扩展名匹配不上，视频就传不了
    const ext = p.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
    const imgMime = IMG_MIME[ext]
    const mime = imgMime ?? VIDEO_MIME[ext] ?? READ_AUDIO_MIME[ext]
    if (!mime || !existsSync(p)) continue
    if (imgMime) {
      mkdirSync(mediaDir, { recursive: true })
      const file = join(mediaDir, pickName(ext))
      copyFileSync(p, file)
      out.push({ path: file, name: basename(p), mime, url: `data:${mime};base64,${readFileSync(p).toString('base64')}` })
    } else {
      // 视频与音频都可能很大，不读内容不复制，内核进程在本机可直接按 file:// 读取
      out.push({ path: p, name: basename(p), mime, url: pathToFileURL(p).href })
    }
  }
  return out
})

// ---------- 主题背景图（设置 → 通用）：挑一张图复制进 themes 目录，回执 data URL 供渲染层持久化 ----------
// 复制而不是引用原路径：用户随时可能删掉/移动原文件，背景图不能跟着 404。
ipcMain.handle('theme-bg:pick', async (): Promise<{ path: string; url: string } | null> => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWin
  const opts: OpenDialogOptions = {
    title: '选择主题背景图',
    properties: ['openFile'],
    // 扩展名不能带点：传 '.jpg' 会被 Windows 拼成 '..jpg' 通配，文件列表直接空掉，一张都选不了
    filters: [
      { name: '图片', extensions: Object.keys(IMG_MIME).map((e) => e.slice(1)) },
      // 兜底档：万一图片是冷门格式（heic/raw 等），至少能选进来，下面再按扩展名拦并明确报错
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || !r.filePaths.length) return null
  const p = r.filePaths[0]
  const ext = p.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  const mime = IMG_MIME[ext]
  if (!mime || !existsSync(p)) {
    // 静默 return 会让人以为「点了没反应」，这里给一句人话
    if (win) {
      await dialog.showMessageBox(win, {
        type: 'warning',
        title: '不是图片',
        message: '这张文件不是可用的图片。',
        detail: `支持格式：${Object.keys(IMG_MIME).map((e) => e.slice(1)).join('、')}`,
        buttons: ['好']
      })
    }
    return null
  }
  const dir = join(qingniaoHome(), 'themes')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`)
  copyFileSync(p, file)
  return { path: file, url: `data:${mime};base64,${readFileSync(file).toString('base64')}` }
})
// 渲染层按保存的路径重新读图（换机/重启、data URL 丢了都能找回）；白名单与 media:read 同款
ipcMain.handle('theme-bg:read', (_e, target: string): string => {
  let p = String(target ?? '').trim()
  if (!p || !isAbsolute(p)) p = join(qingniaoHome(), 'themes', basename(p))
  const ext = p.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  const mime = IMG_MIME[ext]
  if (!mime || !existsSync(p)) return ''
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`
})

// ---------- 移动端接入（平台中转） ----------
// 通道在本进程里（见 relay.ts）：开关只写设置 + 起停通道，不需要重启内核。
// 状态里带二维码点阵：渲染层自己画 SVG——CSP 是 default-src 'self'，加载不了跨源图片。
ipcMain.handle('mobile:get', () => relay.status())
ipcMain.handle('mobile:set', (_e, on: boolean) => {
  setMobileEnabled(!!on)
  relay.apply()

  return relay.status()
})
// 换一张二维码：平台把那台设备的 token 换掉，旧码立即作废（通道不用重启）
ipcMain.handle('mobile:rotate', () => relay.rotate())
// 主进程读不到渲染层 localStorage，项目列表只能由渲染层推过来
ipcMain.handle('mobile:setProjects', (_e, list: { id: string; path: string; name: string }[]) => {
  relay.setProjects(list)

  return true
})

// ---------- 平台（青鸟服务端）----------
// 登录是浏览器里完成的：桌面端只负责打开登录页、接住 qingniao:// 回调、把 token 落盘并同步模型。
// 平台地址统一由 config.platformBaseUrl() 解析（环境变量 > 设置 > 默认值），这里不再存第二份。
// 每次平台状态变化都 apply 一次中转通道：登录了要注册设备、退出了要停通道。
ipcMain.handle('platform:get', () => platform.status())
// 实时探测:左下角入口/设置页打开时调——平台通不通以这一刻为准(网络/服务可能刚变化),
// 广播 platform:changed 让登录入口、账号页的积分等立即按最新可达性刷新
ipcMain.handle('platform:probe', async () => {
  const alive = await server.probe()
  const st = platform.status()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('platform:changed', st)
  }
  return alive
})
// 服务端活着没活：设置页的「远程服务」开关要根据它决定能不能操作（health 不通时操作了也是空的）
ipcMain.handle('server:alive', async () => server.probe())
ipcMain.handle('platform:login', () => platform.openLogin())
ipcMain.handle('platform:logout', async () => {
  const st = await platform.logout()
  relay.apply()

  return st
})
ipcMain.handle('platform:setBaseUrl', async (_e, url: string) => {
  const st = platform.setBaseUrl(String(url ?? ''))
  // 新地址立即重接：探测、拨远程开关、刷新中转通道，**不用重启应用**；
  // 完成后广播一次状态——左下角登录入口、账号页、关于页的「远程 URL」立即反映新平台。
  await server.reattach()
  const fresh = platform.status()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('platform:changed', fresh)
  }

  return fresh
})
// 拿授权码换 token（手动粘贴那条路；协议回调走 platform.handleCallback）
ipcMain.handle('platform:code', async (_e, code: string) => {
  const st = await platform.acceptCode(String(code ?? ''))
  relay.apply()

  return st
})
// 手动同步模型清单：拉完重启内核，让模型选择立刻反映平台改动
ipcMain.handle('platform:sync', async () => {
  const st = await platform.sync()
  await adapter.restart()
  return st
})
// 按需静默刷新：只在计价变化时用（选择器点开「内置模型」就调一次）。
// 与上面那条的区别是「模型增删才重启内核」，界面列表原地替换，不闪不空。
ipcMain.handle('platform:refresh', () => platform.refresh())

// ---------- 免费模型快照（OpenCode Zen 免 KEY + openrouter / unorouter 聚合网关）----------
// Zen 清单由内核持有（GET /config/providers）；网关清单由 freemodels.ts 向各家公开 API 拉。
// 拉到的快照都**不以独立分组出现**，由 mergeFreeModels() 并入用户配置的对应端点提供商
// （**只有 Zen 端点**吃 Zen 快照，Go 端点与 openrouter / unorouter 各自吃各的快照，见 types.ts）。
//
// 同步时机：**每次 App 窗口显示时**（渲染层 App 的 visibilitychange 监听，启动首显 / 最小化恢复 /
// 托盘唤起都会跑一次）+ 模型选择器点开时（ModelPicker 的 onOpen）。设置页的手动刷新已删。
// 没配过任何一家免费源的渲染层会直接跳过，不会白发请求。
ipcMain.handle('zen:refresh', async () => {
  // 内核侧配置（provider+models 集合）在同步前后各算一次指纹：任一家清单有增删才重启内核。
  // 官方/网关清单基本不动，绝大多数情况下（甚至永远）不会触发重启。
  const fingerprint = (s: Settings): string =>
    JSON.stringify(usableProviders(s).map((p) => [p.id, p.models.map((m) => m.id)]))
  const before = fingerprint(loadSettings())

  // 1) Zen：内核给不出（没起/超时）时 models 为空数组，**刻意不落盘**，避免把已有清单清空。
  //    「没有免费的就不显示」由 mergeFreeModels 判空负责，这里只管如实同步。
  const models = await fetchZenModels(adapter.baseUrl)
  if (models.length) setZen({ models, syncedAt: Date.now() })

  // 2) openrouter / unorouter：内部自带「空清单不落盘」的护栏
  await refreshRouterFreeModels(loadSettings())

  const after = fingerprint(loadSettings())
  if (after !== before) await adapter.restart()
  return loadSettings()
})

// ---------- 账号与用量（设置 → 账号 / 使用量）----------
// 都是「会员自己看自己的账」：token 从设置里取，未登录一律返回 null，由界面渲染成未登录态。
ipcMain.handle('platform:account', () => platform.account())
ipcMain.handle('platform:usage', (_e, range?: { from?: string; to?: string }) =>
  platform.usageSummary(range?.from, range?.to)
)
ipcMain.handle('platform:usageLogs', (_e, type?: 'consume' | 'grant' | 'adjust', page?: number) =>
  platform.usageLogs(type, page)
)
ipcMain.handle('platform:usageRecords', (_e, page?: number) => platform.usageRecords(page))

// ---------- 面板浏览器控制端点 ----------
// AI 经 panel_* MCP 工具操控右侧面板里的 webview：与用户看的是同一个浏览器（persist:webpanel
// 分区，登录态共享）。MCP server 是独立进程，通过这个本地 HTTP 端点调用主进程的 webContents。
let panelWc: WebContents | null = null
/** web-contents-created 早于 guest attach / 首次 dom-ready，不能仅凭 WebContents 存在就调用页面方法 */
let panelDomReady = false

app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() === 'webview' && wc.session === session.fromPartition('persist:webpanel')) {
    panelWc = wc
    panelDomReady = false
    wc.once('dom-ready', () => {
      if (panelWc === wc) panelDomReady = true
    })
    wc.once('destroyed', () => {
      if (panelWc === wc) {
        panelWc = null
        panelDomReady = false
      }
    })
  }
})

/**
 * 拿到面板 webview，必要时让渲染层挂一个并等它就绪。
 *
 * 面板的**可见性归用户**：AI 调用浏览器工具不该把面板弹出来，所以这里只发 wake
 * 让渲染层挂载（可以隐藏着）webview，不去动任何「打开面板」的状态。
 */
async function ensurePanel(): Promise<WebContents> {
  if (panelWc && !panelWc.isDestroyed() && panelDomReady) return panelWc
  mainWin?.webContents.send('opencode:event', { type: 'qingniao.browser.wake' })
  // 等待窗口足够久（渲染层要挂载 webview、分区会话要就绪）。太短会让模型拿到
  // 「面板浏览器未打开」后反复重试同一个调用——用户看到的就是「一直在找」。
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300))
    if (panelWc && !panelWc.isDestroyed() && panelDomReady) return panelWc
  }
  throw new Error('内置浏览器未能初始化：已请求界面挂载面板，但 6 秒内没等到 webview 就绪。请重试，若持续失败请重启应用。')
}

/** 页面可交互元素采集：给可见元素打 data-qref 编号，输出 AI 可读的清单 */
const SNAP_JS = `(() => {
  document.querySelectorAll('[data-qref]').forEach((e) => e.removeAttribute('data-qref'))
  const els = document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option]')
  const out = []
  let n = 0
  for (const el of els) {
    if (out.length >= 150) break
    const r = el.getBoundingClientRect()
    if (r.width < 2 && r.height < 2) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none') continue
    const ref = ++n
    el.setAttribute('data-qref', String(ref))
    const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 60)
    const val = 'value' in el && el.value && el.value !== label ? ' 值:' + String(el.value).slice(0, 40) : ''
    // 链接一定要带上真实 href：这是模型「找到入口」的唯一可靠依据。
    // 不带 href 时模型只能靠猜地址（实测会连猜十几个 /account/xxx、/my/xxx），
    // 而清单里的 href 就是站点自己给出的正确路径——点它的 ref 即可。
    let href = ''
    if (el.tagName === 'A') {
      const h = el.getAttribute('href') || ''
      if (h && !/^javascript:/i.test(h)) href = '  → ' + h.slice(0, 90)
    }
    out.push('[' + ref + '] ' + el.tagName.toLowerCase() + (label ? ' 「' + label + '」' : '') + val + href)
  }
  if (!out.length) return '(当前页面没有可交互元素 —— 页面可能还在加载，或内容由 canvas/图片渲染，读不出结构)'
  return out.join('\\n')
})()`

/** URL 是否同一地址（忽略末尾斜杠与 #hash） */
function sameUrl(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * 导航并**如实回报结果**。
 *
 * 旧实现是 `await wc.loadURL(u).catch(() => undefined)` 然后回 `{url: wc.getURL()}`——
 * 失败被静默吞掉，回执里给的是**上一个页面**的地址和标题，模型看到的跟成功一模一样，
 * 于是不断换地址猜（真实案例：一条「打开我的邀请」的任务里连猜 /account/referral、
 * /my/invite、/account/friend、/account/promotion… 十几个地址，53 次工具调用打不完）。
 */
async function navigateAndVerify(wc: WebContents, url: string, timeoutMs = 20000): Promise<{ ok: boolean; timedOut?: boolean; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    wc.loadURL(url).then(
      () => ({ kind: 'loaded' as const }),
      (e: { code?: string; errno?: number }) => {
        const code = String(e?.code ?? (e?.errno ? 'ERR_' + e.errno : 'LOAD_FAILED'))
        // ERR_ABORTED 多由重定向或更新的导航取代，页面本身往往已在加载，不算硬失败
        return code === 'ERR_ABORTED' ? { kind: 'loaded' as const } : { kind: 'failed' as const, code }
      }
    ),
    new Promise<{ kind: 'timeout' }>((r) => {
      timer = setTimeout(() => r({ kind: 'timeout' }), timeoutMs)
    })
  ])
  if (timer) clearTimeout(timer)
  if (outcome.kind === 'timeout') {
    // 停掉半截加载，避免后续 snapshot 读到残缺 DOM
    try {
      wc.stop()
    } catch {
      /* 已经停了 */
    }
    return { ok: true, timedOut: true }
  }
  if (outcome.kind === 'failed') return { ok: false, error: outcome.code }
  return { ok: true }
}

/**
 * 数一下当前页面有多少可交互元素。
 *
 * navigate 回执带上它，模型就能识别「这个地址根本不存在」：站点把未知路径兜成一个
 * 空壳错误页（标题「页面不存在」、只剩一个「返回首页」），此前回执只有 url+title，
 * 模型看不出异常就继续换地址猜。
 */
async function countInteractive(wc: WebContents): Promise<number | null> {
  try {
    const s = await wc.executeJavaScript(SNAP_JS, true)
    if (typeof s !== 'string') return null
    return s.startsWith('(') ? 0 : s.split('\n').filter(Boolean).length
  } catch {
    return null // 页面还在加载/已跳走：不猜，交给模型自己 snapshot
  }
}

async function panelOp(action: string, body: Record<string, unknown>): Promise<unknown> {
  if (action === 'state') {
    const wc = await ensurePanel()
    return { url: wc.getURL(), title: wc.getTitle() }
  }
  const wc = await ensurePanel()
  if (action === 'navigate') {
    const u = String(body.url ?? '').trim()
    if (!/^https?:\/\//i.test(u)) throw new Error('只支持 http/https 网址')
    const before = wc.getURL()
    const nav = await navigateAndVerify(wc, u)
    const after = wc.getURL()
    // 「导航前后地址一模一样、又不是要去的那个」= 这次导航根本没发生。
    // 这是旧实现骗过模型的地方：请求 /account/promotion，页面还停在 /account/invite-friend，
    // 回执却照样回 url+title，模型以为打开成功了，继续换地址猜。
    const stuck = sameUrl(after, before) && !sameUrl(after, u)
    const effective = nav.ok && !stuck
    return {
      requested: u,
      url: after,
      title: wc.getTitle(),
      ok: effective,
      error: !nav.ok
        ? '加载失败 ' + (nav.error ?? '')
        : stuck
          ? '导航未生效：页面仍停在原地址，请求的地址没有打开'
          : undefined,
      timedOut: nav.timedOut,
      elements: nav.ok ? await countInteractive(wc) : null
    }
  }
  if (action === 'snapshot') {
    return { url: wc.getURL(), title: wc.getTitle(), snapshot: await wc.executeJavaScript(SNAP_JS, true) }
  }
  if (action === 'click') {
    const ref = Number(body.ref)
    const ok = await wc.executeJavaScript(
      `(() => { const el = document.querySelector('[data-qref="${ref}"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true })()`,
      true
    )
    if (!ok) throw new Error(`元素 [${ref}] 不存在，页面可能已变化，请重新 snapshot`)
    return { ok: true }
  }
  if (action === 'type') {
    const ref = Number(body.ref)
    const text = String(body.text ?? '')
    // 合成事件填值：React/Vue 等受控输入监听原生 keydown/input 事件，直接赋值 + 合成 input 事件时
    // 框架的 value 追踪器不更新，页面表现像「填完一点就消失」。这里用各标签的原生 setter 绕过追踪器，
    // 再补发 input/change。textarea 没有原生 setter 可用，直接赋值。
    const ok = await wc.executeJavaScript(
      `(() => { const el = document.querySelector('[data-qref="${ref}"]'); if (!el) return false; el.focus();
        const setNative = (v) => {
          const proto = el.tagName === 'TEXTAREA' ? null : (el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype)
          if (proto) Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); else el.value = v
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        if (el.tagName === 'SELECT') {
          for (const o of el.options) if (o.value === ${JSON.stringify(text)} || (o.textContent || '').trim() === ${JSON.stringify(text)}) { setNative(o.value); return true }
          for (const o of el.options) if ((o.textContent || '').includes(${JSON.stringify(text)})) { setNative(o.value); return true }
        }
        // 模拟逐字键入：清空再填值，部分受控组件靠 input 事件序列更新内部 state
        setNative(''); setNative(${JSON.stringify(text)})
        return true })()`,
      true
    )
    if (body.submit) {
      await wc.executeJavaScript(
        `(() => { const el = document.querySelector('[data-qref="${ref}"]'); if (!el) return false; el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })); el.form?.requestSubmit?.(); return true })()`,
        true
      )
    }
    if (!ok) throw new Error(`元素 [${ref}] 不存在，页面可能已变化，请重新 snapshot`)
    return { ok: true }
  }
  throw new Error('未知操作：' + action)
}

/**
 * 全局记忆端点（memory-mcp 调）：read 取全文，append 追加一条。
 *
 * 只有追加口，没有覆盖/删除口——全局记忆会进用户之后所有项目、所有会话（含手机端）的
 * 常驻指令，让模型整段重写一次就可能长期污染；删改保留在「设置 → 记忆」由人做。
 * 写盘走 config.setGlobalMemory，**不重启内核**：AI 正在这一轮回话里，重启会掐断它的回复。
 */
async function memoryOp(action: string, body: Record<string, unknown>): Promise<unknown> {
  if (action === 'read') return { ok: true, memory: loadSettings().memory }
  if (action === 'append') {
    const r = appendGlobalMemory(String(body?.line ?? ''))
    return { ok: true, added: r.added, memory: r.memory }
  }
  throw new Error('未知操作：memory/' + action)
}

/** 本地控制端点（仅监听 127.0.0.1）：MCP server → 主进程 → 面板 webview */
function startPanelApi(): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = 39521
    const srv = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        let body: Record<string, unknown> = {}
        try { body = data ? JSON.parse(data) : {} } catch { /* 空体/坏 JSON 按空参处理 */ }
        const path = (req.url ?? '').replace(/^\/+/, '').split('?')[0]
        // `/qn/*` 是「AI 调其他模型」的授权闸门（MCP 子进程发来的），`/memory/*` 是全局记忆读写，
        // 其余是面板浏览器操作。
        // 注意 authorize 会**挂起这个响应**直到用户作答——HTTP 那侧等着，正是我们要的阻塞语义。
        const task = path.startsWith('qn/')
          ? handleGate(path.slice(3), body)
          : path.startsWith('memory/')
            ? memoryOp(path.slice(7), body)
            : panelOp(path, body)
        task
          .then((r) => res.end(JSON.stringify(r ?? { ok: true })))
          .catch((e: unknown) => res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })))
      })
    })
    srv.on('error', reject)
    const retry = (e: Error): void => {
      if (port >= 39541) { reject(e); return }
      port++
      srv.listen({ port, host: '127.0.0.1' }, () => resolve(port))
    }
    srv.listen({ port, host: '127.0.0.1' }, () => resolve(port))
    srv.on('error', retry)
  })
}

/** 面板浏览器 MCP 脚本位置（随安装包分发） */
function panelMcpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'panel-mcp.mjs')
    : join(app.getAppPath(), 'resources', 'mcp', 'panel-mcp.mjs')
}

/** 媒体生成 MCP（生图/生视频工具）脚本位置（随安装包分发） */
function mediaMcpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'media-mcp.mjs')
    : join(app.getAppPath(), 'resources', 'mcp', 'media-mcp.mjs')
}

/** 图片理解 MCP（describe_image 识图工具）脚本位置（随安装包分发） */
function visionMcpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'vision-mcp.mjs')
    : join(app.getAppPath(), 'resources', 'mcp', 'vision-mcp.mjs')
}

/** 语音合成 MCP（generate_speech 配音工具）脚本位置（随安装包分发） */
function ttsMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'tts-mcp.mjs') : join(app.getAppPath(), 'resources', 'mcp', 'tts-mcp.mjs')
}

/** 音乐生成 MCP（generate_music / check_music 工具）脚本位置（随安装包分发） */
function musicMcpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'music-mcp.mjs')
    : join(app.getAppPath(), 'resources', 'mcp', 'music-mcp.mjs')
}

/** 语音识别 MCP（transcribe_audio 听写工具）脚本位置（随安装包分发） */
function asrMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'asr-mcp.mjs') : join(app.getAppPath(), 'resources', 'mcp', 'asr-mcp.mjs')
}

/** 办公文件 MCP（office_* 读写 pdf/docx/pptx/xlsx）脚本位置（随安装包分发） */
function officeMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'office-mcp.mjs') : join(app.getAppPath(), 'resources', 'mcp', 'office-mcp.mjs')
}

/** 全局记忆 MCP（memory_read / memory_append）脚本位置（随安装包分发） */
function memoryMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'memory-mcp.mjs') : join(app.getAppPath(), 'resources', 'mcp', 'memory-mcp.mjs')
}

/** 数据处理 MCP（json_query / regex_find）脚本位置（随安装包分发） */
function dataMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'data-mcp.mjs') : join(app.getAppPath(), 'resources', 'mcp', 'data-mcp.mjs')
}

ipcMain.handle('settings:get', () => loadSettings())

/** 渲染层停止兜底用：内核健康探测（主进程 isHealthy，不经内核 REST） */
ipcMain.handle('kernel:health', () => adapter.isHealthy())

// 保存即生效：写 ~/.qingniaoai 并重启内核（provider/MCP 变更后需重载）。
// 重启**后台进行、不 await**（2026-09-24 用户反馈：弹窗要陪内核重启走完才关，太慢）——
// 内核冷启动要数秒，设置先落盘、IPC 立即返回让弹窗马上关掉；重启完成后的界面刷新
// 由事件桥负责（qingniao.kernel.started / kernel.unhealthy，ChatView 已有整套处理）。
// restart() 内部自带串行 + 合并，连点保存不会并发 spawn 多个内核。
ipcMain.handle('settings:save', async (_e, s: Settings) => {
  saveSettings(s)
  void adapter.restart().catch((e: unknown) => console.error('[opencode] 设置变更后重启内核失败', e))
  // 「远程服务」这个全局总开关（只能改配置文件）：关掉它要顺手把中转通道停掉（一个请求都不再发）。
  // apply() 只看登录态/开关，不依赖内核端口，不必等重启完成。
  relay.apply()
})

/**
 * 更新**全局**访问权限档位（对话区「选择文件夹」右侧的档位选择器）。
 *
 * 权限对所有文件夹生效，不分项目，所以只传档位、不传路径。
 *
 * 保存后**立即重启内核**让档位生效——内核的 permission 是启动时读的，
 * 不重启切了等于没切。用户明确要求「切换权限就要重启内核」，
 * 重启正在跑的任务会被打断，但这是让权限即刻生效唯一可靠的办法。
 */
ipcMain.handle('settings:setAccess', async (_e, req: { level: AccessLevel }) => {
  // 返回落盘后的完整 Settings：渲染层 setSettings(await setAccess(level)) 靠它回读，
  // 不 return 的话渲染层拿到 undefined，下一次渲染 settings.access 直接崩（白屏）。
  const s = setAccess(req?.level === 'full' ? 'full' : 'default')
  // 与 settings:save 同因：内核重启后台进行，不陪弹窗跑完全程（生效靠 kernel.started 事件刷新）
  void adapter.restart().catch((e: unknown) => console.error('[opencode] 切换权限后重启内核失败', e))
  relay.apply()
  return s
})

/**
 * 应答内核的权限询问（permission.asked 事件）。
 *
 * 内核 REST 有两个版本的端点，`/permission/{id}/reply` 是当前 `GET /permission` 配套的那个
 * （body: { reply: once|always|reject }），旧的按会话走的 `/session/{sid}/permissions/{id}`
 * （body: { response }）作为兜底——内核升级/降级时至少有一条能成。
 */
ipcMain.handle(
  'permission:reply',
  async (_e, req: { id: string; sessionID?: string; reply: 'once' | 'always' | 'reject' }) => {
    const id = String(req?.id ?? '').trim()
    if (!id) return '权限请求 id 为空'
    const reply = req?.reply === 'always' ? 'always' : req?.reply === 'reject' ? 'reject' : 'once'
    const dir = String(req?.sessionID ?? '').trim()
    try {
      const r = await adapter.api(`/permission/${encodeURIComponent(id)}/reply`, 'POST', { reply })
      if (r.status >= 200 && r.status < 300) return ''
      // 兜底：按会话走的旧端点
      if (dir) {
        const r2 = await adapter.api(
          `/session/${encodeURIComponent(dir)}/permissions/${encodeURIComponent(id)}`,
          'POST',
          { response: reply }
        )
        if (r2.status >= 200 && r2.status < 300) return ''
      }
      return `应答失败（HTTP ${r.status}）`
    } catch (err) {
      return String((err as Error).message ?? err)
    }
  }
)

/**
 * 「AI 调用其他模型」授权闸门（见 gate.ts）。
 *
 * 闸门把 MCP 的 HTTP 请求挂着，靠 IPC 推卡到界面、再由这里把用户的答案解回去。
 * 之所以走 IPC 而不是让界面来轮询：这一步是**阻塞式**的（MCP 那边在等），
 * 轮询的延迟会直接叠加到每一次识图/生图的体感上。
 */
setModelAuthSink((channel, payload) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload)
})

/**
 * 更新状态的变化（检查完成、下载进度、下载结束/失败）推给界面。
 *
 * 走事件而不是让界面轮询：下载时进度是每 300ms 一跳的，轮询要么太密（无谓 IPC）、
 * 要么太疏（进度条一顿一顿）；而"检查完成"这种一次性结果用轮询还得额外判重。
 */
setUpdateSink((s) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:changed', s)
})

/**
 * 启动后自动查一次更新，之后每 4 小时查一次（仅打包态；dev 版本号恒等于源码，没有"新版"可比）。
 * 只做「发现」并把状态推给界面——侧栏「工作区」右侧的更新入口、设置→关于 都靠这条状态点亮；
 * 下载与安装永远等用户在界面上点，绝不静默下载。
 */
if (app.isPackaged) {
  const CHECK_MS = 4 * 60 * 60 * 1000
  setTimeout(() => void checkUpdate(), 20_000) // 等窗口建好、网络栈就绪再查（checkUpdate 内部自带 8s 超时）
  setInterval(() => void checkUpdate(), CHECK_MS)
}

ipcMain.handle(
  'modelauth:reply',
  (_e, req: { reqId: string; scope: 'once' | 'session' | 'always' | 'reject' }) => {
    const scope: 'once' | 'session' | 'always' | 'reject' =
      req?.scope === 'always' || req?.scope === 'session' || req?.scope === 'once' ? req.scope : 'reject'
    // 卡片可能已经因超时自动作废：返回失败原因让界面知道「这一答案没人接」，别静默当成功
    return replyModelAuth(String(req?.reqId ?? ''), scope)
      ? ''
      : '这张授权卡已经失效（等待超时，那次调用已按拒绝处理）'
  }
)

/** 永久授权清单（设置界面展示 / 撤销用） */
ipcMain.handle('modelauth:list', () => modelAuthList())

/** 撤销某条永久授权（key 省略＝清空全部，会话级一并失效） */
ipcMain.handle('modelauth:revoke', (_e, key?: string) => revokeModelAuth(typeof key === 'string' ? key : undefined))

/** 拉取 OpenAI 兼容端点的模型列表：GET {baseURL}/models */
ipcMain.handle('models:fetch', async (_e, req: { baseURL: string; apiKey?: string }) => {
  try {
    const url = req.baseURL.trim().replace(/\/+$/, '') + '/models'
    const res = await fetch(url, {
      headers: req.apiKey ? { authorization: `Bearer ${req.apiKey.trim()}` } : undefined
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const j = (await res.json()) as { data?: { id: string }[] }
    return { models: (j.data ?? []).map((m) => m.id) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})

// 项目记忆：每个项目目录下的 .qingniao/memory/（MEMORY.md 长期 + YYYY-MM-DD.md 每日），
// 跟项目走（可 git/同步），不进应用配置。AI 在新对话自动加载，并在工作中自行维护。
function memDir(projectPath: string): string {
  return join(projectPath, '.qingniao', 'memory')
}
function memTodayFile(projectPath: string): string {
  return join(memDir(projectPath), new Date().toISOString().slice(0, 10) + '.md')
}
function readFileText(p: string): string {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}
function safeRead(p: string): string {
  return readFileText(p).trim()
}
ipcMain.handle('memory:read', (_e, projectPath: string) => {
  const d = memDir(projectPath)
  mkdirSync(d, { recursive: true })
  return { long: safeRead(join(d, 'MEMORY.md')), daily: safeRead(memTodayFile(projectPath)) }
})
ipcMain.handle('memory:append', (_e, req: { projectPath: string; content: string }) => {
  const d = memDir(req.projectPath)
  mkdirSync(d, { recursive: true })
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
  appendFileSync(memTodayFile(req.projectPath), `\n## ${stamp}\n\n${req.content}\n`, 'utf8')
})

// ---------- 更新（设置 → 关于）----------
// 对着 GitHub Releases 查最新版；有新版就下载安装包、由安装包自己完成升级（见 updater.ts）。
// 每次都是现查现用，不落盘缓存版本信息——"三天前查到有新版本"不该被当成事实摆给用户看。
ipcMain.handle('update:get', () => updateState())
ipcMain.handle('update:check', () => checkUpdate())
ipcMain.handle('update:download', () => downloadUpdate())
ipcMain.handle('update:cancel', () => cancelDownload())
ipcMain.handle('update:install', () => installUpdate())
ipcMain.handle('update:openRelease', (_e, tag?: string) => openReleasePage(typeof tag === 'string' ? tag : undefined))

// ---------- 第三方依赖清单（设置 → 依赖）----------
// 清单来自应用自己的 package.json（声明范围），版本号与协议优先到 node_modules 里读**真实值**；
// 打包后包里只留了运行时必需的几个 node_modules，其余靠构建时拍的快照 resources/deps.json 兜底，
// 所以在装好的应用里看到的协议同样是包自己声明的那一个，不是猜的。
function readJsonFile(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 取包声明的协议：license 可能是字符串、{ type } 对象，或旧式的 licenses 数组 */
function pkgLicenseField(j: Record<string, unknown>): string {
  const raw = j['license']
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string')
    return ((raw as { type: string }).type ?? '').trim()
  const arr = j['licenses']
  if (Array.isArray(arr)) {
    for (const one of arr) {
      if (typeof one === 'string' && one.trim()) return one.trim()
      if (one && typeof one === 'object' && typeof (one as { type?: unknown }).type === 'string')
        return ((one as { type: string }).type ?? '').trim()
    }
  }
  return ''
}

/**
 * 包没在 package.json 写 license 时（如 exif-parser），读包里的 LICENSE 文件首段认 SPDX。
 * 只认最前面 4000 字符——协议正文都在开头，且避免把整份 LICENSE 读进来比对。
 */
const SPDX_RULES: [RegExp, string][] = [
  [/Apache License/i, 'Apache-2.0'],
  [/Mozilla Public License/i, 'MPL-2.0'],
  [/\bISC\b/i, 'ISC'],
  [/\bMIT\b/i, 'MIT'],
  [/BSD[- ]?3|BSD 3-Clause/i, 'BSD-3-Clause'],
  [/BSD[- ]?2|BSD 2-Clause/i, 'BSD-2-Clause'],
  [/0BSD/i, '0BSD'],
  [/The Unlicense/i, 'Unlicense']
]
function sniffLicense(dir: string): string {
  try {
    if (!existsSync(dir)) return ''
    const hit = readdirSync(dir).find((n) => /^licen[cs]e(\.|$)/i.test(n))
    if (!hit) return ''
    const head = readFileSync(join(dir, hit), 'utf8').slice(0, 4000)
    // GPL/LGPL 要细分版本（2 / 3 差一个数字，义务完全不同），所以单独判一次再走通用表
    if (/General Public License/i.test(head))
      return /Version\s*2\b/i.test(head) ? 'GPL-2.0' : 'GPL-3.0'
    if (/Lesser General Public License/i.test(head))
      return /Version\s*2(\.1)?\b/i.test(head) ? 'LGPL-2.1' : 'LGPL-3.0'
    for (const [re, spdx] of SPDX_RULES) if (re.test(head)) return spdx
  } catch {
    /* 读不到就当未知 */
  }
  return ''
}

/** 构建时拍的快照（scripts/gen-deps.mjs 生成）：按包名索引，兜底用 */
function depsSnapshot(): Record<string, { version?: string; license?: string }> {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'deps.json')
    : join(app.getAppPath(), 'resources', 'deps.json')
  const j = readJsonFile(file)
  const items = (j?.['items'] as { name?: string; version?: string; license?: string }[] | undefined) ?? []
  const map: Record<string, { version?: string; license?: string }> = {}
  for (const it of items) if (it?.name) map[it.name] = { version: it.version, license: it.license }
  return map
}

ipcMain.handle('deps:list', (): DepItem[] => {
  const root = app.getAppPath()
  const pkg = readJsonFile(join(root, 'package.json'))
  if (!pkg) return []
  const snap = depsSnapshot()
  const out: DepItem[] = []
  const collect = (m: unknown, dev: boolean): void => {
    if (!m || typeof m !== 'object') return
    for (const [name, range] of Object.entries(m as Record<string, unknown>)) {
      const declared = typeof range === 'string' ? range : ''
      const dir = join(root, 'node_modules', name)
      const inst = readJsonFile(join(dir, 'package.json'))
      let version = typeof inst?.['version'] === 'string' ? (inst['version'] as string) : ''
      let license = inst ? pkgLicenseField(inst) : ''
      if (!license) license = sniffLicense(dir)
      if (!version) version = snap[name]?.version ?? declared.replace(/^[\^~>=<v ]+/, '')
      if (!license) license = snap[name]?.license ?? '未知'
      out.push({ name, declared, version, license, dev })
    }
  }
  collect(pkg['dependencies'], false)
  collect(pkg['devDependencies'], true)
  return out.sort((a, b) => a.name.localeCompare(b.name))
})

// ---------- 技能（Skills）----------
// 内核按目录发现 SKILL.md：全局 ~/.qingniaoai/opencode/skills/<name>/SKILL.md，
// 项目 <项目>/.opencode/skills/<name>/SKILL.md（见 opencode.ai/docs/skills）。
// 这里只读写青鸟自己的这两处，UI 语义清晰；内核另外兼容的 .claude / .agents 目录不在此列。
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function skillsRoot(scope: SkillScope, projectPath?: string | null): string {
  return scope === 'global' ? join(opencodeConfigDir(), 'skills') : join(projectPath ?? '', '.opencode', 'skills')
}

// ---------- 内置技能 ----------
// 内置技能随安装包放在 resources/builtin-skills/<name>/SKILL.md。内核只认全局/项目
// 两个发现目录，没有「第三个目录」的配置项，所以启动时同步复制进全局技能目录。
// 清单（builtin-skills.json）记录上次写入的内容指纹，用于区分三种情况：
// 目标没被用户改过 → 随版本升级覆盖；被改过 → 跳过、尊重用户版本；
// 被用户删掉（目录不存在）→ 不再恢复。
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')
const builtinManifestFile = () => join(opencodeConfigDir(), 'builtin-skills.json')

function readBuiltinManifest(): Record<string, { hash: string }> {
  try {
    const v = JSON.parse(readFileSync(builtinManifestFile(), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function syncBuiltinSkills(): void {
  const from = app.isPackaged
    ? join(process.resourcesPath, 'builtin-skills')
    : join(app.getAppPath(), 'resources', 'builtin-skills')
  let names: string[]
  try {
    names = readdirSync(from, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return // 源目录缺失：静默跳过，不影响启动
  }
  const manifest = readBuiltinManifest()
  const root = skillsRoot('global')
  let dirty = false
  for (const name of names) {
    const src = readFileText(join(from, name, 'SKILL.md'))
    if (!src) continue
    const file = join(root, name, 'SKILL.md')
    const cur = existsSync(file) ? readFileText(file) : ''
    if (cur === src) continue // 已是最新
    if (cur && manifest[name]?.hash !== sha256(cur)) continue // 被用户改过：尊重用户版本
    if (!cur && manifest[name]) continue // 被用户删过：不恢复
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(file, src)
    manifest[name] = { hash: sha256(src) }
    dirty = true
  }
  for (const name of Object.keys(manifest)) {
    if (!names.includes(name)) {
      delete manifest[name] // 安装包已移除的内置技能：清掉清单，残留文件留在全局目录当普通技能
      dirty = true
    }
  }
  if (dirty) writeFileSync(builtinManifestFile(), JSON.stringify(manifest, null, 2), 'utf8')
}

/** 写回 frontmatter 时的标量转义：含冒号/井号或非普通字符时加双引号，避免 YAML 解析炸掉 */
function yamlScalar(v: string): string {
  const flat = v.replace(/\s*\n+\s*/g, ' ').trim()
  return /^[\w\u4e00-\u9fa5][^:#\n]*$/.test(flat) ? flat : '"' + flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** 极简 frontmatter 解析：只认 name / description 两个标量，不引 YAML 依赖（层级字段忽略） */
function parseSkill(text: string): { name: string; description: string; body: string; hasFm: boolean } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''))
  if (!m) return { name: '', description: '', body: text, hasFm: false }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2].trim()
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1)
    data[kv[1]] = v
  }
  return { name: data.name ?? '', description: data.description ?? '', body: m[2], hasFm: true }
}

/** 扫一个作用域下的技能目录，顺带按内核规则做 frontmatter 校验（不合法不隐藏，标红提示） */
function listSkills(scope: SkillScope, projectPath?: string | null): SkillItem[] {
  if (scope === 'project' && !projectPath) return []
  const root = skillsRoot(scope, projectPath)
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return [] // 目录还不存在：没有技能，不是错误
  }
  const out: SkillItem[] = []
  for (const name of names) {
    const file = join(root, name, 'SKILL.md')
    if (!existsSync(file)) continue // 目录里没有 SKILL.md 就不算技能
    const fm = parseSkill(readFileText(file))
    let error: string | undefined
    if (!fm.hasFm) error = '缺少 YAML frontmatter（文件需以 --- 开头）'
    else if (!fm.name) error = 'frontmatter 缺少 name'
    else if (fm.name !== name) error = `name 与目录名不一致（${fm.name}）`
    else if (!SKILL_NAME_RE.test(fm.name) || name.length > 64) error = 'name 只允许小写字母、数字与单个连字符连接'
    else if (!fm.description) error = 'frontmatter 缺少 description'
    else if (fm.description.length > 1024) error = 'description 超过 1024 字符'
    out.push({ name, scope, path: file, description: fm.description, error })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

ipcMain.handle('skills:list', (_e, req: { projectPath?: string | null }) => {
  const manifest = readBuiltinManifest()
  return [
    // 与安装包内容一致的算内置技能；被用户改过的按普通全局技能对待（可编辑可删除）
    ...listSkills('global').map((s) => (manifest[s.name]?.hash === sha256(readFileText(s.path)) ? { ...s, builtin: true } : s)),
    ...listSkills('project', req?.projectPath)
  ]
})

/** 读单条技能并拆出 frontmatter / 正文，供编辑弹窗回填 */
ipcMain.handle('skills:read', (_e, req: { scope: SkillScope; projectPath?: string | null; name: string }) =>
  parseSkill(readFileText(join(skillsRoot(req.scope, req.projectPath), req.name, 'SKILL.md')))
)

ipcMain.handle('skills:save', async (_e, req: SkillDraft) => {
  if (req.scope === 'project' && !req.projectPath) return { error: '请先打开一个项目，再创建项目级技能' }
  const name = req.name.trim().toLowerCase()
  const description = req.description.replace(/\s*\n+\s*/g, ' ').trim()
  if (!SKILL_NAME_RE.test(name) || name.length > 64)
    return { error: '名称不合法：只允许小写字母、数字，用单个连字符连接（如 git-commit-zh）' }
  if (!description) return { error: '请填写描述——模型靠它判断什么时候加载这个技能' }
  if (description.length > 1024) return { error: '描述不能超过 1024 字符' }
  const root = skillsRoot(req.scope, req.projectPath)
  const target = join(root, name)
  const renaming = !!req.originalName && req.originalName !== name
  if (renaming && existsSync(target)) return { error: '同名技能已存在：' + name }
  if (renaming) rmSync(join(root, req.originalName as string), { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const body = req.body.replace(/^\s*\n+/, '').replace(/\s+$/, '')
  writeFileSync(join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n---\n\n${body}\n`, 'utf8')
  await reloadKernelForSkills()
  return {}
})

ipcMain.handle('skills:remove', async (_e, req: { scope: SkillScope; projectPath?: string | null; name: string }) => {
  if (req.scope === 'project' && !req.projectPath) return
  rmSync(join(skillsRoot(req.scope, req.projectPath), req.name), { recursive: true, force: true })
  await reloadKernelForSkills()
})

/**
 * 技能是「启动时加载」的配置：内核把可用技能列表写进 skill 工具的 description，
 * 运行中不会热更新。改动后必须重启内核才会被模型看到——与 MCP/提供商变更同一机制。
 */
async function reloadKernelForSkills(): Promise<void> {
  // 后台重启、不 await（与 settings:save 同因：技能弹窗不必陪内核冷启动跑完全程）。
  // 重启失败不吞掉用户刚保存的文件；内核侧会走 onUnhealthy 提示渲染层自动恢复。
  void adapter.restart().catch((e: unknown) => {
    console.error('[skills] 重启内核失败：', e instanceof Error ? e.message : e)
  })
}

/** 在系统文件管理器里打开技能目录，方便手动编辑 */
ipcMain.handle('skills:openDir', (_e, req: { scope: SkillScope; projectPath?: string | null }) => {
  if (req.scope === 'project' && !req.projectPath) return ''
  const dir = skillsRoot(req.scope, req.projectPath)
  mkdirSync(dir, { recursive: true })
  return shell.openPath(dir)
})

// ---------- 计划任务（左栏「计划任务」区块：数据 + 触发都在主进程，关窗驻留托盘也照跑） ----------
ipcMain.handle('schedule:list', () => readSchedules())
ipcMain.handle('schedule:save', (_e, t: ScheduleTask) => upsertSchedule(t))
ipcMain.handle('schedule:remove', (_e, id: string) => removeSchedule(id))
ipcMain.handle('schedule:reorder', (_e, ids: string[]) => reorderSchedules(ids))
ipcMain.handle('schedule:runNow', (_e, id: string) => runScheduleNow(id))

// ---------- 对话级服务进程（AI 在会话里启动的常驻服务，对话内可查看/停止；见 procstore.ts） ----------
ipcMain.handle('proc:list', (_e, sid: string) => procList(sid))
ipcMain.handle('proc:add', (_e, req: { sid: string; proc: { pid: number; cmd: string; port?: number; startedAt: number } }) =>
  procAdd(req.sid, req.proc)
)
ipcMain.handle('proc:kill', (_e, req: { sid: string; pid: number }) => procKill(req.sid, req.pid))

// 自绘标题栏的窗口控制
ipcMain.on('win:min', () => mainWin?.minimize())
ipcMain.on('win:max', () => {
  if (!mainWin) return
  mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize()
})
// 右上角 X = 隐藏到系统托盘（长任务继续跑，点托盘图标即恢复）；真退出走托盘菜单「退出」/ Alt+F4
ipcMain.on('win:close', () => mainWin?.hide())
ipcMain.handle('win:isMax', () => mainWin?.isMaximized() ?? false)

// ---------- 系统托盘：右上角 X 隐藏后驻留，点图标恢复窗口 ----------
let tray: Tray | null = null

function showMainWin(): void {
  if (!mainWin || mainWin.isDestroyed()) return
  if (!mainWin.isVisible()) mainWin.show()
  mainWin.restore()
  mainWin.focus()
}

function createTray(): void {
  // macOS 不建托盘：NSStatusItem 按 icon.png 原始尺寸渲染，1024px 图标在菜单栏占满整行；
  // mac 的驻留恢复走 Dock——关窗隐藏后点 Dock 图标由 activate 事件唤回（见 app.whenReady 尾部）
  if (process.platform === 'darwin') return
  if (tray) return
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'image', 'icon.png')
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.setToolTip('青鸟 QingNiao')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开青鸟', click: showMainWin },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
  tray.on('click', showMainWin)
  tray.on('double-click', showMainWin)
}

// ---------- 单实例锁 + qingniao:// 协议 ----------
// 网页登录成功后跳 qingniao://auth?code=xxx。Windows 上这表现为「又启动了一个进程」，
// 参数里带着那个 URL，所以必须锁单实例：第二个进程把 URL 交给已在跑的实例后立刻退出。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(AUTH_PROTOCOL + ':'))
    if (url) void platform.handleCallback(url)
    showMainWin()
  })
  // macOS：应用已在运行时由系统直接投递 open-url
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (url.startsWith(AUTH_PROTOCOL + ':')) void platform.handleCallback(url)
  })
  // 注册协议：安装版注册自身；dev 下要注册 electron 可执行文件 + 当前入口脚本
  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL)
  }
}

// GPU 进程连续崩溃（exit_code=-1073741819）时整个 App 会直接退出：
// 光 disableHardwareAcceleration 不够（软件合成仍会拉起 GPU 进程），
// 要用命令行开关彻底禁掉 GPU 进程。必须在 ready 之前调用。
if (process.env.QN_DISABLE_GPU) {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.disableHardwareAcceleration()
}

app.whenReady().then(async () => {
  // Windows 任务栏图标归属（否则 dev 模式可能沿用 Electron 默认图标）
  app.setAppUserModelId('com.qingniao.desktop')
  Menu.setApplicationMenu(null) // 去掉原生菜单，交互全部走应用内 UI
  // 旧版把工作台散在 ~/qingniaoai-workspace，现收编到 ~/.qingniaoai/workspace：
  // 新位置还没有内容且旧目录存在时**一次性改名搬走**（保留用户已有任务文件）；
  // 两处都在（用户新旧版本都跑过）则不动旧目录——不替用户删数据，留给用户自行清理。
  const legacyWorkspace = join(app.getPath('home'), 'qingniaoai-workspace')
  if (!existsSync(workspace) && existsSync(legacyWorkspace)) {
    try {
      renameSync(legacyWorkspace, workspace)
    } catch {
      /* 搬不动（目录被占用等）就落到下面的 mkdirSync 新建空目录，旧目录用户可手动删 */
    }
  }
  mkdirSync(workspace, { recursive: true })
  const panelPort = await startPanelApi() // 面板浏览器控制端点：MCP 配置要带上端口，先于内核配置
  syncBuiltinSkills() // 技能是内核启动时加载的，同步要在拉起内核之前
  setPanelMcp({ path: panelMcpPath(), port: panelPort })
  setMediaMcp({ path: mediaMcpPath() })
  setVisionMcp({ path: visionMcpPath() })
  setTtsMcp({ path: ttsMcpPath() })
  setMusicMcp({ path: musicMcpPath() })
  setAsrMcp({ path: asrMcpPath() })
  setOfficeMcp({ path: officeMcpPath() })
  setMemoryMcp({ path: memoryMcpPath() })
  setDataMcp({ path: dataMcpPath() })
  // 平台服务端（青鸟平台，Go 单二进制）：探测 health，不通时在本机扫顺延端口并落盘修正地址。
  // 必须在 writeOpencodeConfig 之前——发现出的新端口要写进内核的平台网关地址；
  // 也必须在 relay.apply() 之前——远程开关是 apply 的前提，否则服务端起来了也不会注册设备。
  await server.ensure()
  writeOpencodeConfig(loadSettings())
  adapter.bin = opencodeBin()
  adapter.workspace = workspace
  // 事件桥统一走这里：窗口销毁后静默丢弃，避免 "Object has been destroyed" 未处理拒绝。
  // 同时喂给中转通道——手机上的「实时」就是靠这里把内核事件推上平台的。
  adapter.pushEvent = (e) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('opencode:event', e)
    relay.onKernelEvent(e)
  }
  // 内核异常退出/断连：提示渲染层并自动重启内核
  adapter.onUnhealthy = () => {
    if (!mainWin || mainWin.isDestroyed()) return
    mainWin.webContents.send('opencode:event', {
      type: 'qingniao.kernel.unhealthy',
      properties: {}
    })
    // 自动重启内核（失败则下一轮事件触发时再试）
    adapter.restart().catch((e) => console.error('[opencode] 自动重启失败', e))
  }
  try {
    await adapter.start()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const win = new BrowserWindow({ width: 480, height: 240 })
    win.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`<body style="font-family:sans-serif;padding:24px;background:#15181e;color:#e6e6e6"><h2>启动失败</h2><p>${msg}</p></body>`)
    )
    return
  }
  createWindow()

  createTray() // 右上角 X 隐藏后驻留托盘，点图标恢复

  // 计划任务调度器：关窗只隐藏、进程驻留托盘，到点照跑；
  // 错过的时刻（当时应用没在跑）不补跑——schedules.json 读入时已把过期的 nextRun 推进到下个周期
  startScheduler(workspace, (r) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('schedule:ran', r)
  })

  // 设备注册是异步的（要向平台换一张设备 token），注册完才知道二维码内容，
  // 所以状态一变就主动推给渲染层——否则登录后面板一直停在「二维码生成中…」。
  relay.onChange = () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('mobile:changed', relay.status())
  }

  // 手机发来的回合：把 busy 事实注入事件桥，桌面渲染层据此即时亮「处理中」
  // （内核出 delta 前就点亮，与桌面自己发消息的乐观处理对称）。
  relay.onBusy = (sid, on) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('opencode:event', { type: 'session.busy', properties: { sessionID: sid, busy: on } })
  }

  // 移动端中转通道：登录了就注册设备（二维码随即可用），开关开着才真的开始认领指令。
  // 服务端可用性探测已提前到写内核配置之前（见上方 server.ensure()）。
  relay.apply()

  // 平台模型清单静默对一遍（限免/折扣/倍率会变），跟登录态无关地跑一次：没登录时它什么也不做
  void platform.refreshOnBoot()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    // mac 没有托盘：红 X 隐藏（hide 未销毁）的窗口靠点 Dock 图标唤回——窗口还在列表里，
    // 只按「数量为 0」重建的话隐藏窗口永远出不来
    else showMainWin()
  })
})

app.on('window-all-closed', () => {
  // 还在等用户作答的「调用其他模型」授权：应用都关了就别再等，全部按拒绝结掉。
  // 不做的话连接会随进程一起断，MCP 侧 fetch 抛错 → 按 fail-open 放行 → 模型照调，白问一场。
  rejectAllPending()
  relay.stop()
  // 只收自己拉起的那份服务端：用户自己起的（独立部署）不动，否则关掉桌面端会把他人的服务一起干掉。
  server.stop()
  // shutdown 而非 stop：置 quitting 阻断任何进行中的内核重启轮次，杀进程树（含 MCP/pty 子进程），
  // 防止「应用退了、孤儿内核还在后台跑任务」——见 adapter.shutdown 注释
  adapter.shutdown()
  app.quit()
})

// before-quit 兜底（更新器安装等 app.quit() 入口）：window-all-closed 理论上必发，这里双保险且幂等
app.on('before-quit', () => {
  adapter.shutdown()
  server.stop()
})
