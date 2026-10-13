/**
 * 聚合网关（openrouter / unorouter）的免费模型清单拉取。
 *
 * 与 zen.ts 同一套纪律：只读清单不发请求、拿不到返回空数组**绝不清掉已有缓存**、
 * 解析逻辑拆成纯函数便于单测。快照存进 settings.freeModels（键 = 归一化 baseURL），
 * 由 types.ts 的 mergeFreeModels() 在读取侧并入用户配置的对应提供商。
 *
 * 两家的免费口径（2026-10-13 实测）：
 *   - openrouter：公开 API /api/v1/models 无需 Key，模型条目带完整 pricing（字符串美元/token），
 *     「免费」= prompt/completion/缓存读写四项全 0（与官网 max_price=0 过滤同口径）；
 *   - unorouter：OpenAI 兼容网关（/v1/chat/completions、/v1/models 都要 Bearer Key），
 *     免费模型按官网惯例带 `:free` 后缀（如 deepseek/deepseek-v4.1-flash:free）。
 */
import type { FreeModelsCfg, Modality, ModelCfg, Settings } from './types.ts'
import { FREE_MODEL_SOURCES, freeSourceOf, normBaseURL } from './types.ts'
import { setFreeModels } from './config.ts'

/** OpenRouter /models 返回的单条模型（只取我们要的字段，其余忽略） */
interface OpenRouterModel {
  id?: string
  name?: string
  context_length?: number
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  pricing?: {
    prompt?: string
    completion?: string
    input_cache_read?: string
    input_cache_write?: string
  }
  top_provider?: { max_completion_tokens?: number }
}

/**
 * 四项计价（输入/输出/缓存读/缓存写）是否全为 0。
 *
 * 与 zen.ts 的 isFree 同一个理由：缓存读写另有计价，漏查会把「输入 0 但缓存收费」的
 * 模型当免费收进来，用户用着悄悄产生费用。字段缺失（未提供）按 0 算——
 * OpenRouter 对不缓存请求的模型可能不写这个键。
 */
function pricingAllZero(m: OpenRouterModel): boolean {
  const p = m.pricing
  if (!p) return false
  const num = (v: string | undefined): number => (v === undefined || v === '' ? 0 : Number(v))
  for (const v of [p.prompt, p.completion, p.input_cache_read, p.input_cache_write]) {
    const n = num(v)
    if (!Number.isFinite(n) || n !== 0) return false
  }
  return true
}

/** OpenRouter 模态名 → 我们的 Modality（audio/pdf 等本机不认的直接丢） */
function toModalities(list: string[] | undefined): Modality[] {
  const out: Modality[] = []
  if (list?.includes('text')) out.push('text')
  if (list?.includes('image')) out.push('image')
  if (list?.includes('video')) out.push('video')
  return out
}

/**
 * 从 OpenRouter /api/v1/models 的响应里挑出免费且能对话的模型。
 *
 * 纯函数（不碰网络、不碰磁盘）。形状不对、缺字段、非免费、输出非文本的一律滤掉——
 * 宁可少显示几个，也不能把一个要钱的模型标成「免费」。
 */
export function parseOpenRouterFree(payload: unknown): ModelCfg[] {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: ModelCfg[] = []
  for (const raw of data as OpenRouterModel[]) {
    if (!raw?.id || !pricingAllZero(raw)) continue
    const input = toModalities(raw.architecture?.input_modalities)
    // 无文本输入的（纯图像/音频类）不能当对话模型，滤掉
    if (!input.length) continue
    // 输出模态声明了但不含 text 的（embedding / 纯图像输出类）同样滤掉；没声明的不卡
    const outMods = raw.architecture?.output_modalities
    if (Array.isArray(outMods) && outMods.length > 0 && !outMods.includes('text')) continue
    out.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined,
      // 上下文缺失时不猜：交给 normalizeModel 落 MODEL_DEFAULTS
      ...(Number(raw.context_length) > 0 ? { context: Number(raw.context_length) } : {}),
      ...(Number(raw.top_provider?.max_completion_tokens) > 0
        ? { output: Number(raw.top_provider!.max_completion_tokens) }
        : {}),
      input,
      gen: 'none'
    } as ModelCfg)
  }
  return out
}

/** unorouter /v1/models 的单条模型（OpenAI 列表格式，可能带扩展字段） */
interface UnoModel {
  id?: string
  name?: string
  /** 有的网关在列表接口就给上下文长度，给了就采用 */
  context_length?: number
  context_size?: number
  pricing?: { prompt?: unknown; completion?: unknown }
  /**
   * 该模型支持的端点类型：'openai'（chat/completions）、'embedding'、
   * 'image-generation'、'aihorde'（社区图像生成）等。**同一模型可声明多种**。
   */
  supported_endpoint_types?: string[]
}

