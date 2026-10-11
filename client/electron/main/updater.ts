import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { qingniaoHome } from './config.ts'
import type { UpdateProgress, UpdateState } from './types.ts'

/**
 * 更新：对着 GitHub Releases 查有没有新版本，有就下载到本机、再交给安装包自己升级。
 *
 * 为什么不用 electron-updater：
 *  · 它默认吃 `latest.yml`（electron-builder 专门为它生成的元数据文件），那份文件要单独
 *    传到 Release 上，且**文件大小/校验值必须与实际产物逐字节一致**，手工维护极易失真；
 *  · 我们本来的诉求很简单——「看一眼有没有新版、下载下来、让用户点下一步」——
 *    用 GitHub 自己就有的 Releases 元数据（tag_name / body / assets）比多维护一份 yml 更不容易坏。
 *  所以本模块**完全不依赖 latest.yml**，更新判断只用 GitHub Releases 的数据。
 *
 * 三个约束决定了实现形态：
 *  1. **只有打包态才有意义**。dev 跑的是源码，版本号恒等于 package.json，没有"升级"这回事，
 *     `update:check` 直接回状态 'dev' 让界面显示「开发模式不检查更新」。
 *  2. **面向公开仓库**。Release 与源码包走 github.com（浏览器能直连），只有 api.github.com
 *     在国内常被阻断，所以 API 全部挂超时、失败即降级（见 checkUpdate），不把界面卡住。
 *  3. **下载要能看见进度、能中断**。安装包几十到上百 MB，静默下载会让用户以为卡死；
 *     故用流式下载 + 节流推送进度，并提供取消（abort）。
 */

/** 仓库坐标：默认写死本项目，允许由 resources/update.json 覆盖（换仓库不用改代码） */
const DEFAULT_REPO = 'seeuseless/opencode_desk'
const DEFAULT_TAG_PREFIX = 'v'

/**
 * 版本比较用的 tag 前缀、仓库地址存在哪。
 *
 * 打包后读 resources/update.json（构建时由 scripts/gen-deps.mjs 之外的 update-meta 步骤写入）；
 * dev 读源码目录同名文件。文件缺失/坏掉一律回落默认值——更新检查不该因为一个元数据文件没生成就整个瘫掉。
 */
interface UpdateMeta {
  repo: string
  /** tag 前缀（v1.2 → v） */
  tagPrefix: string
  /** 当前版本号（打包时会与 app.getVersion() 交叉验证，取 app.getVersion() 为准） */
  version: string
}

function metaFile(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'update.json')
    : join(app.getAppPath(), 'resources', 'update.json')
}

function readMeta(): UpdateMeta {
  const fallback: UpdateMeta = { repo: DEFAULT_REPO, tagPrefix: DEFAULT_TAG_PREFIX, version: app.getVersion() }
  try {
    const raw = JSON.parse(readFileSync(metaFile(), 'utf8')) as Partial<UpdateMeta>
    return {
      repo: typeof raw.repo === 'string' && raw.repo.trim() ? raw.repo.trim() : fallback.repo,
      tagPrefix: typeof raw.tagPrefix === 'string' ? raw.tagPrefix : fallback.tagPrefix,
      version: fallback.version // 版本号只信应用自己：安装包里 app.getVersion() 就是权威
    }
  } catch {
    return fallback
  }
}

/**
 * 打包后安装包的文件名事实（electron-builder.yml 各平台 artifactName）：
 *
 * Windows：x64 附件固定叫 QingNiao-Setup.exe（release.yml 把 ${arch} 产物重命名后
 * 上传，维持 `releases/latest/download/QingNiao-Setup.exe` 固定直链）；arm64 叫
 * QingNiao-Setup-arm64.exe。本常量按当前进程架构取对应名，只做兜底。
 *
 * mac：arm64 / x64 双份 QingNiao-Setup-<arch>.dmg（zip 已停发），按进程架构拼名字：
 * x64 包（含 Rosetta 下运行的场景）认领 x64 附件，arm64 同理。
 *
 * Linux（2026-10-08加）：x64 / arm64 双份 AppImage，规则与 mac 同款，但**架构段用的是
 * Linux 惯例名 x86_64 而不是 x64** ——见下方 linuxArtifactArch()。
 *
 * 正常路径是 pickAsset 从 Release 的 assets 里按架构挑（见下方 pickAsset），这些
 * 常量只在 Release 元数据异常、拿不到 assets 时才用得上。
 *
 * 前缀是英文 `QingNiao` 而非中文「青鸟」：GitHub 对非 ASCII 的附件名要 URL 转义，
 * 中文名会让 `releases/latest/download/<名>` 这条固定直链在各端不稳（见
 * electron-builder.yml 的 artifactName 注释）。改这里必须同步改那边的 artifactName。
 */
