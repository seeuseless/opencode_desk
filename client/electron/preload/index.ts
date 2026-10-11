import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type {
  AccessLevel,
  DepItem,
  DeskStatus,
  LocalUsage,
  ModelAuthAsk,
  ModelAuthScope,
  ModelUsed,
  PlatformAccount,
  PlatformStatus,
  Settings,
  SkillDraft,
  SkillItem,
  SkillScope,
  ScheduleRan,
  ScheduleTask,
  UsageLog,
  UsagePage,
  UsageRecord,
  UsageSummary,
  UpdateState
} from '../main/types'

/** 暴露给渲染进程的最小桥：REST 代理 + 事件订阅 + 应用级能力 */
const api = {
  call: (path: string, opts?: { method?: string; body?: unknown }): Promise<{ status: number; data: unknown }> =>
    ipcRenderer.invoke('opencode:api', path, opts),
  onEvent: (cb: (e: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => cb(data)
    ipcRenderer.on('opencode:event', handler)
    return () => ipcRenderer.removeListener('opencode:event', handler)
  },
  info: (): Promise<{ workspace: string }> => ipcRenderer.invoke('app:info'),
  /**
   * UI 数据（项目清单 / 排序 / 展开态 / 主题…）的读写，落 ~/.qingniaoai/ui-store.json。
   * 事实源在主进程而非 localStorage —— 后者按 origin 隔离，dev 与安装版各存一份（见 main/uistore.ts）。
   * get 返回全量快照（启动时一次灌进 localStorage 缓存），set 写单个键。
   */
  uiStore: {
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('ui:store:get'),
    set: (key: string, value: unknown): Promise<Record<string, unknown>> => ipcRenderer.invoke('ui:store:set', { key, value }),
    del: (key: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('ui:store:del', key)
  },
  pickDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  /** 内核健康探测（主进程 isHealthy；渲染层停止按钮的兜底判断用） */
  kernelHealth: (): Promise<boolean> => ipcRenderer.invoke('kernel:health'),
  /** 第三方依赖清单（设置 → 依赖）：包名 + 真实版本号 + 真实协议，来自 package.json 与已安装的包 */
  depsList: (): Promise<DepItem[]> => ipcRenderer.invoke('deps:list'),
  saveSettings: (s: Settings): Promise<void> => ipcRenderer.invoke('settings:save', s),
  /**
   * 改**全局**访问权限档位（'default' = 写操作要确认 / 'full' = 完全控制），对所有文件夹生效。
   * 只落盘、**不重启内核**（拨档位不该打断正在跑的任务）；生效需再走一次 saveSettings。
   */
  setAccess: (level: AccessLevel): Promise<Settings> =>
    ipcRenderer.invoke('settings:setAccess', { level }),
  /**
   * 应答内核的权限询问（permission.asked）。
   * once = 只这一次允许；always = 这个会话内同类操作都允许；reject = 拒绝。
   * 返回空串表示成功，否则是失败原因。
   */
  replyPermission: (req: { id: string; sessionID?: string; reply: 'once' | 'always' | 'reject' }): Promise<string> =>
    ipcRenderer.invoke('permission:reply', req),
  /**
   * 「AI 调用**其他**模型」的授权询问（识图 / 桌面代看 / 生图 / 生视频 / 配音 / 音乐 / 听写）。
   * 这几类调用发生在 MCP 子进程里、主进程原本看不见，现在会先拦下来问用户。
   * **受访问权限档位控制**：「完全控制」是总权限闸，主进程直接放行、不会推这张卡；只有「默认」档才会问。
   */
  onModelAuth: (cb: (a: ModelAuthAsk) => void): (() => void) => {
    const handler = (_: unknown, a: ModelAuthAsk): void => cb(a)
    ipcRenderer.on('modelauth:ask', handler)
    return () => ipcRenderer.removeListener('modelauth:ask', handler)
  },
  /** 应答授权卡：once=仅这一次 / session=本次会话 / always=永久 / reject=拒绝。返回空串表示成功 */
  replyModelAuth: (req: { reqId: string; scope: ModelAuthScope }): Promise<string> =>
    ipcRenderer.invoke('modelauth:reply', req),
  /** 某个额外模型真的被调用成功了一次（回复末尾的「本轮用到哪些模型」靠它累计） */
  onModelUsed: (cb: (u: ModelUsed) => void): (() => void) => {
    const handler = (_: unknown, u: ModelUsed): void => cb(u)
    ipcRenderer.on('modelauth:used', handler)
    return () => ipcRenderer.removeListener('modelauth:used', handler)
  },
  /** 永久授权清单（键为 `角色|provider/model`）；设置页展示与撤销用 */
  modelAuthList: (): Promise<string[]> => ipcRenderer.invoke('modelauth:list'),
  /** 撤销授权：key 省略＝清空全部（会话级一并失效），返回撤销后的永久清单 */
  revokeModelAuth: (key?: string): Promise<string[]> => ipcRenderer.invoke('modelauth:revoke', key),
  fetchModels: (
    baseURL: string,
    apiKey?: string
  ): Promise<{ models?: string[]; error?: string }> => ipcRenderer.invoke('models:fetch', { baseURL, apiKey }),
  /** 读取项目记忆：<项目>/.qingniao/memory/MEMORY.md（长期）+ YYYY-MM-DD.md（当日），目录不存在则建 */
  readMemory: (projectPath: string): Promise<{ long: string; daily: string }> =>
    ipcRenderer.invoke('memory:read', projectPath),
  /** 把一段内容追加到项目当日记忆文件（<项目>/.qingniao/memory/YYYY-MM-DD.md） */
  appendMemory: (projectPath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('memory:append', { projectPath, content }),
  /** 技能列表：全局（~/.qingniaoai/opencode/skills）+ 当前项目（<项目>/.opencode/skills），含 frontmatter 校验结果 */
  listSkills: (projectPath?: string | null): Promise<SkillItem[]> => ipcRenderer.invoke('skills:list', { projectPath }),
  /** 读单条技能，返回拆分后的 frontmatter 与正文（编辑弹窗回填用） */
  readSkill: (req: {
    scope: SkillScope
    projectPath?: string | null
    name: string
  }): Promise<{ name: string; description: string; body: string; hasFm: boolean }> => ipcRenderer.invoke('skills:read', req),
  /** 新建或保存技能（改名时自动清理旧目录），返回 { error } 表示校验未通过 */
  saveSkill: (draft: SkillDraft): Promise<{ error?: string }> => ipcRenderer.invoke('skills:save', draft),
  removeSkill: (req: { scope: SkillScope; projectPath?: string | null; name: string }): Promise<void> =>
    ipcRenderer.invoke('skills:remove', req),
  /** 在系统文件管理器里打开技能目录 */
  openSkillsDir: (req: { scope: SkillScope; projectPath?: string | null }): Promise<string> =>
    ipcRenderer.invoke('skills:openDir', req),
  /** 用系统默认浏览器打开网页地址（浏览面板「在外部打开」用） */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('openExternal', url),
  /** 在系统文件管理器里打开某个文件夹（左栏项目右键菜单「打开文件夹」）；返回空串表示成功 */
  openFolder: (path: string): Promise<string> => ipcRenderer.invoke('folder:open', path),
  /** 读取项目某一层目录：目录在前、代码文件在后，忽略依赖目录、构建目录与符号链接 */
  workspaceList: (
    projectPath: string,
    dirPath?: string
  ): Promise<{ path: string; name: string; type: 'directory' | 'file' }[]> =>
    ipcRenderer.invoke('workspace:list', { projectPath, dirPath }),
  /** 读取项目内文本代码；返回内容与磁盘修改时间，保存时用于检查外部改动 */
  workspaceRead: (projectPath: string, filePath: string): Promise<{ content: string; mtimeMs: number }> =>
    ipcRenderer.invoke('workspace:read', { projectPath, filePath }),
  /** 保存项目内代码；磁盘文件已变化时主进程会拒绝覆盖 */
  workspaceWrite: (
    projectPath: string,
    filePath: string,
    content: string,
    expectedMtimeMs: number
  ): Promise<{ mtimeMs: number }> =>
    ipcRenderer.invoke('workspace:write', { projectPath, filePath, content, expectedMtimeMs }),
  /** 代码编辑器「新建文件」：弹系统另存为对话框选路径（校验在项目内），返回相对路径；取消返回 null */
  workspaceNewFile: (projectPath: string, dirPath?: string): Promise<{ path: string } | null> =>
    ipcRenderer.invoke('workspace:newFile', { projectPath, dirPath }),
  /** 代码编辑器「新建文件夹」：在指定目录下创建子目录，返回相对路径 */
  workspaceNewDir: (projectPath: string, parentDir: string, name: string): Promise<{ path: string }> =>
    ipcRenderer.invoke('workspace:newDir', { projectPath, parentDir, name }),
  /** 代码编辑器「删除」文件或文件夹（文件夹递归删除），仅限项目目录内 */
  workspaceDelete: (projectPath: string, filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('workspace:delete', { projectPath, filePath }),
  /** 计划任务清单（左栏「计划任务」区块）；数据与调度器都在主进程 */
  scheduleList: (): Promise<ScheduleTask[]> => ipcRenderer.invoke('schedule:list'),
  /** 新建/保存计划任务（同一 id 即覆盖），返回落盘后的最新清单 */
  scheduleSave: (t: ScheduleTask): Promise<ScheduleTask[]> => ipcRenderer.invoke('schedule:save', t),
  /** 删除计划任务（会话历史保留），返回最新清单 */
  scheduleRemove: (id: string): Promise<ScheduleTask[]> => ipcRenderer.invoke('schedule:remove', id),
  /** 按完整任务 id 顺序保存拖拽结果，返回最新清单 */
  scheduleReorder: (ids: string[]): Promise<ScheduleTask[]> => ipcRenderer.invoke('schedule:reorder', ids),
  /** 立即执行一次：主进程在「任务」目录建会话并发 prompt；返回执行结果 */
  scheduleRunNow: (id: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> =>
    ipcRenderer.invoke('schedule:runNow', id),
  /** 计划任务执行完成（到点自动触发/手动立即执行）：刷新左栏会话列表用 */
  onScheduleRan: (cb: (r: ScheduleRan) => void): (() => void) => {
    const handler = (_: unknown, r: ScheduleRan): void => cb(r)
    ipcRenderer.on('schedule:ran', handler)
    return () => ipcRenderer.removeListener('schedule:ran', handler)
  },
  /**
   * 本会话由 AI 启动的常驻服务进程（对话内展示/停止；登记来源与存活对账见 main/procstore.ts）。
   * list 每次都先探测存活：外部被关掉 / 重启应用后已死的会自动清掉。
   */
  procList: (sid: string): Promise<{ pid: number; cmd: string; port?: number; startedAt: number }[]> =>
    ipcRenderer.invoke('proc:list', sid),
  procAdd: (sid: string, proc: { pid: number; cmd: string; port?: number; startedAt: number }): Promise<
    { pid: number; cmd: string; port?: number; startedAt: number }[]
  > => ipcRenderer.invoke('proc:add', { sid, proc }),
  /** 停止服务进程（Windows 连子进程树一起杀），返回删除后的最新清单 */
  procKill: (sid: string, pid: number): Promise<{ pid: number; cmd: string; port?: number; startedAt: number }[]> =>
    ipcRenderer.invoke('proc:kill', { sid, pid }),
  /** 保存聊天里的图片/视频：远程地址下载、本地路径复制，弹系统另存为对话框；返回空串表示成功 */
  saveMedia: (source: string, name?: string): Promise<string> => ipcRenderer.invoke('media:save', { source, name }),
  /** 读本地图片为 data URL（聊天内嵌显示本地图用）；非图片或不存在的返回空串 */
  readMedia: (path: string): Promise<string> => ipcRenderer.invoke('media:read', path),
  /** 读本地视频字节（聊天内嵌播放本地生成视频用，渲染层转 blob URL）；非视频扩展名或文件不存在返回 null */
  readVideo: (path: string): Promise<Uint8Array | null> => ipcRenderer.invoke('media:read-video', path),
  /** 读本地音频字节（聊天里试听配音结果用，渲染层转 blob URL）；非音频扩展名或文件不存在返回 null */
  readAudio: (path: string): Promise<Uint8Array | null> => ipcRenderer.invoke('media:read-audio', path),
  /** 弹系统对话框选图片/视频（聊天附件上传）：图片返回 dataURL + 媒体目录落盘路径，视频返回 file:// 路径 */
  pickMedia: (): Promise<{ path: string; name: string; mime: string; url: string }[]> =>
    ipcRenderer.invoke('media:pick'),
  /** 主题背景图：弹系统对话框选图片，主进程复制进 themes 目录，返回 { 路径, dataURL }；取消返回 null */
  pickThemeBg: (): Promise<{ path: string; url: string } | null> =>
    ipcRenderer.invoke('theme-bg:pick'),
  /** 按已保存路径重读主题背景图（重启找回用）；文件不存在或非图片返回空串 */
  readThemeBg: (path: string): Promise<string> => ipcRenderer.invoke('theme-bg:read', path),
  /** 移动端接入状态：开关、二维码（{平台域名}/ide/device/{token}）、通道是否在跑（左栏手机面板用） */
  mobileStatus: (): Promise<DeskStatus> => ipcRenderer.invoke('mobile:get'),
  /** 开/关「允许移动端连接此设备」：开则手机扫码后能操作这台电脑 */
  mobileSet: (on: boolean): Promise<DeskStatus> => ipcRenderer.invoke('mobile:set', on),
  /** 换一张二维码（平台侧把那台设备的 token 换掉，旧码立即作废） */
  mobileRotate: (): Promise<DeskStatus> => ipcRenderer.invoke('mobile:rotate'),
  /** 把项目列表推给主进程：手机端读不到渲染层 localStorage，只能由这里送 */
  mobileSetProjects: (list: { id: string; path: string; name: string }[]): Promise<boolean> =>
    ipcRenderer.invoke('mobile:setProjects', list),
  /** 移动端接入状态变化（设备注册完成、通道报错）：主进程主动推过来 */
  onMobileChanged: (cb: (s: DeskStatus) => void): (() => void) => {
    const handler = (_: unknown, s: DeskStatus): void => cb(s)
    ipcRenderer.on('mobile:changed', handler)
    return () => ipcRenderer.removeListener('mobile:changed', handler)
  },
  /** 平台（青鸟服务端）状态：地址、登录用户、可用模型数（左下角登录入口用） */
  platformStatus: (): Promise<PlatformStatus> => ipcRenderer.invoke('platform:get'),
  /** 实时探测平台可达性（health 请求）并广播状态刷新：左下角入口/设置页打开时调 */
  platformProbe: (): Promise<boolean> => ipcRenderer.invoke('platform:probe'),
  /** 服务端活着没活（探 /api/health）。设置页的远程服务开关要根据它决定能不能操作 */
  serverAlive: (): Promise<boolean> => ipcRenderer.invoke('server:alive'),
  /** 打开平台的青鸟登录页（系统浏览器），登录成功后靠 qingniao:// 回调本机 */
  platformLogin: (): Promise<PlatformStatus> => ipcRenderer.invoke('platform:login'),
  /** 退出登录：平台侧吊销 token，本地清空并重启内核 */
  platformLogout: (): Promise<PlatformStatus> => ipcRenderer.invoke('platform:logout'),
  /** 改平台地址（上线换域名），地址变了需重新登录 */
  platformSetBaseUrl: (url: string): Promise<PlatformStatus> => ipcRenderer.invoke('platform:setBaseUrl', url),
  /** 手动粘贴授权码完成登录（浏览器唤不起应用时的兜底路径） */
  platformSubmitCode: (code: string): Promise<PlatformStatus> => ipcRenderer.invoke('platform:code', code),
  /** 重新拉取平台模型清单并重启内核（平台后台改了模型后用） */
  platformSync: (): Promise<PlatformStatus> => ipcRenderer.invoke('platform:sync'),
  /**
   * 静默刷新模型清单（不重启内核，除非模型增删）。
   * 选择器点开「内置模型」时调一次：限免/折扣是平台随时会改的，界面不能拿登录那一刻的旧快照。
   */
  platformRefreshModels: (): Promise<PlatformStatus> => ipcRenderer.invoke('platform:refresh'),
  /** 向内核要一次它自带的 Zen 免费模型清单并落盘（设置 → 模型 页手动刷新用）。
   *  返回落盘后的完整 Settings，清单有增删时主进程已重启内核。 */
  zenRefresh: (): Promise<Settings> => ipcRenderer.invoke('zen:refresh'),
  /** 账号信息：登录用户、当前授权、积分余额、本机设备名（设置 → 账号） */
  platformAccount: (): Promise<PlatformAccount | null> => ipcRenderer.invoke('platform:account'),
  /** 用量汇总：总量 / 今日 / 昨日 + 区间内按天与按模型明细。
   * 不传区间时平台按最近 30 天算（设置 → 使用量） */
  platformUsage: (range?: { from?: string; to?: string }): Promise<UsageSummary | null> =>
    ipcRenderer.invoke('platform:usage', range),
  /** 本机用量统计：从内核会话存储聚合（不依赖平台），口径是这台电脑 */
  usageLocal: (range?: { from?: string; to?: string }): Promise<LocalUsage> =>
    ipcRenderer.invoke('usage:local', range),
  /** 积分流水（发放 / 消耗 / 调整），按页取（一页 20 条） */
  platformUsageLogs: (type?: 'consume' | 'grant' | 'adjust', page?: number): Promise<UsagePage<UsageLog>> =>
    ipcRenderer.invoke('platform:usageLogs', type, page),
  /** 每次消耗明细（一次调用一行），按页取（一页 20 条） */
  platformUsageRecords: (page?: number): Promise<UsagePage<UsageRecord>> =>
    ipcRenderer.invoke('platform:usageRecords', page),
  /** 协议回调换了登录态：主进程主动推过来，用于刷新左下角入口 */
  onPlatformChanged: (cb: (s: PlatformStatus) => void): (() => void) => {
    const handler = (_: unknown, s: PlatformStatus): void => cb(s)
    ipcRenderer.on('platform:changed', handler)
    return () => ipcRenderer.off('platform:changed', handler)
  },
  /**
   * 更新（设置 → 关于）：对着 GitHub Releases 查最新版 → 下载安装包 → 交给安装包自己升级。
   * 版本信息每次都现查（不落盘），所以 getUpdateState 在没检查过时只有当前版本号。
   */
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:get'),
  /** 检查最新版本；失败不改动已有结果，状态里的 error 说明原因（网络不通 / 被限流 / 仓库还没发版） */
  checkUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  /** 下载最新版安装包到 ~/.qingniaoai/updates/；进度靠 onUpdateChanged 推送 */
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  /** 取消下载（把半截文件删掉） */
  cancelUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:cancel'),
  /** 立即安装：Windows 拉起安装包后本应用自动退出（安装器会重新启动它）；返回 manual 表示需要用户手动完成 */
  installUpdate: (): Promise<{ ok: boolean; manual?: boolean; error?: string }> =>
    ipcRenderer.invoke('update:install'),
  /** 在系统浏览器里打开发布页（检查失败时的出口；传 tag 则打开那一版的页面） */
  openRelease: (tag?: string): Promise<void> => ipcRenderer.invoke('update:openRelease', tag),
  /** 更新状态变化：检查完成 / 下载进度 / 下载结束 / 失败 */
  onUpdateChanged: (cb: (s: UpdateState) => void): (() => void) => {
    const handler = (_: unknown, s: UpdateState): void => cb(s)
    ipcRenderer.on('update:changed', handler)
    return () => ipcRenderer.removeListener('update:changed', handler)
  },
  winMin: () => ipcRenderer.send('win:min'),
  /** 界面缩放（设置 → 通用 → 界面大小；Ctrl+= / Ctrl+- / Ctrl+0）：整窗缩放，内置浏览器的网页内容不受影响 */
  zoomSet: (factor: number): void => {
    webFrame.setZoomFactor(factor)
  },
  winMax: () => ipcRenderer.send('win:max'),
  winClose: () => ipcRenderer.send('win:close'),
  winIsMax: (): Promise<boolean> => ipcRenderer.invoke('win:isMax'),
  onWinMax: (cb: (v: boolean) => void): (() => void) => {
    const handler = (_: unknown, v: boolean): void => cb(v)
    ipcRenderer.on('win:maximized', handler)
    return () => ipcRenderer.removeListener('win:maximized', handler)
  }
}

export type QingniaoBridge = typeof api

contextBridge.exposeInMainWorld('qingniao', api)
