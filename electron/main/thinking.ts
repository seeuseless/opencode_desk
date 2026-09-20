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

/** 内存缓存：进程内唯一事实源，避免并发探测各读一份再互相覆盖（后写把先写的结论冲掉） */
let cacheMem: Record<string, ThinkProbeResult> | null = null

function loadCache(): Record<string, ThinkProbeResult> {
  if (cacheMem) return cacheMem
  try {
    cacheMem = existsSync(cachePath())
      ? (JSON.parse(readFileSync(cachePath(), 'utf8')) as Record<string, ThinkProbeResult>)
      : {}
  } catch {
    cacheMem = {}
  }
  return cacheMem
}

/**
 * 写缓存：**先合并进内存再整体落盘**。
 * 预填/切模型会同时触发多个模型的探测，若各自拿旧的整份快照去写，就会相互覆盖——
 * 表现为「这个模型探好了，切走再切回来又变回旧的」，所以必须走内存统一合并。
 */
function remember(key: string, result: ThinkProbeResult): void {
  const c = loadCache()
  c[key] = result
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

/** 某档位的思考量要多采几次——网关的思考量随机性很大，单次采样会误判 */
const SAMPLES_PER_EFFORT = 3

/** 中位数：抗单次抖动，比平均值稳 */
function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}

/**
 * 判定形态。**核心取舍：拿不准时判 effort（分档）而不是 toggle**。
 *
 * 实测教训：deepseek-flash 同一档连打三次，low = 134/192/166、high = 177/228/185——
 * 两个区间**大幅重叠**，单次采样经常出现「高档比低档还少」（实测抽到过 low=214 / high=137），
 * 于是被判成开关型，用户切走再切回来档位就从「低中高」变成了「开关」。
 *
 * 所以只要**两档都确实在思考**，且 high 的中位数不低于 low 的 0.8 倍（没出现"高档反而明显更少"这种
 * 说明根本不接受分档的证据），就判 effort：分档多给几个选项无害（档位默认停在高，用户只是多点两下），
 * 误判成开关却会让用户真的失去低/中/高。
 */
function decideKind(none: number, low: number, high: number): ThinkProbeKind {
  if (low <= 0 && high <= 0) return 'off'
  // high 明显低于 low（不足八成）：这个网关不认分档，只当开关使
  if (high < low * 0.8) return 'toggle'
  return 'effort'
}

/**
 * 探测某模型的思考形态。**每个模型各探各的、各存各的**（key 为 `提供商ID/模型ID`）——
 * 档位形态是「模型 + 网关」的属性，绝不能几个模型共用一份结论。
 *
 * - 已探过且非强制 → 直接返回缓存（不花 token）；
 * - `force` → 忽略缓存重探（网关若更新过能力，结论会过时，留个重探口子）；
 * - 关键档位采不满样本 → 返回 null（表示「这次没能判定」），调用方保留原判定，
 *   绝不让一次网络抖动把能思考的模型判成不支持。
 */
export async function probeThinking(
  providerID: string,
  modelID: string,
  force = false
): Promise<ThinkProbeResult | null> {
  const key = `${providerID}/${modelID}`
  const cache = loadCache()
  if (!force && cache[key]) return cache[key]
  const p = loadSettings().providers.find((x) => x.id === providerID)
  if (!p || !p.baseURL.trim() || !p.apiKey?.trim()) return null

  /** 同一档连打 SAMPLES_PER_EFFORT 次取中位数；只要有一次成功就算采到（思考量本身就会飘） */
  const sample = async (effort: string): Promise<number | null> => {
    const got: number[] = []
    for (let i = 0; i < SAMPLES_PER_EFFORT; i++) {
      const n = await thinkOnce(p.baseURL, p.apiKey, modelID, effort)
      if (n !== null) got.push(n)
    }
    return got.length ? median(got) : null
  }

  const none = await sample('none')
  const low = await sample('low')
  const high = await sample('high')
  // low/high 必须都采到，否则没资格下结论
  if (low === null || high === null) return null

  const result: ThinkProbeResult = {
    kind: decideKind(none ?? 0, low, high),
    tokens: { none: none ?? -1, low, high }
  }
  remember(key, result)
  return result
}

/** 清掉某模型（不传则全部）的探测缓存，下次切到它就会重探 */
export function clearThinkingCache(modelKey?: string): void {
  const c = loadCache()
  if (modelKey) delete c[modelKey]
  else for (const k of Object.keys(c)) delete c[k]
  try {
    mkdirSync(qingniaoHome(), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(c, null, 2))
  } catch {
    /* 忽略 */
  }
}
