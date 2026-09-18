import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, BarChart3, Check, CircleUser, Cpu, Eye, EyeOff, FolderOpen, Globe, Layers, Link2, Monitor, Palette, Pencil, Plus, RefreshCw, Server, Sparkles, Terminal, Trash2, type LucideIcon } from 'lucide-react'
import { Modal } from './Modal'
import { Switch } from './Switch'
import { UsagePanel } from './UsagePanel'
import { AccountPanel } from './AccountPanel'
import { getThemeList, CUSTOM_ID, type ThemeMeta } from '../theme'
import type { CustomColors } from '../themeColors'
import type { McpCfg, Modality, ModelCfg, PlatformStatus, ProviderCfg, SettingsCfg, SkillItem, SkillScope } from '../oc'
import { MODEL_DEFAULTS } from '../oc'
import type { SettingsTab } from '../App'

/**
 * 外部请求的定位（对话框里的「配置模型」等）。tick 自增是为了「用户本来就停在模型页」
 * 时再点一次也能重新定位——只靠 tab 值判别不出「又点了一次」。
 */
export interface SettingsReq {
  tab: SettingsTab
  tick: number
}

/** 输入类型可选项（输出固定为文本，无需配置） */
const MODALITY_LABELS: { key: Modality; label: string }[] = [
  { key: 'text', label: '文本' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' }
]

interface Props {
  settings: SettingsCfg
  onSave: (s: SettingsCfg) => Promise<void>
  saving: boolean
  theme: string
  onTheme: (id: string) => void
  custom: CustomColors
  onCustom: (key: keyof CustomColors, value: string) => void
  onResetCustom: () => void
  /** 当前活动项目路径：项目级技能写在 <项目>/.opencode/skills 下（没有项目时该组不可用） */
  projectPath?: string | null
  projectName?: string | null
  /** 当前标签页由 App 持有：左栏账号入口要能直接跳到「账号」 */
  tab: SettingsTab
  onTab: (t: SettingsTab) => void
  /** 外部请求的定位（对话框「配置模型」等）：tick 变化即执行一次，见下方 effect */
  req: SettingsReq | null
  /** 平台登录态（账号 / 使用量两页共用） */
  platform: PlatformStatus | null
  platformBusy: boolean
  onLogin: () => void
  onLogout: () => void
  onSetBaseUrl: (url: string) => void
  onSubmitCode: (code: string) => void
}

/** 自定义主题可调的 4 个基础色：标签 + 变量键 */
const CUSTOM_FIELDS: { key: keyof CustomColors; label: string }[] = [
  { key: 'accent', label: '主色' },
  { key: 'bg', label: '窗体背景' },
  { key: 'fg', label: '正文文字' },
  { key: 'sideBg', label: '左侧面板底色' },
]

/** 主题卡片用色块预览：内置取色卡，自定义实时取当前自定义的 4 色 */
const swatchOf = (t: ThemeMeta, custom: CustomColors): string[] =>
  t.id === CUSTOM_ID ? [custom.accent, custom.sideBg, custom.bg] : t.swatches

/** 设置页左侧导航：账号 / 主题 / 模型 / 技能 / MCP / 使用量 / 远程服务 */
type TabId = SettingsTab
const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  // 账号置顶：登录是「用上内置模型」的前提，放第一位最容易被找到
  { id: 'account', label: '账号', icon: CircleUser },
  { id: 'theme', label: '主题', icon: Palette },
  { id: 'providers', label: '模型', icon: Cpu },
  { id: 'skills', label: '技能', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Globe },
  // 使用量紧跟 MCP：两者都是"往外看"的信息（连了什么、花了多少）
  { id: 'usage', label: '使用量', icon: BarChart3 },
  // 总开关放最后：平时不用碰，关掉后「账号 / 使用量」两页会一起消失
  { id: 'remote', label: '远程服务', icon: Server }
]

/** 依赖平台接口的两页：关了远程服务就没有存在意义，连同导航一起收起 */
const REMOTE_TABS: TabId[] = ['account', 'usage']

interface Draft {
  isNew: boolean
  index: number
  name: string
  id: string
  baseURL: string
  apiKey: string
  modelsText: string
  /** 每个模型已编辑过的接入参数（键=模型 ID）；没编辑过的模型用 MODEL_DEFAULTS */
  cfgs: Record<string, ModelCfg>
}

interface McpDraft {
  isNew: boolean
  index: number
  name: string
  type: 'local' | 'remote'
  command: string
  url: string
}

/** 技能编辑弹窗的草稿：frontmatter 与正文拆开编辑，保存时由主进程拼回 SKILL.md */
interface SkillForm {
  isNew: boolean
  scope: SkillScope
  /** 编辑已有技能时的原目录名；改名保存时主进程据此清掉旧目录 */
  originalName: string
  name: string
  description: string
  body: string
}

