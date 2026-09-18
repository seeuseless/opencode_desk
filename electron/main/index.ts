import { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, type WebContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { adapter } from './adapter.ts'
import { loadSettings, opencodeConfigDir, saveSettings, setPanelMcp, writeOpencodeConfig, type Settings } from './config.ts'
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

// 浏览面板的「在外部浏览器打开」：只放行网页地址
ipcMain.handle('openExternal', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
})

// ---------- 面板浏览器控制端点 ----------
// AI 经 panel_* MCP 工具操控右侧面板里的 webview：与用户看的是同一个浏览器（persist:webpanel
// 分区，登录态共享）。MCP server 是独立进程，通过这个本地 HTTP 端点调用主进程的 webContents。
let panelWc: WebContents | null = null

app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() === 'webview' && wc.session === session.fromPartition('persist:webpanel')) {
    panelWc = wc
    wc.once('destroyed', () => {
      if (panelWc === wc) panelWc = null
    })
  }
})

/** 面板没开时通知渲染层打开，并等它创建好（MCP navigate 场景：AI 想浏览而面板关着） */
async function ensurePanel(): Promise<WebContents> {
  if (panelWc && !panelWc.isDestroyed()) return panelWc
  mainWin?.webContents.send('opencode:event', { type: 'qingniao.browser.open' })
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300))
    if (panelWc && !panelWc.isDestroyed()) return panelWc
  }
  throw new Error('面板浏览器未打开')
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
    out.push('[' + ref + '] ' + el.tagName.toLowerCase() + (label ? ' 「' + label + '」' : '') + val)
  }
  return out.join('\\n')
})()`

async function panelOp(action: string, body: Record<string, unknown>): Promise<unknown> {
  if (action === 'state') {
    const wc = await ensurePanel()
    return { url: wc.getURL(), title: wc.getTitle() }
  }
  const wc = await ensurePanel()
  if (action === 'navigate') {
    const u = String(body.url ?? '').trim()
    if (!/^https?:\/\//i.test(u)) throw new Error('只支持 http/https 网址')
    await wc.loadURL(u).catch(() => undefined) // ERR_ABORTED 等中断不影响已开始加载
    return { url: wc.getURL(), title: wc.getTitle() }
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
        panelOp((req.url ?? '').replace(/^\/+/, '').split('?')[0], body)
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
    : join(app.getAppPath(), 'resources', 'panel-mcp.mjs')
}

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
// 右上角 X = 最小化驻留任务栏（长任务继续跑，回来点任务栏即恢复）；真退出走 Alt+F4 / 任务栏关闭（window-all-closed）
ipcMain.on('win:close', () => mainWin?.minimize())
ipcMain.handle('win:isMax', () => mainWin?.isMaximized() ?? false)

app.whenReady().then(async () => {
  // Windows 任务栏图标归属（否则 dev 模式可能沿用 Electron 默认图标）
  app.setAppUserModelId('com.qingniao.desktop')
  Menu.setApplicationMenu(null) // 去掉原生菜单，交互全部走应用内 UI
  mkdirSync(workspace, { recursive: true })
  const panelPort = await startPanelApi() // 面板浏览器控制端点：MCP 配置要带上端口，先于内核配置
  syncBuiltinSkills() // 技能是内核启动时加载的，同步要在拉起内核之前
  setPanelMcp({ path: panelMcpPath(), port: panelPort })
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
