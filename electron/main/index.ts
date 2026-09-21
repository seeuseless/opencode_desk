import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, session, shell, type OpenDialogOptions, type WebContents } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { adapter } from './adapter.ts'
import { loadSettings, opencodeConfigDir, qingniaoHome, saveSettings, setAccess, setDesktopMcp, setMediaMcp, setMobileEnabled, setPanelMcp, setScreenMcp, setSelfRefs, setUiaMcp, setTtsMcp, setMusicMcp, setAsrMcp, setVisionMcp, writeOpencodeConfig, type Settings } from './config.ts'
import type { AccessLevel } from './types.ts'
import { relay } from './relay.ts'
import { AUTH_PROTOCOL, platform } from './platform.ts'
import { handleGate, modelAuthList, rejectAllPending, replyModelAuth, revokeModelAuth, setModelAuthSink } from './gate.ts'
import type { SkillDraft, SkillItem, SkillScope } from './types.ts'

/**
 * 主进程职责：
 * 1. 拉起 OpenCode 内核（`opencode serve`，REST + SSE），配置与会话存储隔离在 ~/.qingniaoai
 * 2. 渲染进程 REST 门面由 adapter 透传（OpenCode 原生 API，无协议翻译）
 * 3. 应用级 IPC：目录选择、设置读写（保存即重启内核）、provider 模型列表拉取
 * 4. 移动端中转通道（relay.ts）：手机扫码 → 平台 → 本机内核，手机在 4G 下也能遥控这台电脑
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
  /**
   * 把自己的原生窗口句柄与窗口标题一起报给 MCP 的键盘守卫。
   *
   * 为什么在有了 pid 之后还要这两样：
   *  · pid 判据依赖「Electron 顶层窗口属于主进程」这个实现细节——Windows 上渲染进程所属的窗口、
   *    以及后开的窗口常常报的是另一个 pid，光靠 pid 会漏判（实测就漏过：前台明明是青鸟的窗口，
   *    却因为 pid 对不上而被放行，按键直接打进了用户的对话框）。
   *  · 标题是兜底判据：应用今后开的任何窗口，标题都以本应用名开头，不依赖 pid 也不依赖句柄。
   * 窗口建好才知道句柄、标题随后还可能被渲染层改写，而 MCP 的环境变量是内核启动时写死的——
   * 所以这里持续记下来，下一次写配置（保存设置 → 重启内核）时自然带进去。
   */
  try {
    const buf = mainWin.getNativeWindowHandle()
    const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
    const t = mainWin.getTitle()
    if (Number.isFinite(hwnd) && hwnd > 0) setSelfRefs({ pids: [process.pid], hwnds: [hwnd], titles: t ? [t] : [] })
  } catch {
    /* 拿不到句柄就算了，pid 与标题那两道判据还在 */
  }
  // 渲染层会按当前会话改写标题（「青鸟 QingNiao — xxx」）；前缀匹配本来就能覆盖，
  // 但标题若是被整体换掉的，这里把新标题也并进清单，避免守卫漏判。
  mainWin.on('page-title-updated', (_e, t) => {
    if (t) setSelfRefs({ titles: [t] })
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
ipcMain.handle('platform:login', () => platform.openLogin())
ipcMain.handle('platform:logout', async () => {
  const st = await platform.logout()
  relay.apply()

  return st
})
ipcMain.handle('platform:setBaseUrl', (_e, url: string) => {
  const st = platform.setBaseUrl(String(url ?? ''))
  relay.apply()

  return st
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
        const path = (req.url ?? '').replace(/^\/+/, '').split('?')[0]
        // `/qn/*` 是「AI 调其他模型」的授权闸门（MCP 子进程发来的），其余是面板浏览器操作。
        // 注意 authorize 会**挂起这个响应**直到用户作答——HTTP 那侧等着，正是我们要的阻塞语义。
        const task = path.startsWith('qn/') ? handleGate(path.slice(3), body) : panelOp(path, body)
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

/** 桌面辅助 MCP（app_running）脚本位置（随安装包分发） */
function desktopMcpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-mcp.mjs')
    : join(app.getAppPath(), 'resources', 'mcp', 'desktop-mcp.mjs')
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

/**
 * 桌面控制的底层依赖 computer-use-mcp（截屏 + 键鼠）在**哪里**。
 *
 * 为什么必须有一份可直接跑的本地副本：screen-mcp 底下要 spawn 它，若靠
 * `npx -y computer-use-mcp` 现场拉包，实测**即便命中缓存也要 ~8 秒**才吐第一行，
 * 内核启动时的 MCP 握手等不了这么久 → computer-use 被判失败，桌面控制就只剩
 * app_running（用户看到的就是「开了却没有截屏/点击/输入」）。直连本地入口约 2.4 秒且不联网。
 *
 * 三级查找，取第一个命中的：
 *  1. **随包内置**（resources/mcp/cu-mcp，electron-builder extraResources 带进安装包）——
 *     开箱即用、完全离线，这是正常路径；
 *  2. 老版本装到用户数据目录的那份（~/.qingniaoai/opencode/node_modules）——平滑过渡；
 *  3. 都没有 → 返回空串，配置里回落 npx（仍可用，只是慢且依赖网络）。
 */
function builtinComputerUseMcp(): string {
  const rel = join('node_modules', 'computer-use-mcp', 'dist', 'main.js')
  const candidates = [
    // 打包态：extraResources 平铺到 resources 根
    join(process.resourcesPath, 'cu-mcp', rel),
    // dev：项目根 package.json 已把它列为依赖，装完直接就在根 node_modules
    join(app.getAppPath(), rel),
    // dev：跑过 prepare:cu-mcp 生成的自包含副本
    join(app.getAppPath(), 'resources', 'mcp', 'cu-mcp', rel),
    // 老版本预装到用户数据目录的那份
    join(opencodeConfigDir(), rel)
  ]
  return candidates.find((p) => existsSync(p)) ?? ''
}

/** 电脑控制视觉叠加 MCP（给收不了图的模型把截图读成文字）脚本位置（随安装包分发） */
function screenMcpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'screen-mcp.mjs')
    : join(app.getAppPath(), 'resources', 'mcp', 'screen-mcp.mjs')
}

/**
 * UIA 桌面 MCP（读 Windows 无障碍树、按元素名点击/输入）脚本位置（随安装包分发）。
 * 同目录还必须带上 uia-host.ps1：uia-mcp.mjs 靠 import.meta.url 从**自己所在目录**找那个宿主，
 * 所以打包时两个文件都平铺到 resources 根（见 electron-builder.yml 的 extraResources）。
 */
function uiaMcpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'uia-mcp.mjs')
    : join(app.getAppPath(), 'resources', 'mcp', 'uia-mcp.mjs')
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

ipcMain.handle('settings:get', () => loadSettings())

/** 渲染层停止兜底用：内核健康探测（主进程 isHealthy，不经内核 REST） */
ipcMain.handle('kernel:health', () => adapter.isHealthy())

// 保存即生效：写 ~/.qingniaoai 并重启内核（provider/MCP 变更后需重载）
ipcMain.handle('settings:save', async (_e, s: Settings) => {
  saveSettings(s)
  await adapter.restart()
  // 「远程服务」这个全局总开关（只能改配置文件）：关掉它要顺手把中转通道停掉（一个请求都不再发）
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
  await adapter.restart()
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

app.whenReady().then(async () => {
  // Windows 任务栏图标归属（否则 dev 模式可能沿用 Electron 默认图标）
  app.setAppUserModelId('com.qingniao.desktop')
  Menu.setApplicationMenu(null) // 去掉原生菜单，交互全部走应用内 UI
  mkdirSync(workspace, { recursive: true })
  const panelPort = await startPanelApi() // 面板浏览器控制端点：MCP 配置要带上端口，先于内核配置
  syncBuiltinSkills() // 技能是内核启动时加载的，同步要在拉起内核之前
  setPanelMcp({ path: panelMcpPath(), port: panelPort })
  setDesktopMcp({ path: desktopMcpPath() })
  setMediaMcp({ path: mediaMcpPath() })
  setVisionMcp({ path: visionMcpPath() })
  setScreenMcp({ path: screenMcpPath(), upstreamBin: builtinComputerUseMcp() })
  setUiaMcp({ path: uiaMcpPath() })
  // 「不要往这些窗口里输入」清单：主进程自己的 pid。窗口的原生句柄要等 createWindow
  // 之后才有，那时补进 selfRefs（下一次重启内核时写进 MCP 环境）。pid 这一步已经够用——
  // Chromium 的顶层窗口句柄就属于主进程。
  setSelfRefs({ pids: [process.pid] })
  setTtsMcp({ path: ttsMcpPath() })
  setMusicMcp({ path: musicMcpPath() })
  setAsrMcp({ path: asrMcpPath() })
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

  // 设备注册是异步的（要向平台换一张设备 token），注册完才知道二维码内容，
  // 所以状态一变就主动推给渲染层——否则登录后面板一直停在「二维码生成中…」。
  relay.onChange = () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('mobile:changed', relay.status())
  }

  // 移动端中转通道：登录了就注册设备（二维码随即可用），开关开着才真的开始认领指令。
  relay.apply()

  // 平台模型清单静默对一遍（限免/折扣/倍率会变），跟登录态无关地跑一次：没登录时它什么也不做
  void platform.refreshOnBoot()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 还在等用户作答的「调用其他模型」授权：应用都关了就别再等，全部按拒绝结掉。
  // 不做的话连接会随进程一起断，MCP 侧 fetch 抛错 → 按 fail-open 放行 → 模型照调，白问一场。
  rejectAllPending()
  relay.stop()
  adapter.stop()
  app.quit()
})
