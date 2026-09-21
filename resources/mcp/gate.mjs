#!/usr/bin/env node
/**
 * 「AI 调用其他模型」授权闸门 —— MCP 侧客户端。
 *
 * 为什么需要它：青鸟里除对话模型外，运行时还会调用**别的模型** —— 视觉代看（桌面截图、
 * describe_image）、生图 / 生视频 / 配音 / 音乐 / 语音识别。这些调用发生在 MCP 子进程里，
 * 由主进程下发的 baseURL + apiKey 直连上游，主进程原本完全看不见，用户也一直被蒙在鼓里。
 *
 * 产品要求：**不管访问权限档位是「默认」还是「完全控制」**，这类「额外调用别的模型」
 * 都要先问过用户（仅这一次 / 本次会话 / 永久），并且一轮回复结束时能列出用过哪些模型。
 *
 * 所以每个会调模型的 MCP，在真正发请求之前先 `await authorize(...)`：
 *   - 已经有授权（会话级或永久级）→ 主进程立即回 allowed，零感知；
 *   - 没有 → 主进程**挂起这个 HTTP 请求**，推一张确认卡到界面，用户答完再回；
 *   - 用户拒绝 / 等太久 → 回 allowed:false，工具返回一句让模型停手的话。
 * 调成功之后再 `markUsed(...)` 回报一次，供「本轮用到哪些模型」的汇总。
 *
 * **闸门自身故障一律放行（fail-open）**：端点连不上（老版本、端口不对、主进程还没起来）
 * 时直接返回 allowed。授权是**保护**，不是**功能开关**——绝不能因为闸门本身出问题，
 * 让生图、识图、桌面控制这些本来好好的能力全瘫掉。
 */

/** 主进程本地控制端点端口（开机动态分配，config.ts 注入 QN_GATE_PORT；兜底 39521 是默认起始口） */
const PORT = Number(process.env.QN_GATE_PORT || 0) || 39521
const BASE = 'http://127.0.0.1:' + PORT

/**
 * 彻底关掉闸门的开关（`QN_GATE_OFF=1`）。
 * 用户明确不想要任何拦截、或排查「是不是闸门在捣乱」时用；正常安装包不设这个变量。
 */
const OFF = process.env.QN_GATE_OFF === '1'

/**
 * 网络层兜底超时。真正的「用户多久没作答算拒绝」由主进程那侧的计时器决定
 * （各角色上限不同：桌面截图只有 30s 的 MCP 总超时，不能等太久），这里必须比它宽松，
 * 否则会在主进程还没回话时先把请求掐掉，把「拒绝」错报成「不可达」→ 反而放行。
 */
const WAIT_MS = Number(process.env.QN_GATE_WAIT_MS || 0) || 300000

async function post(path, body, timeoutMs) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs ?? WAIT_MS)
  })
  const txt = await res.text().catch(() => '')
  try {
    return JSON.parse(txt)
  } catch {
    return null
  }
}

/**
 * 问一次「能不能用这个模型」。
 *
 * @param {{ role: string, id: string, label?: string, provider?: string }} req
 *   role     角色：vision（视觉代看）/ image / video / tts / music / asr
 *   id       目标标识，形如 `agnes/glm-5.2`（provider/model）
 *   label    给用户看的模型名（工具回执里也用它）
 *   provider 提供商展示名
 * @returns {Promise<{ allowed: boolean, scope?: string, reason?: string }>}
 */
export async function authorize(req) {
  if (OFF) return { allowed: true, scope: 'off' }
  try {
    const r = await post('/qn/authorize', req)
    // 回包结构不对（老版本端点、被中间件改写）→ 当作没这回事，放行
    if (!r || typeof r.allowed !== 'boolean') return { allowed: true, scope: 'unknown' }
    return r
  } catch {
    return { allowed: true, scope: 'unreachable' }
  }
}

/** 真正调用成功之后回报一次用量（供界面「本轮用到哪些模型」汇总）。失败不重试、不抛。 */
export async function markUsed(req) {
  try {
    await post('/qn/model-used', req, 5000)
  } catch {
    /* 少记一条用量不影响任何功能 */
  }
}

/** 被拒绝时给模型看的话：明确「不是出错、别重试、告诉用户」，避免它换个参数继续撞。 */
export function deniedText(req, r) {
  const who = req?.label || req?.id || '其他模型'
  if (r?.reason === 'timeout')
    return `用户没有在时限内回应「是否允许调用模型 ${who}」，本次调用已取消。不要再重试，也不要换个说法再试；直接告诉用户：需要他确认后才能调用其他模型。`
  return `用户**拒绝了**调用模型 ${who}（${req?.role ?? ''}）。不要再重试，也不要改用别的模型绕过去；如实告诉用户这一步需要调用其他模型、已被他拒绝，问他是否要改用别的做法。`
}
