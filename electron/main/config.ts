import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { McpCfg, ModelCfg, Modality, ProviderCfg, Settings } from './types.ts'
import { MODEL_DEFAULTS, MODALITIES } from './types.ts'

export type { McpCfg, ProviderCfg, Settings } from './types.ts'
export { DEFAULT_SETTINGS } from './types.ts'

/**
 * 青鸟设置 → OpenCode 内核配置的桥：
 * ~/.qingniaoai/settings.json          应用层数据（UI 唯一事实源）
 * ~/.qingniaoai/opencode/              内核配置目录（生成的 opencode.json；XDG_CONFIG_HOME 隔离）
 * ~/.qingniaoai/data/                  OpenCode 会话存储（XDG_DATA_HOME 隔离，不污染用户默认目录）
 */

const storeDir = () => join(homedir(), '.qingniaoai')
export const settingsPath = () => join(storeDir(), 'settings.json')
/** opencode 在 XDG_CONFIG_HOME 下再套一层 opencode/ 目录（实测） */
export const opencodeConfigDir = () => join(storeDir(), 'opencode')
export const opencodeDataDir = () => join(storeDir(), 'data')
export const opencodeStateDir = () => join(storeDir(), 'state')
export const opencodeConfigPath = () => join(opencodeConfigDir(), 'opencode.json')
export const qingniaoHome = storeDir

/** 单条模型记录归一化：兼容旧版字符串数组与手改文件的缺字段，缺失一律落默认参数 */
function normalizeModel(m: unknown): ModelCfg | null {
  if (typeof m === 'string') return { id: m, context: MODEL_DEFAULTS.context, output: MODEL_DEFAULTS.output, input: [...MODEL_DEFAULTS.input] }
  if (!m || typeof (m as ModelCfg).id !== 'string' || !(m as ModelCfg).id.trim()) return null
  const r = m as Partial<ModelCfg>
  return {
    id: r.id!.trim(),
    context: Number(r.context) > 0 ? Number(r.context) : MODEL_DEFAULTS.context,
    output: Number(r.output) > 0 ? Number(r.output) : MODEL_DEFAULTS.output,
    input: Array.isArray(r.input) ? r.input.filter((x): x is Modality => MODALITIES.includes(x)) : [...MODEL_DEFAULTS.input]
  }
}

/** 补齐缺失字段并做形状清洗（旧版存档 / 手改文件都走这里） */
export function normalize(raw: Partial<Settings> | null | undefined): Settings {
  const providers: ProviderCfg[] = Array.isArray(raw?.providers)
    ? raw!.providers
        .filter((p): p is ProviderCfg => !!p && typeof p.id === 'string')
        .map((p) => ({
          id: String(p.id).trim(),
          name: String(p.name ?? p.id),
          baseURL: String(p.baseURL ?? ''),
          apiKey: String(p.apiKey ?? ''),
          enabled: p.enabled !== false,
          models: Array.isArray(p.models) ? p.models.map(normalizeModel).filter((m): m is ModelCfg => !!m) : []
        }))
    : []
  const mcps: McpCfg[] = Array.isArray(raw?.mcps)
    ? raw!.mcps
        .filter((m): m is McpCfg => !!m && typeof m.name === 'string' && (m.name as string).trim() !== '')
        .map((m) => ({
          name: String(m.name).trim(),
          type: m.type === 'remote' ? 'remote' : 'local',
          command: String(m.command ?? ''),
          url: String(m.url ?? ''),
          enabled: m.enabled !== false
        }))
    : []
  // 内置浏览器默认开启：没记录过开关的新/旧配置都开，用户显式关过（false）才保持关；
  // 桌面控制涉及键鼠操控，默认关
  return { providers, mcps, browser: raw?.browser !== false, computerUse: raw?.computerUse === true }
}

/** 旧数据目录一次性迁移（codexdesk / qingniao / justdo 时代的设置） */
function migrateLegacy(): void {
  if (existsSync(settingsPath())) return
  for (const old of [join(homedir(), '.codexdesk'), join(homedir(), '.qingniao'), join(homedir(), '.justdo')]) {
    const src = join(old, 'settings.json')
    if (!existsSync(src)) continue
    try {
      mkdirSync(storeDir(), { recursive: true })
      writeFileSync(settingsPath(), JSON.stringify(normalize(JSON.parse(readFileSync(src, 'utf8')) as Partial<Settings>), null, 2))
    } catch {
      /* 坏文件直接忽略，走空配置 */
    }
    return
  }
}