const WIN_SETUP_NAME = process.arch === 'arm64' ? 'QingNiao-Setup-arm64.exe' : 'QingNiao-Setup.exe'
const MAC_DMG_NAME = `QingNiao-Setup-${process.arch}.dmg`

/**
 * Linux 产物名里的架构段 —— **不能直接用 process.arch**。
 *
 * electron-builder 的 getArtifactArchName（builder-util/out/arch.js）对 AppImage
 * 做了 Linux 惯例映射：x64 → `x86_64`、ia32 → `i386`；arm64 / armv7l 保持原名。
 * 所以真实产物是 `QingNiao-Setup-x86_64.AppImage` / `QingNiao-Setup-arm64.AppImage`。
 *
 * ⚠️踩过这个坑（2026-10-08 首次跑 build-linux CI）：按 `process.arch`（"x64"）拼名字，
 *   校验步骤报「未找到 dist/QingNiao-Setup-x64.AppImage」，而产物其实好好地在那儿，
 *   只是叫 x86_64。同一映射在 deb 上是 x64 → amd64、exe/dmg 上是 x64 → x64。
 *   release.yml 的校验与上传用的是同一套名字，改这里必须同步改那边。
 */
function linuxArtifactArch(): string {
  return process.arch === 'x64' ? 'x86_64' : process.arch
}

/** Linux 产物名。与 electron-builder.yml 的 linux.artifactName + 上述架构映射必须一致。 */
const LINUX_APPIMAGE_NAME = `QingNiao-Setup-${linuxArtifactArch()}.AppImage`

/**
 * 按平台给「下载文件名」的兜底值。
 *
 * 三平台都要给：非 Windows 的两个旧常量合起来当成兜底的话，Linux 上会把 .AppImage
 * 存成 .dmg 名（扩展名与内容不符，AppImage 的可执行位与 FUSE 挂载都会受影响）。
 */
function fallbackFileName(): string {
  if (process.platform === 'win32') return WIN_SETUP_NAME
  if (process.platform === 'darwin') return MAC_DMG_NAME
  return LINUX_APPIMAGE_NAME
}

/**
 * 版本号归一化：0.0.1 / v0.0.1 / 0.1.0-beta.1 → 可直接比较的数字段 + 预发布标识。
 *
 * 只认「数字.数字[.数字]」这种主流形态：本项目的版本号纪律就是两段或三段数字，
 * 这里不做 `1.0.0-rc.1+build.5` 那套完整 SemVer 解析（真用到再加，现在多写的代码只是错误面）。
 */
function parseVer(v: string): { nums: number[]; pre: string } {
  const s = v.trim().replace(/^v/i, '')
  const [core, ...rest] = s.split('-')
  const nums = core
    .split('.')
    .map((x) => Number.parseInt(x, 10))
    .map((n) => (Number.isFinite(n) && n >= 0 ? n : 0))
  while (nums.length < 3) nums.push(0)
  return { nums: nums.slice(0, 3), pre: rest.join('-') }
}

/**
 * a 是否比 b 新。
 *
 * 预发布标识的处理规则：**b 是预发布、a 是正式版时算新**（0.1.0 > 0.1.0-beta）；
 * 反过来 0.1.0-beta 对 0.1.0 不算新——不给用户推降级。同号带不带 pre 的其他组合按字符串比。
 */
export function isNewer(a: string, b: string): boolean {
  const x = parseVer(a)
  const y = parseVer(b)
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i]
  }
  if (x.pre === y.pre) return false
  if (!x.pre && y.pre) return true // 正式版 newer 于同号预发布
  if (x.pre && !y.pre) return false
  return x.pre > y.pre
}

// ---------- 主进程内存里的更新状态（渲染层轮询/事件都读它） ----------

