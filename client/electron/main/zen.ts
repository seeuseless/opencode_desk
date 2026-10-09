/**
 * OpenCode Zen 免费模型 —— 从内核自身读取清单，零手工维护。
 *
 * 机制（实测结论，细节见 docs/内核Zen免费模型机制.md）：
 *   1. 内核内置一个 id 为 `opencode` 的 provider（OpenAI 兼容，指向 https://opencode.ai/zen/v1），
 *      **在没有 OPENCODE_API_KEY 时只暴露那批免费模型**，付费的一个都不列；
 *   2. 免费模型不需要 API Key，但**必须经内核调用**——桌面端直连会被 403
 *      （FreeTierError: "can only be used from within OpenCode"）挡掉，所以本模块只读清单，不发请求；
 *   3. 清单里每个模型都带 capabilitities（模态 / 思考 / 交错思考字段）与各自的 context/output 上限，
 *      直接采用，别自己拍一套默认值（免费模型之间差异很大：200K 到 1M 都有）。
 *
 * 因此这里只做一件事：把 `GET /config/providers` 里 opencode 那份翻译成我们的 ModelCfg。
 */
import type { ModelCfg } from './types.ts'

/** 内核 provider 清单里 Zen 那条的 id（内核内置，非我们定义） */
const ZEN_KERNEL_PROVIDER_ID = 'opencode'

/** 内核返回的模型条目（只取我们要的字段，其余忽略） */
interface KernelModel {
  id?: string
  name?: string
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
  limit?: { context?: number; output?: number }
  capabilities?: {
    reasoning?: boolean
    toolcall?: boolean
    attachment?: boolean
    input?: { text?: boolean; image?: boolean; audio?: boolean; video?: boolean; pdf?: boolean }
  }
}

/**
 * 内核 capabilities → 我们的输入模态白名单（INPUT_OPTIONS）。
 *
 * 只映射内核明确标 true 的：`vision` 是本机专用标记（挑「识图代看」目标用），
 * 内核不认这个词，绝不能从 capabilities 推——那会让一堆纯文本模型看起来支持读图。
 */
function toModalities(m: KernelModel): ModelCfg['input'] {
  const inp = m.capabilities?.input
  if (!inp?.text) return []
  const out: ModelCfg['input'] = ['text']
  if (inp.image) out.push('image')
  if (inp.video) out.push('video')
  return out
}

/**
 * 是不是免费模型 —— 四项费用全为 0 才算。
 *
 * 四个都要查而不是只看 input/output：缓存读写另有计价，出现「输入 0 但缓存收费」的模型时，
 * 只查两项会把它当免费收进来，用户用着悄悄产生费用。
 */
function isFree(m: KernelModel): boolean {
  const c = m.cost
  return !!c && c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0
}

/**
 * 从 `/config/providers` 的响应里挑出 Zen 的免费模型。
 *
 * 纯函数（不碰网络、不碰磁盘），单独拆出来是为了能直接单测，也便于渲染层复用同一套判定。
 * 形状不对、缺字段、非免费模型一律滤掉——宁可少显示几个，也不能把一个要钱的模型标成「免费」。
 */
export function parseZenModels(payload: unknown): ModelCfg[] {
  const providers = (payload as { providers?: unknown })?.providers
  if (!Array.isArray(providers)) return []
  const zen = providers.find(
    (p) => (p as { id?: string })?.id === ZEN_KERNEL_PROVIDER_ID
  ) as { models?: Record<string, KernelModel> } | undefined
  const models = zen?.models
  if (!models || typeof models !== 'object') return []

  const out: ModelCfg[] = []
  for (const raw of Object.values(models)) {
    if (!raw?.id || !isFree(raw)) continue
    const input = toModalities(raw)
    // 无文本输入的模型（纯图像/音频类）不能当对话模型，滤掉
    if (!input.length) continue
    out.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined,
      // 上限缺失时不猜：交给 normalizeModel 落 MODEL_DEFAULTS，总比写一个假的小值卡住长对话强
      ...(Number(raw.limit?.context) > 0 ? { context: Number(raw.limit!.context) } : {}),
      ...(Number(raw.limit?.output) > 0 ? { output: Number(raw.limit!.output) } : {}),
      input,
      gen: 'none',
      // 标签用 zenFree 而不是 free：见 types.ts 里两者的区别（免费 ≠ 限免）
      zenFree: true
    } as ModelCfg)
  }
  return out
}

/**
 * 向内核要一次 provider 清单并解析出免费模型。
 *
 * 拿不到（内核没起/超时/清单形状变了）一律返回空数组，**绝不让它把已有清单清空**——
 * 上层据此决定「是否显示这个分组」，返回空只是不显示，不影响用户已配好的模型。
 */
export async function fetchZenModels(base: string): Promise<ModelCfg[]> {
  if (!base) return []
  try {
    const res = await fetch(base + '/config/providers', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return []
    return parseZenModels(await res.json())
  } catch {
    // 卡网/超时/内核异常：当作「暂时拿不到」，不报错也不清缓存
    return []
  }
}