/**
 * unorouter 的免费判定（2026-10-13 实测 125 个 `:free` 模型里近半不能对话）：
 *   1. id 带 `:free` 后缀（官网惯例，免费与付费是两个 id）；
 *   2. 端点类型**含 'openai'**（能走 chat/completions）且**不含** 'embedding' / 'image-generation'
 *      （后两类即使同时标了 openai 也是各自的专用接口，选了必被拒）；
 *      没声明端点类型的不卡——别因为字段缺失把能用的模型滤没了。
 *   3. 若条目还带 pricing 字段，则要求那两项也为 0——「叫 :free 但计价非 0」的不收。
 * 拿不到上下文长度就落 MODEL_DEFAULTS（列表接口不保证给）。
 */
export function parseUnoRouterFree(payload: unknown): ModelCfg[] {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: ModelCfg[] = []
  for (const raw of data as UnoModel[]) {
    if (!raw?.id || !raw.id.endsWith(':free')) continue
    const types = Array.isArray(raw.supported_endpoint_types) ? raw.supported_endpoint_types : []
    if (types.length) {
      if (!types.includes('openai')) continue
      if (types.includes('embedding') || types.includes('image-generation')) continue
    }
    // 带计价的条目核一遍确实免费（字段缺失跳过这条校验）
    if (raw.pricing && (raw.pricing.prompt !== undefined || raw.pricing.completion !== undefined)) {
      const pp = Number(raw.pricing.prompt ?? 0)
      const pc = Number(raw.pricing.completion ?? 0)
      if ((Number.isFinite(pp) && pp !== 0) || (Number.isFinite(pc) && pc !== 0)) continue
    }
    const ctx = Number(raw.context_length ?? raw.context_size)
    out.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined,
      ...(ctx > 0 ? { context: ctx } : {}),
      input: ['text'],
      gen: 'none'
    } as ModelCfg)
  }
  return out
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    // 超时/断网/被墙：当作「暂时拿不到」，不报错也不清缓存
    return null
  }
}

/** OpenRouter 免费清单（公开 API，无需 Key） */
export async function fetchOpenRouterFree(): Promise<ModelCfg[]> {
  const payload = await getJson(FREE_MODEL_SOURCES.openrouter + '/models', { accept: 'application/json' })
  return payload ? parseOpenRouterFree(payload) : []
}

/** unorouter 免费清单（要用户在该提供商里填的 Bearer Key） */
export async function fetchUnoRouterFree(apiKey: string): Promise<ModelCfg[]> {
  if (!apiKey) return []
  const payload = await getJson(FREE_MODEL_SOURCES.unorouter + '/models', {
    accept: 'application/json',
    authorization: 'Bearer ' + apiKey
  })
  return payload ? parseUnoRouterFree(payload) : []
}

/**
 * 把所有已配置网关的免费清单同步一遍并落盘（窗口显示 / 点开选择器时调）。
 *
 * 只处理「启用的、baseURL 命中已知来源」的提供商；unorouter 没 Key 时不问（问了也是 401）。
 * 拿不到（网络失败/空清单）的一律**不写盘**，保住旧快照；与旧快照逐字节比对决定 changed，
 * 上层据此决定要不要重启内核（免费模型要写进 opencode.json 才能被内核路由）。
 */
export async function refreshRouterFreeModels(s: Settings): Promise<{ settings: Settings; changed: boolean }> {
  const tasks: { url: string; run: () => Promise<ModelCfg[]> }[] = []
  const seen = new Set<string>()
  for (const p of s.providers) {
    if (!p.enabled) continue
    const src = freeSourceOf(p.baseURL)
    if (!src) continue
    const url = normBaseURL(p.baseURL)
    if (seen.has(url)) continue // 同地址配了多个提供商：同一份清单只拉一次
    seen.add(url)
    if (src === 'openrouter') tasks.push({ url, run: fetchOpenRouterFree })
    else if (src === 'unorouter' && p.apiKey.trim()) tasks.push({ url, run: () => fetchUnoRouterFree(p.apiKey.trim()) })
  }
  if (!tasks.length) return { settings: s, changed: false }
  console.log('[freemodels] sync sources:', tasks.map((t) => t.url).join(', '))

  const patch: Record<string, FreeModelsCfg> = {}
  let changed = false
  await Promise.all(
    tasks.map(async (t) => {
      const models = await t.run()
      console.log('[freemodels]', t.url, '->', models.length, 'models')
      // 空清单不落盘：可能是网络问题，别把用户已有的免费模型清空
      if (!models.length) return
      const cur = s.freeModels?.[t.url]?.models ?? []
      if (JSON.stringify(cur) !== JSON.stringify(models)) changed = true
      patch[t.url] = { models, syncedAt: Date.now() }
    })
  )
  if (!Object.keys(patch).length) return { settings: s, changed: false }
  return setFreeModels(patch)
}
