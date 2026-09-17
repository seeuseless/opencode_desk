import { useState } from 'react'
import { AlertCircle, Check, Eye, EyeOff, Globe, Layers, Link2, Pencil, Plus, RefreshCw, Terminal, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { Switch } from './Switch'
import { getThemeList, CUSTOM_ID, type ThemeMeta } from '../theme'
import type { CustomColors } from '../themeColors'
import type { McpCfg, ProviderCfg, SettingsCfg } from '../oc'

interface Props {
  settings: SettingsCfg
  onSave: (s: SettingsCfg) => Promise<void>
  saving: boolean
  theme: string
  onTheme: (id: string) => void
  custom: CustomColors
  onCustom: (key: keyof CustomColors, value: string) => void
  onResetCustom: () => void
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

interface Draft {
  isNew: boolean
  index: number
  name: string
  id: string
  baseURL: string
  apiKey: string
  modelsText: string
}

interface McpDraft {
  isNew: boolean
  index: number
  name: string
  type: 'local' | 'remote'
  command: string
  url: string
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

export function SettingsView(p: Props) {
  const providers = p.settings.providers
  const [draft, setDraft] = useState<Draft | null>(null)
  const [mcpDraft, setMcpDraft] = useState<McpDraft | null>(null)
  const [fetching, setFetching] = useState(false)
  const [formMsg, setFormMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [confirmDel, setConfirmDel] = useState<ProviderCfg | null>(null)
  const [showKey, setShowKey] = useState(false)

  function openNew() {
    setFormMsg(null)
    setDraft({ isNew: true, index: -1, name: '', id: '', baseURL: '', apiKey: '', modelsText: '' })
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
      modelsText: c.models.join('\n')
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
      models: parseModels(draft.modelsText)
    }
    const list = draft.isNew ? [...providers, cfg] : providers.map((x, i) => (i === draft.index ? cfg : x))
    await p.onSave({ ...p.settings, providers: list })
    setDraft(null)
  }

  async function toggle(i: number) {
    await p.onSave({ ...p.settings, providers: providers.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)) })
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
    await p.onSave({ ...p.settings, mcps: p.settings.mcps.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)) })
  }

  async function removeMcp(i: number) {
    await p.onSave({ ...p.settings, mcps: p.settings.mcps.filter((_, k) => k !== i) })
  }

  async function toggleBrowser() {
    await p.onSave({ ...p.settings, browser: !p.settings.browser })
  }

  return (
    <main className="main settings">
      <div className="setbody">
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
            内置浏览器基于 Playwright MCP（首次使用需本机有 Node.js，会自动经 npx 拉起）；
            也可以添加任意本地命令型 / 远程 URL 型 MCP 服务器扩展工具能力。变更需重启内核生效（保存时自动完成）。
          </p>
          <div className="prow">
            <Switch checked={p.settings.browser} onChange={toggleBrowser} />
            <div className="prow-main">
              <div className="prow-name">
                <Globe size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                内置浏览器
              </div>
              <div className="prow-url">AI 可打开网页、截图、点击、抓取内容</div>
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
      </div>

      {draft && (
        <Modal title={draft.isNew ? '添加提供商' : '编辑提供商'} onClose={() => setDraft(null)}>
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
    </main>
  )
}