interface Internal {
  checking: boolean
  /** 上次检查的时间戳（0 = 从未查过） */
  checkedAt: number
  /** 检查失败原因（网络不通、被限流…）；有最新版时为 undefined */
  error?: string
  latest?: {
    version: string
    tag: string
    /** Release 说明（Markdown，界面按纯文本/简排版显示） */
    notes: string
    /** 发布页地址（用户在浏览器里看完整说明） */
    pageUrl: string
    publishedAt: string
    /** 下载直链（优先挑安装包附件，没有就回落源码包） */
    downloadUrl?: string
    /** 附件文件名（界面显示用） */
    downloadName?: string
    /** 附件字节数（0 = 未知；有它才能显示进度百分比与校验完整性） */
    size: number
  }
  /** 下载中：已收字节数与总字节数（total 为 0 时进度不可算百分比） */
  progress?: { received: number; total: number }
  /** 已下载完成的文件路径（存在即「可以安装了」） */
  file?: string
  /** 中断下载用的句柄（取消时 abort） */
  abort?: AbortController
}

const st: Internal = { checking: false, checkedAt: 0 }

/** 对外快照（不含 abort 这类内部句柄） */
function snapshot(): UpdateState {
  return {
    dev: !app.isPackaged,
    current: app.getVersion(),
    checking: st.checking,
    checkedAt: st.checkedAt,
    error: st.error,
    latest: st.latest ? { ...st.latest } : undefined,
    progress: st.progress ? { ...st.progress } : undefined,
    file: st.file,
    canInstall: !!st.file && existsSync(st.file)
  }
}

/** 状态变化的广播口（index.ts 里接到 webContents.send 上） */
let sink: ((s: UpdateState) => void) | null = null
export function setUpdateSink(fn: (s: UpdateState) => void): void {
  sink = fn
}
function emit(): void {
  sink?.(snapshot())
}

export function updateState(): UpdateState {
  return snapshot()
}

// ---------- 检查更新 ----------

/** GitHub API 请求头：UA 必填（缺了 403），带上接受类型拿到稳定结构 */
function apiHeaders(): Record<string, string> {
  return {
    'user-agent': 'qingniao-updater',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28'
  }
}

interface GhAsset {
  name?: string
  browser_download_url?: string
  size?: number
}
interface GhRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GhAsset[]
}

/**
 * 从 Release 的附件里挑一个能下载的东西。
 *
 * 优先级：**当前平台的安装包** > 任意 .exe/.dmg/.zip/.AppImage > 第一份附件。
 * 之所以要"兜底挑一个"而不是"没有安装包就报错"：源码包（zipball）也是 GitHub 自动带的附件，
 * 早期 Release 可能只传了源码包——此时让用户能打开下载页总比一句"没有可用文件"有用。
 */
function pickAsset(assets: GhAsset[] | undefined, tag: string, repo: string): { url: string; name: string; size: number } {
  const list = Array.isArray(assets) ? assets.filter((a) => a.browser_download_url) : []
  const want = process.platform === 'win32' ? /\.exe$/i : process.platform === 'darwin' ? /\.(dmg|zip)$/i : /\.(appimage|deb)$/i
  // 双架构包（win x64/arm64、mac arm64/x64、linux x64/arm64）同挂一个 Release，必须按当前
  // 进程架构认领——通用正则会拿到数组里第一个匹配附件，架构随上传顺序碰运气。Rosetta 下
  // process.arch 是 x64，x64 应用认 x64 包，行为也正确。
  // Windows 的期望名要与 CI 重命名约定一致：x64 附件就叫 QingNiao-Setup.exe（不带后缀）。
  // mac 的认领正则只写 dmg：zip 已停发（electron-builder.yml mac.target 注释），
  // want 兜底里的 zip 是给还挂着 zip 附件的历史 Release 留的。
  // Linux 的认领正则：架构段是 Linux 惯例名 x86_64 / arm64（不是 process.arch 的 x64），
  // 原因见 linuxArtifactArch() 的注释。.AppImage 大小写敏感（electron-builder 用大写 I），
  // 正则带 i 兜住手改名的附件。
  let archHit: GhAsset | undefined
  if (process.platform === 'win32') {
    const expected = process.arch === 'arm64' ? 'QingNiao-Setup-arm64.exe' : 'QingNiao-Setup.exe'
    archHit = list.find((a) => (a.name ?? '').toLowerCase() === expected.toLowerCase())
  } else if (process.platform === 'darwin') {
    archHit = list.find((a) => new RegExp(`-${process.arch}\\.dmg$`, 'i').test(a.name ?? ''))
  } else {
    archHit = list.find((a) => new RegExp(`-${linuxArtifactArch()}\\.appimage$`, 'i').test(a.name ?? ''))
  }
  const hit =
    archHit ??
    list.find((a) => want.test(a.name ?? '')) ??
    list.find((a) => /\.(exe|dmg|zip|appimage|deb)$/i.test(a.name ?? '')) ??
    list[0]
  if (hit?.browser_download_url) {
    return { url: hit.browser_download_url, name: hit.name ?? '', size: Number(hit.size) || 0 }
  }
  // 一个附件都没有：给源码包地址，至少不是死路（界面会照实说明"这是源码包"）
  return { url: `https://github.com/${repo}/archive/refs/tags/${tag}.zip`, name: '', size: 0 }
}