export function loadSettings(): Settings {
  migrateLegacy()
  try {
    return normalize(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>)
  } catch {
    return normalize({}) // 坏文件/无文件：走默认配置（内置浏览器默认开）
  }
}

export function saveSettings(s: Settings): void {
  mkdirSync(storeDir(), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(normalize(s), null, 2))
  writeOpencodeConfig(loadSettings())
}

/** provider 密钥经环境变量注入（opencode.json 的 {env:...} 插值） */
export function envKey(providerID: string): string {
  return 'QN_KEY_' + providerID.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

export function providerEnv(s: Settings): Record<string, string> {
  const env: Record<string, string> = {}
  for (const p of s.providers) {
    if (p.enabled && p.apiKey) env[envKey(p.id)] = p.apiKey
  }
  return env
}

/** 真正会写入 opencode.json 的 provider（writeOpencodeConfig 与 defaultModel 的唯一判定源） */
export function usableProviders(s: Settings): ProviderCfg[] {
  return s.providers.filter((p) => p.enabled && p.id.trim() && p.baseURL.trim() && p.models.length > 0)
}

/**
 * 生成内核配置：自定义提供商（OpenAI Chat 兼容，经 @ai-sdk/openai-compatible）+ MCP（含内置浏览器与桌面控制）。
 * opencode 默认放行全部工具执行，无需 permission 配置；端点必须提供 /chat/completions。
 */
export function writeOpencodeConfig(s: Settings): void {
  mkdirSync(opencodeConfigDir(), { recursive: true })
  const provider: Record<string, unknown> = {}
  for (const p of usableProviders(s)) {
    const id = p.id.trim()
    provider[id] = {
      npm: '@ai-sdk/openai-compatible',
      name: p.name || id,
      options: {
        baseURL: p.baseURL.trim().replace(/\/+$/, ''),
        apiKey: '{env:' + envKey(id) + '}'
      },
      // 每模型接入参数：上下文窗口/最大输出 → limit，输入类型 → modalities.input（输出固定文本）
      models: Object.fromEntries(
        p.models.map((m) => [
          m.id,
          { limit: { context: m.context, output: m.output }, modalities: { input: m.input, output: ['text'] } }
        ])
      )
    }
  }
  const mcp: Record<string, unknown> = {}
  if (s.browser) {
    // --headless：AI 的浏览器操作不弹独立 Chrome 窗口，画面经截图进右侧浏览面板
    mcp.playwright = {
      type: 'local',
      command: ['npx', '-y', '@playwright/mcp@latest', '--headless'],
      enabled: true
    }
  }
  if (s.computerUse) {
    // 截屏 + 键鼠模拟控制本机（nut.js 实现，跨平台；模型需支持图片输入）
    mcp['computer-use'] = {
      type: 'local',
      command: ['npx', '-y', 'computer-use-mcp'],
      enabled: true
    }
  }
  for (const m of s.mcps) {
    if (m.type === 'remote') {
      if (!m.url.trim()) continue
      mcp[m.name] = { type: 'remote', url: m.url.trim(), enabled: m.enabled }
    } else {
      const argv = m.command.trim().split(/\s+/).filter(Boolean)
      if (!argv.length) continue
      mcp[m.name] = { type: 'local', command: argv, enabled: m.enabled }
    }
  }
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    provider,
    mcp
  }
  writeFileSync(opencodeConfigPath(), JSON.stringify(cfg, null, 2))
}

/** 首个可用 provider+model，作为 UI 未选中/选中失效时的回落档 */
export function defaultModel(s: Settings): { providerID: string; modelID: string } | undefined {
  const p = usableProviders(s)[0]
  const m = p?.models[0]
  return p && m ? { providerID: p.id, modelID: m.id } : undefined
}

/**
 * 把 UI 传来的模型选择校正到 opencode.json 里实际存在的 provider（存档值可能因改名/停用/删除而失效）。
 * 命中不了回落默认档；一个可用提供商都没有时返回 undefined（由调用方决定报错还是放行内核默认）。
 */
export function resolveModel(
  s: Settings,
  sel?: { providerID?: string; modelID?: string }
): { providerID: string; modelID: string } | undefined {
  const list = usableProviders(s)
  const hit = sel?.providerID ? list.find((p) => p.id === sel.providerID) : undefined
  if (!hit) return defaultModel(s)
  const modelID = sel?.modelID && hit.models.some((m) => m.id === sel.modelID) ? sel.modelID : hit.models[0].id
  return { providerID: hit.id, modelID }
}
