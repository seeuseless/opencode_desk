import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapter } from './adapter.ts'
import { loadSettings, opencodeConfigDir, saveSettings, writeOpencodeConfig, type Settings } from './config.ts'
import type { SkillDraft, SkillItem, SkillScope } from './types.ts'

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

/** 渲染层停止兜底用：内核健康探测（主进程 isHealthy，不经内核 REST） */
ipcMain.handle('kernel:health', () => adapter.isHealthy())

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

// ---------- 技能（Skills）----------
// 内核按目录发现 SKILL.md：全局 ~/.qingniaoai/opencode/skills/<name>/SKILL.md，
// 项目 <项目>/.opencode/skills/<name>/SKILL.md（见 opencode.ai/docs/skills）。
// 这里只读写青鸟自己的这两处，UI 语义清晰；内核另外兼容的 .claude / .agents 目录不在此列。
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function skillsRoot(scope: SkillScope, projectPath?: string | null): string {
  return scope === 'global' ? join(opencodeConfigDir(), 'skills') : join(projectPath ?? '', '.opencode', 'skills')
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

ipcMain.handle('skills:list', (_e, req: { projectPath?: string | null }) => [
  ...listSkills('global'),
  ...listSkills('project', req?.projectPath)
])

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
  try {
    await adapter.restart()
  } catch (e) {
    // 重启失败不吞掉用户刚保存的文件；内核侧会走 onUnhealthy 提示渲染层
    console.error('[skills] 重启内核失败：', e instanceof Error ? e.message : e)
  }
}

/** 在系统文件管理器里打开技能目录，方便手动编辑 */
ipcMain.handle('skills:openDir', (_e, req: { scope: SkillScope; projectPath?: string | null }) => {
  if (req.scope === 'project' && !req.projectPath) return ''
  const dir = skillsRoot(req.scope, req.projectPath)
  mkdirSync(dir, { recursive: true })
  return shell.openPath(dir)
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