/**
 * 查最新版。
 *
 * 三条路径，按可靠性降级：
 *  1. `GET /repos/{repo}/releases/latest` —— 拿到版本、说明、附件。**这是正常路径**；
 *  2. 失败（国内常被墙/限流）时回落到 `GET /releases`（同样在 API 域名下，多半一起不通）；
 *  3. 再不行就回 error，界面提示"检查失败，可点这里去发布页自己看"——**不编造版本号**。
 *
 * 全程 force=false 只是"清掉进程内缓存"的语义，这里没有额外缓存层，留着是为了语义清晰。
 */
export async function checkUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) return snapshot()
  const meta = readMeta()
  st.checking = true
  st.error = undefined
  emit()

  const timeout = (ms: number): AbortSignal => AbortSignal.timeout(ms)
  const base = `https://api.github.com/repos/${meta.repo}`
  let rel: GhRelease | null = null
  let err = ''
  try {
    const r = await fetch(`${base}/releases/latest`, { headers: apiHeaders(), signal: timeout(8000) })
    if (r.ok) {
      rel = (await r.json()) as GhRelease
    } else if (r.status === 404) {
      // 404 有两种含义，界面上必须说清是哪一种，否则用户完全不知道下一步该干什么：
      //  · 仓库**不是公开的**，或仓库名写错了 —— 匿名请求（应用没有、也不该有 GitHub 凭据）
      //    看任何非公开仓库都会 404，跟"有没有发过 Release"无关；
      //  · 仓库公开但一个 Release 都没建过（只打了 tag 不算，得在 GitHub 上建 Release）。
      err = '读不到发布信息：仓库未公开（或地址不对），也可能还没建过任何 Release。'
    } else if (r.status === 403 || r.status === 429) {
      // 未登录的 GitHub API 限额很低（按出口 IP 算），共享网络下很容易撞上
      err = `GitHub 接口限流（HTTP ${r.status}），稍后再试即可`
    } else {
      err = `GitHub 返回 HTTP ${r.status}`
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  // 没拿到（网络/限流/无正式发布）再试列表接口：列表里挑第一个非草稿、非预发布的
  if (!rel && !err) {
    try {
      const r = await fetch(`${base}/releases?per_page=10`, { headers: apiHeaders(), signal: timeout(8000) })
      if (r.ok) {
        const arr = (await r.json()) as GhRelease[]
        rel = arr.find((x) => !x.draft && !x.prerelease) ?? null
      }
    } catch {
      /* 保持 err 里的原始失败原因 */
    }
  }

  st.checking = false
  st.checkedAt = Date.now()

  if (!rel?.tag_name) {
    // 上一次已下载好、或正在下载的版本：不要因为一次检查失败就把界面上的「有新版本」清掉
    st.error = err || '没能从 GitHub 读到发布信息（可能是网络不通或被限流）'
    emit()
    return snapshot()
  }

  const version = rel.tag_name.replace(new RegExp('^' + meta.tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '')
  const asset = pickAsset(rel.assets, rel.tag_name, meta.repo)

  // 已经是最新：把上一次的「有新版本」状态清掉（用户可能刚升级完再点一次检查）
  if (!isNewer(version, app.getVersion())) {
    const hadFile = !!st.file
    st.latest = undefined
    st.progress = undefined
    if (hadFile) {
      st.file = undefined
      cleanupDownloaded()
    }
    emit()
    return snapshot()
  }

  const changed = st.latest?.version !== version
  st.latest = {
    version,
    tag: rel.tag_name,
    notes: typeof rel.body === 'string' ? rel.body : '',
    pageUrl: rel.html_url ?? `https://github.com/${meta.repo}/releases/tag/${rel.tag_name}`,
    publishedAt: rel.published_at ?? '',
    downloadUrl: asset.url,
    downloadName: asset.name || fallbackFileName(),
    size: asset.size
  }
  // 版本变了：上一版下载好的文件作废（避免把旧包当新包装）
  if (changed) {
    st.file = undefined
    st.progress = undefined
    cleanupDownloaded()
  }
  emit()
  return snapshot()
}

// ---------- 下载 ----------

/** 下载目录：~/.qingniaoai/updates/（跟应用其它数据放一起，卸载/清数据时一并清掉） */
function updateDir(): string {
  return join(qingniaoHome(), 'updates')
}

function targetFile(name: string): string {
  // 附件名不可信（来自网络），只取最后一段并剔掉路径分隔符与 ..；真的没有名字就按平台给默认名
  const safe = (name || '').split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, '') ?? ''
  const fallback = fallbackFileName()
  return join(updateDir(), safe && !/^\.+$/.test(safe) ? safe : fallback)
}

function cleanupDownloaded(): void {
  try {
    rmSync(updateDir(), { recursive: true, force: true })
  } catch {
    /* 删不掉就算了：下次下载会覆盖 */
  }
}

/** 进度推送节流：每 300ms 或每 1% 推一次，别让 IPC 被小包刷爆 */
let lastPush = 0
function pushProgress(received: number, total: number, force = false): void {
  st.progress = { received, total }
  const now = Date.now()
  if (!force && now - lastPush < 300) return
  lastPush = now
  emit()
}

/**
 * 下载最新版安装包。
 *
 * 落盘位置固定成 `~/.qingniaoai/updates/<附件名>`：下载完把路径记在状态里，
 * 用户点「安装」时直接执行它——**不需要再问一次文件在哪**，也避免用户把文件挪走后找不到。
 *
 * 三种结局都如实回报（界面要能说清发生了什么）：
 *  · 正常完成 → 状态里带 file，界面变「立即安装并重启」；
 *  · 用户取消 → 抛「已取消」，把半截文件删掉（留着会被误当成完整包）；
 *  · 网络中断 → 抛出原始错误，同样删掉半截文件。
 *
 * GitHub 的附件地址会 **302 跳到 objects.githubusercontent.com**，fetch 默认自动跟随，
 * 但要注意跳转后不再带 Authorization——公开仓库不需要鉴权，正好不受影响。
 */
export async function downloadUpdate(): Promise<UpdateState> {
  if (st.abort) return snapshot() // 已经在下了：重复点击直接忽略
  const latest = st.latest
  if (!latest?.downloadUrl) {
    st.error = '还没有可下载的版本，请先检查更新'
    emit()
    return snapshot()
  }
  const file = targetFile(latest.downloadName ?? '')
  mkdirSync(updateDir(), { recursive: true })
  // 先清掉可能残留的旧文件：同名覆盖在部分系统上会先写后截断，中途失败会留下"看着像完整包"的残骸
  try {
    rmSync(file, { force: true })
  } catch {
    /* 不存在就算了 */
  }

  const ac = new AbortController()
  st.abort = ac
  st.error = undefined
  pushProgress(0, latest.size || 0, true)

  try {
    const r = await fetch(latest.downloadUrl, { signal: ac.signal, redirect: 'follow' })
    if (!r.ok || !r.body) throw new Error(`下载失败 HTTP ${r.status}`)
    const total = Number(r.headers.get('content-length')) || latest.size || 0
    let received = 0
    // 计进度：包一个 Transform 统计字节；不能只靠 content-length 推算——中途断流时长度对不上
    const counter = new ReadableStream({
      start(controller) {
        const reader = (r.body as ReadableStream<Uint8Array>).getReader()
        const pump = (): void => {
          reader.read().then(
            ({ done, value }) => {
              if (done) {
                controller.close()
                return
              }
              received += value.byteLength
              pushProgress(received, total)
              controller.enqueue(value)
              pump()
            },
            (e) => controller.error(e)
          )
        }
        pump()
      },
      cancel: (reason) => ac.abort(reason)
    })
    await pipeline(Readable.fromWeb(counter as never), createWriteStream(file))

    // 完整性校验：认得出的长度就比一下。差一个字节都可能是个坏包，宁可让用户重下
    const got = statSync(file).size
    if (total > 0 && got !== total) throw new Error(`下载不完整（${got} / ${total} 字节），请重试`)

    st.file = file
    st.progress = undefined
    st.abort = undefined
    // 记住这次下载的版本，供「下载完成」提示与后续安装校验
    writeFileSync(join(updateDir(), 'pending.json'), JSON.stringify({ version: latest.version, file, size: got, at: Date.now() }, null, 2), 'utf8')
    // 注意这里**不要**再调 pushProgress：它会把 st.progress 又填上，界面就会在
    // 「可以安装了」的旁边继续画一条满格进度条（看起来像还在下）。
    // 收尾的这一次广播直接 emit，进度已清空、file 已就位。
    emit()
    return snapshot()
  } catch (e) {
    st.abort = undefined
    st.progress = undefined
    const aborted = ac.signal.aborted
    st.error = aborted ? '已取消下载' : e instanceof Error ? e.message : String(e)
    try {
      rmSync(file, { force: true }) // 半截包一定删掉：它的大小可能"看着差不多"，会被误解为可安装
    } catch {
      /* 删不掉就留着，下次覆盖 */
    }
    emit()
    if (aborted) throw new Error('已取消下载')
    throw e
  }
}

/** 取消下载（界面上的「取消」按钮） */
export function cancelDownload(): UpdateState {
  st.abort?.abort()
  st.abort = undefined
  return snapshot()
}

// ---------- 安装 ----------

/**
 * 拉起安装包（用户点「立即安装」）。
 *
 * Windows 上跑 NSIS 安装包，走**静默原地升级**（参数是 electron-builder NSIS 模板原生支持的
 * 三个标志，见 templates/nsis/installSection.nsh）：
 *  · `/S` 无界面安装；
 *  · `--updated` 走"升级"路径——安装目录沿用注册表里上一次的位置（multiUser.nsh 的
 *    initMultiUser），并按 KeepShortcuts 保留桌面与开始菜单快捷方式（installUtil.nsh 的
 *    setIsTryToKeepShortcuts），应用还在运行时自动等它退出、关不掉再收尾；
 *  · `--force-run` 装完自动拉起新版本（installSection.nsh：assisted + silent 分支）。
 * 所以一次静默安装 = 原地换文件 + 自动重启，**桌面图标、任务栏固定都不受影响**。
 * 极少数环境 spawn 失败则回落打开安装向导，由用户手动下一步（向导同样默认原目录）。
 *
 * macOS 的 dmg 只是"挂载一个磁盘映像"，不能替你完成替换，所以那里是打开它让用户自己拖；
 * 界面文案会据此区分（update:install 的返回值里带 manual 标记）。
 */
export function installUpdate(): { ok: boolean; manual?: boolean; error?: string } {
  const file = st.file
  if (!file || !existsSync(file)) return { ok: false, error: '安装包不存在或已被删除，请重新下载' }
  const manual = process.platform !== 'win32' // 非 Windows：交还给用户手动完成
  if (manual) {
    try {
      void shell.openPath(file)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  } else {
    try {
      spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' })
        .on('error', () => void shell.openPath(file))
        .unref()
    } catch {
      void shell.openPath(file)
    }
    // 给安装器一点时间真正起来（它是独立进程，但句柄传递有个瞬间），再退自己。
    // 就算还没退完，安装器的 --updated 路径也会等应用退出，不会卡在"文件正在使用"。
    setTimeout(() => app.quit(), 300)
  }
  return { ok: true, manual }
}

/** 在浏览器里打开 Release 发布页（检查失败、或用户想自己看看时的出口） */
export async function openReleasePage(tag?: string): Promise<void> {
  const meta = readMeta()
  const url = tag
    ? `https://github.com/${meta.repo}/releases/tag/${encodeURIComponent(tag)}`
    : `https://github.com/${meta.repo}/releases`
  await shell.openExternal(url)
}
