import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings, qingniaoHome } from './config.ts'

/**
 * 思考形态探测：只解决一件事——某模型是「开关型」还是「真有低/中/高」。
 *
 * 为什么非要探测：内核能力表（models.dev）只有 `capabilities.reasoning` 一个布尔值，
 * 「支不支持思考」有了，但「到底是开关还是分档」全库查无此字段（实测内核返回的 7845 条模型记录里
 * `reasoning_options` 全部缺失，openai / anthropic 内置 provider 也没有）。而各家网关实现并不一致——
 * agnes-3.0-flash 就是典型：低/中/高对它完全等效（reasoning tokens 60/53/60），真正管用的只有开/关。
 *
 * 办法只能是打一枪：同一道推理题分别以 `reasoning_effort` = none / low / high 发三次极小请求，
 * 比对「思考量」（优先 `usage.completion_tokens_details.reasoning_tokens`，没有该字段时用
 * 返回消息里的 `reasoning_content` 长度兜底）：
 *   - low / high 都没思考 → 不支持思考（off）
 *   - 都思考了，但用量不分档 → 开关型（toggle）
 *   - high 的思考量明显高于 low → 真分档（effort）
 *
 * 结果按「提供商/模型」永久缓存（~/.qingniaoai/thinking-probe.json），一个模型一辈子只花这几十 token。
 */
export type ThinkProbeKind = 'effort' | 'toggle' | 'off'

export interface ThinkProbeResult {
  kind: ThinkProbeKind
  /** 各档的思考量（reasoning tokens 或 reasoning_content 字数），用于人工复核 */
  tokens: { none: number; low: number; high: number }
}

const CACHE_FILE = 'thinking-probe.json'
/** 一道需要几步推导的应用题：档位之间有没有区别，在这种题上才看得出（太简单的题开关都一样） */
const PROBE_QUESTION =
  '一个水池，甲管单独注满需6小时，乙管需4小时，丙管排空需12小时。三管齐开，几小时注满？请推理后给出答案。'
/** 给思考留出足够空间：reasoning 计入输出 token，太小会被截断 */
const PROBE_MAX_TOKENS = 400

function cachePath(): string {
  return join(qingniaoHome(), CACHE_FILE)
}

function loadCache(): Record<string, ThinkProbeResult> {
  try {
    if (!existsSync(cachePath())) return {}
    return JSON.parse(readFileSync(cachePath(), 'utf8')) as Record<string, ThinkProbeResult>
  } catch {
    return {}
  }
}

function writeCache(c: Record<string, ThinkProbeResult>): void {
  try {
    mkdirSync(qingniaoHome(), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(c, null, 2))
  } catch {
    /* 缓存写失败不影响使用，下次再探 */
  }
}

/** 单次极小请求：返回该档位的思考量；请求失败/被拒返回 null（不参与判定） */
async function thinkOnce(baseURL: string, apiKey: string, model: string, effort: string): Promise<number | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 30_000)
    const res = await fetch(baseURL.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.trim()}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROBE_QUESTION }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
        reasoning_effort: effort
      }),
      signal: ctrl.signal
    })
    clearTimeout(t)
    if (!res.ok) return null
    const j = (await res.json()) as {
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } }
      choices?: { message?: { reasoning_content?: string; reasoning?: string } }[]
    }
    const n = j.usage?.completion_tokens_details?.reasoning_tokens
    if (typeof n === 'number') return n
    const rc = j.choices?.[0]?.message?.reasoning_content ?? j.choices?.[0]?.message?.reasoning ?? ''
    return rc.length
  } catch {
    return null
  }
}

/**
 * 只读缓存：批量取已探过的结论，**绝不发请求**（界面打开时预填用——一次性把所有模型的探测结论
 * 铺上，切模型就不会先闪一下「低/中高」再变成「关/开」）。没探过的模型不在结果里，等切到它再探。
 */
export function cachedThinking(keys: string[]): Record<string, ThinkProbeKind> {
  const cache = loadCache()
  const out: Record<string, ThinkProbeKind> = {}
  for (const k of keys) {
    if (cache[k]) out[k] = cache[k].kind
  }
  return out
}

/**
 * 探测某模型的思考形态。已探过直接返回缓存；三轮请求任一失败则返回 null（表示「这次没能判定」，
 * 调用方继续用旧的推断结果，绝不让一次网络抖动把能思考的模型判成不支持）。
 */
export async function probeThinking(providerID: string, modelID: string): Promise<ThinkProbeResult | null> {
  const cache = loadCache()
  const key = `${providerID}/${modelID}`
  if (cache[key]) return cache[key]
  const p = loadSettings().providers.find((x) => x.id === providerID)
  if (!p || !p.baseURL.trim() || !p.apiKey?.trim()) return null

  const [none, low, high] = [
    await thinkOnce(p.baseURL, p.apiKey, modelID, 'none'),
    await thinkOnce(p.baseURL, p.apiKey, modelID, 'low'),
    await thinkOnce(p.baseURL, p.apiKey, modelID, 'high')
  ]
  // low/high 必须都实测成功，否则没资格下结论
  if (low === null || high === null) return null

  let kind: ThinkProbeKind
  if (low <= 0 && high <= 0) kind = 'off'
  // 真分档要「明显」，取 1.5 倍且差值不小于 40：档位本身有随机波动，阈值太低会把开关误判成分档
  else if (low > 0 && high >= low * 1.5 && high - low >= 40) kind = 'effort'
  else kind = 'toggle'

  const result: ThinkProbeResult = { kind, tokens: { none: none ?? -1, low, high } }
  cache[key] = result
  writeCache(cache)
  return result
}
