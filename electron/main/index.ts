import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { adapter } from './adapter.ts'
import { loadSettings, saveSettings, writeOpencodeConfig, type Settings } from './config.ts'

/**
 * 主进程职责：
 * 1. 拉起 OpenCode 内核（`opencode serve`，REST + SSE），配置与会话存储隔离在 ~/.qingniaoai
 * 2. 渲染进程 REST 门面由 adapter 透传（OpenCode 原生 API，无协议翻译）
 * 3. 应用级 IPC：目录选择、设置读写（保存即重启内核）、provider 模型列表拉取
 */

let mainWin: BrowserWindow | null = null

// agent 的默认工作目录（"工作台"项目）
const workspace = join(app.getPath('home'), 'qingniaoai-workspace')

/** dev：node_modules/opencode-ai/bin；打包：resources/bin（electron-builder extraResources 拷贝） */
function opencodeBin(): string {
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  if (app.isPackaged) return join(process.resourcesPath, 'bin', exe)
  return join(app.getAppPath(), 'node_modules', 'opencode-ai', 'bin', exe)
}

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png')
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
      sandbox: false
    }
  })
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  const sendMax = (v: boolean) => mainWin?.webContents.send('win:maximized', v)
  mainWin.on('maximize', () => sendMax(true))
  mainWin.on('unmaximize', () => sendMax(false))
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

ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('settings:get', () => loadSettings())

// 保存即生效：写 ~/.qingniaoai 并重启内核（provider/MCP 变更后需重载）
ipcMain.handle('settings:save', async (_e, s: Settings) => {
  saveSettings(s)
  await adapter.restart()
})

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

// 自绘标题栏的窗口控制
ipcMain.on('win:min', () => mainWin?.minimize())
ipcMain.on('win:max', () => {
  if (!mainWin) return
  mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize()
})
ipcMain.on('win:close', () => mainWin?.close())
ipcMain.handle('win:isMax', () => mainWin?.isMaximized() ?? false)

app.whenReady().then(async () => {
  // Windows 任务栏图标归属（否则 dev 模式可能沿用 Electron 默认图标）
  app.setAppUserModelId('com.qingniao.desktop')
  Menu.setApplicationMenu(null) // 去掉原生菜单，交互全部走应用内 UI
  mkdirSync(workspace, { recursive: true })
  writeOpencodeConfig(loadSettings())
  adapter.bin = opencodeBin()
  adapter.workspace = workspace
  // 事件桥统一走这里：窗口销毁后静默丢弃，避免 "Object has been destroyed" 未处理拒绝
  adapter.pushEvent = (e) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('opencode:event', e)
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  adapter.stop()
  app.quit()
})