function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'provider-' + Date.now()
}

function parseModels(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((m) => m.trim()).filter(Boolean))]
}

/** 未单独编辑过的模型用默认接入参数（每次新拷贝，避免共享数组引用） */
function defaultModelCfg(): Omit<ModelCfg, 'id'> {
  return { context: MODEL_DEFAULTS.context, output: MODEL_DEFAULTS.output, input: [...MODEL_DEFAULTS.input] }
}

export function SettingsView(p: Props) {
  const providers = p.settings.providers
  const [draft, setDraft] = useState<Draft | null>(null)
  const [mcpDraft, setMcpDraft] = useState<McpDraft | null>(null)
  const [fetching, setFetching] = useState(false)
  const [formMsg, setFormMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [confirmDel, setConfirmDel] = useState<ProviderCfg | null>(null)
  /* 重启内核前给一次确认（自绘弹窗，不用原生 confirm）：保留没有运行任务时的「稍后再说」 */
  const [pending, setPending] = useState<{ next: SettingsCfg; keepTab?: SettingsTab; note: string } | null>(null)
  const [showKey, setShowKey] = useState(false)
  // 标签页由 App 持有（左栏「账号」入口要能直接跳过来），这里只读不存
  const tab = p.tab
  const setTab = p.onTab
  /** 远程服务总开关：默认开（老配置没有这个键也当开） */
  const remote = p.settings.remote !== false
  const tabs = TABS.filter((t) => remote || !REMOTE_TABS.includes(t.id))
  /**
   * 保存设置并重启内核：正在跑的任务会一起结束，所以先弹窗确认。
   *
   * 不弹原生 confirm（本项目自绘控件，风格要统一），且必须带「稍后再说」：
   * 有任务在跑时强行保存/重启会把用户正在等的这轮直接掐掉。
   *
   * restoreTab：从对话区「配置模型」跳过来的场景，取消后要退回原来那一页，
   * 否则用户停在模型页却没做任何事，会以为设置被改了。
   */
  function applySettings(next: SettingsCfg, opts: { note: string; keepTab?: SettingsTab; restoreTab?: SettingsTab } | null) {
    if (!opts) {
      void p.onSave(next)
      return
    }
    setPending({ next, keepTab: opts.keepTab, note: opts.note })
    // 立即切到目标页，让用户先看到自己点进去的地方（弹窗取消时再退回 restoreTab）
    if (opts.keepTab) setTab(opts.keepTab)
  }
  /** 磁盘上扫到的技能（全局 + 当前项目），进入技能页时刷新 */
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [skDraft, setSkDraft] = useState<SkillForm | null>(null)
  const [skDel, setSkDel] = useState<SkillItem | null>(null)
  /** 技能落盘后要重启内核（技能是启动时加载的），期间按钮转「保存并重启内核…」 */
  const [skBusy, setSkBusy] = useState(false)
  /** 右侧正文滚动容器：外部跳页后置顶，避免停在上一页的半截位置 */
  const body = useRef<HTMLDivElement>(null)

  // 关掉远程服务时正停在「账号 / 使用量」上：那两页已经不可见了，退回主题页免得白屏
  useEffect(() => {
    if (!remote && REMOTE_TABS.includes(tab)) setTab('theme')
  }, [remote, tab, setTab])

  /**
   * 外部请求的定位：只在 tick 变化时跑一次（不进依赖，否则用户手动切页会被立刻拉回来）。
   *
   * 关掉远程服务时「账号 / 使用量」两页不存在，回落主题页，别停在一页空白上；
   * 切页后置顶滚动，否则从模型页跳到技能页会停在半截位置。
   */
  useEffect(() => {
    if (!p.req) return
    const t = !remote && REMOTE_TABS.includes(p.req.tab) ? 'theme' : p.req.tab
    setTab(t)
    setConfirmDel(null)
    setDraft(null)
    setMcpDraft(null)
    setPending(null)
    setSkDel(null)
    requestAnimationFrame(() => body.current?.scrollTo({ top: 0 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.req?.tick])

  function openNew() {
    setFormMsg(null)
    setDraft({ isNew: true, index: -1, name: '', id: '', baseURL: '', apiKey: '', modelsText: '', cfgs: {} })
  }

  function openEdit(i: number) {
    const c = providers[i]
    setFormMsg(null)
    setDraft({
      isNew: false,
      index: i,
      name: c.name,
      id: c.id,
      baseURL: c.baseURL,
      apiKey: c.apiKey,
      modelsText: c.models.map((m) => m.id).join('\n'),
      cfgs: Object.fromEntries(c.models.map((m) => [m.id, m]))
    })
  }

  async function fetchModels() {
    if (!draft) return
    if (!draft.baseURL.trim()) {
      setFormMsg({ text: '请先填写 Base URL', bad: true })
      return
    }
    setFetching(true)
    setFormMsg(null)
    const r = await window.qingniao.fetchModels(draft.baseURL, draft.apiKey)
    setFetching(false)
    if (r.error) setFormMsg({ text: '拉取失败：' + r.error, bad: true })
    else {
      setDraft({ ...draft, modelsText: r.models!.join('\n') })
      setFormMsg({ text: `已获取 ${r.models!.length} 个模型`, bad: false })
    }
  }

  /** 某个模型的接入参数：编辑过的取草稿值，没编辑过的用默认 */
  function cfgOf(id: string): ModelCfg {
    return draft?.cfgs[id] ?? { id, ...defaultModelCfg() }
  }

  function updateCfg(id: string, patch: Partial<ModelCfg>) {
    if (!draft) return
    setDraft({ ...draft, cfgs: { ...draft.cfgs, [id]: { ...cfgOf(id), ...patch } } })
  }

  function toggleModality(id: string, key: Modality) {
    const cur = cfgOf(id).input
    updateCfg(id, { input: cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key] })
  }

  async function saveDraft() {
    if (!draft) return
    const id = (draft.id.trim() || slugify(draft.name)).toLowerCase()
    if (!draft.baseURL.trim()) {
      setFormMsg({ text: '请填写 Base URL', bad: true })
      return
    }
    if (providers.some((x, i) => x.id === id && i !== draft.index)) {
      setFormMsg({ text: '提供商 ID 已存在：' + id, bad: true })
      return
    }
    const cfg: ProviderCfg = {
      id,
      name: draft.name.trim() || id,
      baseURL: draft.baseURL.trim(),
      apiKey: draft.apiKey.trim(),
      enabled: draft.isNew ? true : providers[draft.index].enabled,
      models: parseModels(draft.modelsText).map((mid) => draft.cfgs[mid] ?? { id: mid, ...defaultModelCfg() })
    }
    const list = draft.isNew ? [...providers, cfg] : providers.map((x, i) => (i === draft.index ? cfg : x))
    await p.onSave({ ...p.settings, providers: list })
    setDraft(null)
  }

  async function toggle(i: number) {
    applySettings(
      { ...p.settings, providers: providers.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)) },
      { note: `将${providers[i].enabled ? '停用' : '启用'}「${providers[i].name}」。` }
    )
  }

  async function doRemove() {
    if (!confirmDel) return
    await p.onSave({ ...p.settings, providers: providers.filter((x) => x.id !== confirmDel.id) })
    setConfirmDel(null)
  }

  // ---------- MCP ----------

  async function saveMcpDraft() {
    if (!mcpDraft) return
    const name = mcpDraft.name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!name) {
      setFormMsg({ text: '请填写 MCP 名称', bad: true })
      return
    }
    if (mcpDraft.type === 'local' && !mcpDraft.command.trim()) {
      setFormMsg({ text: '请填写启动命令（如 npx -y @modelcontextprotocol/server-xxx）', bad: true })
      return
    }
    if (mcpDraft.type === 'remote' && !mcpDraft.url.trim()) {
      setFormMsg({ text: '请填写服务地址', bad: true })
      return
    }
    if (name === 'playwright') {
      setFormMsg({ text: 'playwright 为内置浏览器保留名，请换一个', bad: true })
      return
    }
    if (name === 'computer-use') {
      setFormMsg({ text: 'computer-use 为桌面控制保留名，请换一个', bad: true })
      return
    }
    const list = p.settings.mcps
    if (list.some((x, i) => x.name === name && i !== mcpDraft.index)) {
      setFormMsg({ text: '同名 MCP 已存在：' + name, bad: true })
      return
    }
    const cfg: McpCfg = {
      name,
      type: mcpDraft.type,
      command: mcpDraft.command.trim(),
      url: mcpDraft.url.trim(),
      enabled: mcpDraft.isNew ? true : list[mcpDraft.index].enabled
    }
    const next = mcpDraft.isNew ? [...list, cfg] : list.map((x, i) => (i === mcpDraft.index ? cfg : x))
    await p.onSave({ ...p.settings, mcps: next })
    setMcpDraft(null)
    setFormMsg(null)
  }

  async function toggleMcp(i: number) {
    const m = p.settings.mcps[i]
    applySettings(
      { ...p.settings, mcps: p.settings.mcps.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)) },
      { note: `将${m.enabled ? '停用' : '启用'} MCP「${m.name}」。` }
    )
  }

  async function removeMcp(i: number) {
    const m = p.settings.mcps[i]
    applySettings(
      { ...p.settings, mcps: p.settings.mcps.filter((_, k) => k !== i) },
      { note: `将删除 MCP「${m.name}」。` }
    )
  }

  async function toggleBrowser() {
    applySettings(
      { ...p.settings, browser: !p.settings.browser },
      { note: `将${p.settings.browser ? '关闭' : '开启'}内置浏览器。` }
    )
  }

  async function toggleComputerUse() {
    applySettings(
      { ...p.settings, computerUse: !p.settings.computerUse },
      { note: `将${p.settings.computerUse ? '关闭' : '开启'}桌面控制（computer-use）。` }
    )
  }

  // ---------- 技能（Skills）----------
  // 技能 = 磁盘上的 <技能名>/SKILL.md。模型只看到 name + description 两行，
  // 判断需要时才读全文，所以不占常驻上下文；改完即时生效，不用重启内核。

  const refreshSkills = useCallback(async () => {
    setSkills(await window.qingniao.listSkills(p.projectPath))
  }, [p.projectPath])

  useEffect(() => {
    if (tab === 'skills') void refreshSkills()
  }, [tab, refreshSkills])

  function newSkill(scope: SkillScope) {
    setFormMsg(null)
    setSkDraft({ isNew: true, scope, originalName: '', name: '', description: '', body: '' })
  }

  async function openSkill(s: SkillItem) {
    setFormMsg(null)
    const d = await window.qingniao.readSkill({ scope: s.scope, projectPath: p.projectPath, name: s.name })
    setSkDraft({
      isNew: false,
      scope: s.scope,
      originalName: s.name,
      name: d.name || s.name,
      description: d.description,
      body: d.body
    })
  }

  async function saveSkillForm() {
    if (!skDraft || skBusy) return
    setSkBusy(true)
    try {
      const r = await window.qingniao.saveSkill({
        scope: skDraft.scope,
        projectPath: p.projectPath,
        originalName: skDraft.isNew ? undefined : skDraft.originalName,
        name: skDraft.name,
        description: skDraft.description,
        body: skDraft.body
      })
      if (r.error) {
        setFormMsg({ text: r.error, bad: true })
        return
      }
      setSkDraft(null)
      setFormMsg(null)
      await refreshSkills()
    } finally {
      setSkBusy(false)
    }
  }

  async function doRemoveSkill() {
    if (!skDel || skBusy) return
    setSkBusy(true)
    try {
      await window.qingniao.removeSkill({ scope: skDel.scope, projectPath: p.projectPath, name: skDel.name })
      setSkDel(null)
      await refreshSkills()
    } finally {
      setSkBusy(false)
    }
  }

  /** 技能分组：内置随安装包分发（只读），全局对所有项目生效，项目级只在当前项目下被内核发现 */
  function skillGroup(kind: 'builtin' | SkillScope, title: string, hint: string) {
    const usable = kind !== 'builtin' && (kind === 'global' || !!p.projectPath)
    const list = skills.filter((s) => (kind === 'builtin' ? s.builtin && s.scope === 'global' : s.scope === kind && !s.builtin))
    return (
      <div className="sk-sec" key={kind}>
        <div className="sk-head">
          <span className="sk-title">{title}</span>
          {hint && <span className="sk-hint">{hint}</span>}
          <span className="spacer" />
          {kind !== 'builtin' && (
            <>
              <button className="ghost" disabled={!usable} onClick={() => void window.qingniao.openSkillsDir({ scope: kind, projectPath: p.projectPath })}>
                <FolderOpen size={13} /> 打开目录
              </button>
              <button className="ghost" disabled={!usable} onClick={() => newSkill(kind === 'global' ? 'global' : 'project')}>
                <Plus size={13} /> 新建
              </button>
            </>
          )}
        </div>
        {!usable && kind !== 'builtin' && <div className="plist-empty">未打开项目</div>}
        {usable && list.length === 0 && (
          <div className="plist-empty hint">
            {kind === 'global' ? '还没有全局技能' : `「${p.projectName ?? '当前项目'}」下还没有技能`}
          </div>
        )}
        {kind === 'builtin' && list.length === 0 && <div className="plist-empty hint">没有内置技能</div>}
        {list.map((s) => (
          <div key={s.scope + s.name} className={'prow' + (s.error ? ' bad' : '')}>
            <span className="prow-ico">
              <Sparkles size={15} />
            </span>
            <div className="prow-main">
              <div className="prow-name">
                {s.name}
                <span className="chip">{kind === 'builtin' ? '内置' : kind === 'global' ? '全局' : '项目'}</span>
                {s.error && <span className="chip bad">不可用</span>}
              </div>
              <div className="sk-desc">{s.error ?? s.description}</div>
            </div>
            {kind !== 'builtin' && (
              <>
                <button className="icon-btn" title="编辑" onClick={() => void openSkill(s)}>
                  <Pencil size={15} />
                </button>
                <button className="icon-btn danger" title="删除" onClick={() => setSkDel(s)}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <main className="main settings">
      <div className="set-layout">
        <nav className="set-menu">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.id}
              className={'set-item' + (tab === t.id ? ' on' : '')}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={15} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="setbody" ref={body}>
        {tab === 'theme' && (
        <section>
          <h3>
            <Layers size={15} /> 主题
          </h3>
          <div className="theme-grid">
            {getThemeList().map((t) => (
              <button
                type="button"
                key={t.id}
                className={'theme-card' + (p.theme === t.id ? ' on' : '')}
                onClick={() => p.onTheme(t.id)}
              >
                <span className="swatches">
                  {swatchOf(t, p.custom).map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
                {t.name}
              </button>
            ))}
          </div>
          {p.theme === CUSTOM_ID && (
            <div className="custom-editor">
              {CUSTOM_FIELDS.map((f) => (
                <label key={f.key} className="cc-row">
                  <span>{f.label}</span>
                  <input
                    type="color"
                    value={p.custom[f.key]}
                    onChange={(e) => p.onCustom(f.key, e.target.value)}
                  />
                </label>
              ))}
              <button type="button" className="ghost cc-reset" onClick={p.onResetCustom}>
                重置
              </button>
            </div>
          )}
        </section>
        )}

        {tab === 'providers' && (
        <section>
          <h3>
            模型提供商
            <span className="spacer" />
            <button className="ghost" onClick={openNew}>
              <Plus size={14} /> 添加提供商
            </button>
          </h3>
          <p className="sec-tip">
            填写任意 OpenAI Chat 兼容端点的 Base URL 即可接入，一个提供商可挂多个模型；
            保存后自动重启内核生效，API Key 仅存于本机 ~/.qingniaoai/settings.json。
          </p>
          {providers.length === 0 && <div className="plist-empty">还没有自定义提供商，点击右上角添加</div>}
          {providers.length > 0 && (
            <div className="plist">
              {providers.map((c, i) => (
                <div key={c.id} className={'prow' + (c.enabled ? '' : ' off')}>
                  <Switch checked={c.enabled} onChange={() => toggle(i)} />
                  <div className="prow-main">
                    <div className="prow-name">
                      {c.name}
                      <span className="chip">{c.models.length} 个模型</span>
                    </div>
                    <div className="prow-url">{c.baseURL}</div>
                  </div>
                  <button className="icon-btn" title="编辑" onClick={() => openEdit(i)}>
                    <Pencil size={15} />
                  </button>
                  <button className="icon-btn danger" title="删除" onClick={() => setConfirmDel(c)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        )}

        {tab === 'mcp' && (
        <section>
          <h3>
            浏览器与扩展（MCP）
            <span className="spacer" />
            <button
              className="ghost"
              onClick={() => {
                setFormMsg(null)
                setMcpDraft({ isNew: true, index: -1, name: '', type: 'local', command: '', url: '' })
              }}
            >
              <Plus size={14} /> 添加 MCP
            </button>
          </h3>
          <p className="sec-tip">
            内置浏览器基于 Playwright MCP、桌面控制基于 computer-use-mcp（首次使用需本机有 Node.js，会自动经 npx 拉起）；
            也可以添加任意本地命令型 / 远程 URL 型 MCP 服务器扩展工具能力。变更需重启内核生效（保存时自动完成）。
          </p>
          <div className="prow">
            <Switch checked={p.settings.browser} onChange={toggleBrowser} />
            <div className="prow-main">
              <div className="prow-name">
                <Globe size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                内置浏览器
              </div>
              <div className="prow-url">AI 与右侧面板共用同一个浏览器（登录态共享），可打开网页、按元素点击、填表</div>
            </div>
          </div>
          <div className="prow">
            <Switch checked={p.settings.computerUse} onChange={toggleComputerUse} />
            <div className="prow-main">
              <div className="prow-name">
                <Monitor size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                桌面控制
              </div>
              <div className="prow-url">AI 可截屏并模拟键鼠操作电脑（需模型支持图片输入）</div>
            </div>
          </div>
          {p.settings.mcps.length === 0 && <div className="plist-empty hint">还没有添加 MCP 服务器，可添加本地命令型（stdio）或远程 URL 型（HTTP/SSE）</div>}
          {p.settings.mcps.length > 0 && (
            <div className="mcp-list">
              {p.settings.mcps.map((m, i) => (
                <div key={m.name} className={'prow' + (m.enabled ? '' : ' off')}>
                  <Switch checked={m.enabled} onChange={() => toggleMcp(i)} />
                  <span className="prow-ico">
                    {m.type === 'remote' ? <Link2 size={15} /> : <Terminal size={15} />}
                  </span>
                  <div className="prow-main">
                    <div className="prow-name">
                      {m.name}
                      <span className={'chip kind-' + m.type}>{m.type === 'remote' ? '远程' : '本地'}</span>
                    </div>
                    <div className="prow-url">{m.type === 'remote' ? m.url : m.command}</div>
                  </div>
                  <button
                    className="icon-btn"
                    title="编辑"
                    onClick={() => {
                      setFormMsg(null)
                      setMcpDraft({ isNew: false, index: i, name: m.name, type: m.type, command: m.command, url: m.url })
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button className="icon-btn danger" title="删除" onClick={() => removeMcp(i)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        )}

        {tab === 'skills' && (
        <section>
          <h3>
            技能（Skills）
          </h3>
          {skillGroup('builtin', '内置技能', '')}
          {skillGroup('global', '全局技能', '~/.qingniaoai/opencode/skills')}
          {skillGroup('project', '项目技能', p.projectName ? `${p.projectName} · .opencode/skills` : '<项目>/.opencode/skills')}
        </section>
        )}

        {tab === 'usage' && (
          <UsagePanel
            loggedIn={!!p.platform?.loggedIn}
            platformBusy={p.platformBusy}
            onLogin={p.onLogin}
          />
        )}

        {tab === 'account' && (
          <AccountPanel
            loggedIn={!!p.platform?.loggedIn}
            platformBusy={p.platformBusy}
            baseUrl={p.platform?.baseUrl ?? ''}
            onLogin={p.onLogin}
            onLogout={p.onLogout}
            onSetBaseUrl={p.onSetBaseUrl}
            onSubmitCode={p.onSubmitCode}
          />
        )}

        {tab === 'remote' && (
        <section>
          <h3>
            <Server size={15} /> 远程服务
          </h3>
          <p className="sec-tip">
            青鸟的平台账号能力（登录、内置模型、积分与用量、手机扫码操作这台电脑）全部依赖它，默认开启。
            关掉后：界面上的登录入口、手机图标、内置模型一并消失，设置里的「账号 / 使用量」两页也收起，
            青鸟不再向平台发任何请求，只用本机自己配置的模型提供商。
          </p>
          <div className="prow">
            <Switch
              checked={remote}
              onChange={(v) =>
                applySettings(
                  { ...p.settings, remote: v },
                  {
                    note: v
                      ? '将开启平台账号能力（登录、内置模型、积分与用量、手机端连接）。'
                      : '将关闭平台账号能力，界面上的登录入口、手机图标、内置模型一并消失。'
                  }
                )
              }
            />
            <div className="prow-main">
              <div className="prow-name">
                <Server size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                启用远程服务
              </div>
              <div className="prow-url">
                {remote
                  ? '已启用：可以使用平台账号、内置模型与手机端连接'
                  : '已关闭：只使用本机配置的模型提供商'}
              </div>
            </div>
          </div>
          {!remote && p.platform?.loggedIn && (
            <p className="sec-tip warn">
              当前平台账号仍处于登录状态。要让这台机器彻底与平台断开，建议在上方重新开启后到「账号」里退出登录。
            </p>
          )}
        </section>
        )}
        </div>
      </div>

      {draft && (
        <Modal title={draft.isNew ? '添加提供商' : '编辑提供商'} wide onClose={() => setDraft(null)}>
          <label>
            名称
            <input
              value={draft.name}
              placeholder="如 DeepSeek"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            ID（内核内唯一标识，留空自动生成）
            <input value={draft.id} placeholder="deepseek" onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
          </label>
          <label>
            Base URL
            <input
              value={draft.baseURL}
              placeholder="https://api.deepseek.com/v1"
              onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
            />
          </label>
          <label>
            API Key
            <div className="pw-wrap">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                placeholder="sk-..."
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
              <button
                type="button"
                className="pw-eye"
                title={showKey ? '隐藏' : '显示'}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </label>
          <label>
            模型（每行一个）
            <textarea
              rows={4}
              value={draft.modelsText}
              placeholder={'deepseek-chat\ndeepseek-reasoner'}
              onChange={(e) => setDraft({ ...draft, modelsText: e.target.value })}
            />
          </label>
          {parseModels(draft.modelsText).length > 0 && (
            <div className="model-cfgs">
              <div className="model-cfgs-tip">每个模型的上下文窗口、最大输出（token）与输入类型；输出固定为文本</div>
              {parseModels(draft.modelsText).map((mid) => {
                const c = cfgOf(mid)
                return (
                  <div className="model-cfg" key={mid}>
                    <div className="model-cfg-head">
                      <span className="model-cfg-name">{mid}</span>
                      <span className="model-cfg-out">输出：文本</span>
                    </div>
                    <div className="model-cfg-row">
                      <label>
                        上下文窗口
                        <input
                          type="number"
                          min={1}
                          value={c.context || ''}
                          onChange={(e) => updateCfg(mid, { context: e.target.valueAsNumber || 0 })}
                        />
                      </label>
                      <label>
                        最大输出 Token
                        <input
                          type="number"
                          min={1}
                          value={c.output || ''}
                          onChange={(e) => updateCfg(mid, { output: e.target.valueAsNumber || 0 })}
                        />
                      </label>
                      <div className="model-cfg-in">
                        输入
                        {MODALITY_LABELS.map((m) => (
                          <button
                            key={m.key}
                            type="button"
                            className={'iochip' + (c.input.includes(m.key) ? ' on' : '')}
                            onClick={() => toggleModality(mid, m.key)}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div className="form-row">
            <button className="ghost" onClick={fetchModels} disabled={fetching}>
              <RefreshCw size={14} className={fetching ? 'spin' : undefined} /> 自动获取模型
            </button>
            {formMsg && <span className={'form-msg' + (formMsg.bad ? ' bad' : '')}>{formMsg.text}</span>}
          </div>
          <div className="actions">
            <button className="ghost" onClick={() => setDraft(null)}>取消</button>
            <button className="primary" disabled={p.saving} onClick={saveDraft}>
              {p.saving ? '保存并重启内核…' : '保存'}
            </button>
          </div>
        </Modal>
      )}

      {mcpDraft && (
        <Modal title={mcpDraft.isNew ? '添加 MCP 服务器' : '编辑 MCP 服务器'} onClose={() => setMcpDraft(null)}>
          <div className="mcp-form">
            <div className="mcp-type">
              <button
                type="button"
                className={'seg' + (mcpDraft.type === 'local' ? ' on' : '')}
                onClick={() => { setMcpDraft({ ...mcpDraft, type: 'local' }); setFormMsg(null) }}
              >
                <Terminal size={14} />
                <div className="seg-txt">
                  <b>本地命令（stdio）</b>
                  <i>在本机启动进程，如 npx 拉起的 MCP 服务</i>
                </div>
              </button>
              <button
                type="button"
                className={'seg' + (mcpDraft.type === 'remote' ? ' on' : '')}
                onClick={() => { setMcpDraft({ ...mcpDraft, type: 'remote' }); setFormMsg(null) }}
              >
                <Link2 size={14} />
                <div className="seg-txt">
                  <b>远程地址（HTTP/SSE）</b>
                  <i>连接已部署的 MCP 服务端点 URL</i>
                </div>
              </button>
            </div>

            <label>
              名称
              <span className="lab-tip">唯一标识，自动转小写，如 context7</span>
              <input
                value={mcpDraft.name}
                placeholder="context7"
                spellCheck={false}
                onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })}
              />
            </label>

            {mcpDraft.type === 'local' ? (
              <label>
                启动命令
                <span className="lab-tip">命令与参数用空格分隔，整行填入</span>
                <textarea
                  rows={3}
                  className="mono"
                  value={mcpDraft.command}
                  placeholder={'npx -y @modelcontextprotocol/server-everything'}
                  spellCheck={false}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, command: e.target.value })}
                />
              </label>
            ) : (
              <label>
                服务地址
                <span className="lab-tip">MCP 端点的完整 URL</span>
                <input
                  className="mono"
                  value={mcpDraft.url}
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })}
                />
              </label>
            )}

            {formMsg && (
              <p className={'form-msg block' + (formMsg.bad ? ' bad' : '')}>
                {formMsg.bad ? <AlertCircle size={14} /> : <Check size={14} />}
                {formMsg.text}
              </p>
            )}

            <div className="actions">
              <button className="ghost" onClick={() => setMcpDraft(null)}>取消</button>
              <button className="primary" disabled={p.saving} onClick={saveMcpDraft}>
                {p.saving ? '保存并重启内核…' : '保存'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {skDraft && (
        <Modal
          title={skDraft.isNew ? '新建技能' : `编辑技能 · ${skDraft.scope === 'global' ? '全局' : '项目'}`}
          onClose={() => setSkDraft(null)}
        >
          <div className="mcp-form">
            {skDraft.isNew && (
              <div className="mcp-type">
                <button
                  type="button"
                  className={'seg' + (skDraft.scope === 'global' ? ' on' : '')}
                  onClick={() => {
                    setSkDraft({ ...skDraft, scope: 'global' })
                    setFormMsg(null)
                  }}
                >
                  <Globe size={14} />
                  <div className="seg-txt">
                    <b>全局技能</b>
                    <i>所有项目都生效，适合通用规范</i>
                  </div>
                </button>
                <button
                  type="button"
                  className={'seg' + (skDraft.scope === 'project' ? ' on' : '')}
                  disabled={!p.projectPath}
                  onClick={() => {
                    setSkDraft({ ...skDraft, scope: 'project' })
                    setFormMsg(null)
                  }}
                >
                  <FolderOpen size={14} />
                  <div className="seg-txt">
                    <b>项目技能</b>
                    <i>{p.projectName ? `只在「${p.projectName}」下生效` : '需先打开一个项目'}</i>
                  </div>
                </button>
              </div>
            )}

            <label>
              名称
              <span className="lab-tip">小写字母、数字与连字符，须与目录名一致，如 git-commit-zh</span>
              <input
                className="mono"
                value={skDraft.name}
                placeholder="git-commit-zh"
                spellCheck={false}
                onChange={(e) => setSkDraft({ ...skDraft, name: e.target.value })}
              />
            </label>

            <label>
              描述
              <span className="lab-tip">模型靠它判断何时加载——写清「做什么」和「什么场景下用」</span>
              <textarea
                rows={3}
                value={skDraft.description}
                placeholder="用中文撰写 git 提交信息并完成提交、推送。当用户说「写 git 日志」「提交」「push」时使用。"
                onChange={(e) => setSkDraft({ ...skDraft, description: e.target.value })}
              />
            </label>

            <label>
              正文（Markdown）
              <span className="lab-tip">frontmatter 由上面两个字段自动生成，这里只写正文</span>
              <textarea
                rows={12}
                className="mono"
                value={skDraft.body}
                spellCheck={false}
                placeholder={'## 何时使用\n\n...\n\n## 具体做法\n\n- ...'}
                onChange={(e) => setSkDraft({ ...skDraft, body: e.target.value })}
              />
            </label>

            {formMsg && (
              <p className={'form-msg block' + (formMsg.bad ? ' bad' : '')}>
                {formMsg.bad ? <AlertCircle size={14} /> : <Check size={14} />}
                {formMsg.text}
              </p>
            )}

            <div className="actions">
              <button className="ghost" onClick={() => setSkDraft(null)}>取消</button>
              <button className="primary" disabled={skBusy} onClick={saveSkillForm}>
                {skBusy ? '保存并重启内核…' : '保存'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {skDel && (
        <Modal title="删除技能" onClose={() => setSkDel(null)}>
          <p className="confirm-text">
            确定删除「{skDel.name}」吗？会连同 <b>{skDel.path}</b> 整个目录一起删掉，不可恢复。
          </p>
          <div className="actions">
            <button className="ghost" onClick={() => setSkDel(null)}>取消</button>
            <button className="primary danger-btn" disabled={skBusy} onClick={doRemoveSkill}>
              {skBusy ? '删除并重启内核…' : '删除'}
            </button>
          </div>
        </Modal>
      )}

      {confirmDel && (
        <Modal title="删除提供商" onClose={() => setConfirmDel(null)}>
          <p className="confirm-text">
            确定删除「{confirmDel.name}」及其 {confirmDel.models.length} 个模型吗？内核会重启，正在使用该提供商的会话将不可继续。
          </p>
          <div className="actions">
            <button className="ghost" onClick={() => setConfirmDel(null)}>取消</button>
            <button className="primary danger-btn" onClick={doRemove}>
              删除
            </button>
          </div>
        </Modal>
      )}

      {/* 保存设置 = 重启内核：跑着的任务会一起结束，先让用户确认；不想现在重启的可以「稍后再说」 */}
      {pending && (
        <Modal
          title="保存并重启内核"
          onClose={() => {
            const back = pending.keepTab
            setPending(null)
            if (back) setTab(back)
          }}
        >
          <p className="confirm-text">
            {pending.note}保存会重启内核，<b>正在处理的任务会一同结束</b>。确定现在保存吗？
          </p>
          <div className="actions">
            <button
              className="ghost"
              onClick={() => {
                const back = pending.keepTab
                setPending(null)
                if (back) setTab(back)
              }}
            >
              稍后再说
            </button>
            <button
              className="primary"
              disabled={p.saving}
              onClick={() => {
                const next = pending.next
                setPending(null)
                void p.onSave(next)
              }}
            >
              {p.saving ? '保存并重启内核…' : '保存并重启'}
            </button>
          </div>
        </Modal>
      )}
    </main>
  )
}
