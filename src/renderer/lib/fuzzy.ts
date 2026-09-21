/**
 * 模糊匹配（子序列 + 打分 + 命中区间回传）。
 *
 * 用在「选择文件夹」下拉里搜项目名：用户敲 `bbc` 要能搜到 `new_bbc.local`，
 * 敲 `oss` 要能搜到 `opencode_desk`。只要查询串的字符**按顺序**出现在目标里就算命中，
 * 不必连续——这是大家对这个输入框的默认预期。
 *
 * 打分不追求学术级精确，只要能把「明显更该排前面」的顶上去：
 * - 连续命中加分（`bbc` 匹配 `bbc.local` 应高于匹配 `b_b_c`）
 * - 词首/分隔符后命中加分（`nbl` 打 `new_bbc.local` 时 n、b、l 都在词首）
 * - 起始位置越靠前越好
 * - 命中跨度越小越好（避免 `a` 打 `a....a` 这种散得过分的排太前）
 *
 * 返回 `ranges` 是为了让 UI 把命中字符高亮出来。用户敲进去的字符到底落在哪，
 * 不标出来就只能靠猜——尤其是模糊匹配这种「我自己都不知道为什么会搜出这个」的场景。
 */

/** 目标里命中查询串的连续区间（`[起, 止)`，按字符下标） */
export type MatchRange = [number, number]

export interface FuzzyMatch {
  /** 分数，越大越匹配；仅用于排序，无绝对含义 */
  score: number
  /** 命中字符在目标串里的下标区间，供高亮使用 */
  ranges: MatchRange[]
}

/** 词边界字符：其后一位视为「词首」，命中时加分 */
const SEPARATORS = new Set([' ', '_', '-', '.', '/', '\\', '(', ')', '[', ']'])

function isBoundary(target: string, index: number): boolean {
  if (index === 0) return true
  return SEPARATORS.has(target[index - 1]!)
}

/** 该位置是否算「词首」：起始位、分隔符之后、或小写转大写处（camelCase） */
function isWordStart(target: string, index: number): boolean {
  if (isBoundary(target, index)) return true
  const prev = target[index - 1]!
  const cur = target[index]!
  return prev === prev.toLowerCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase()
}

/**
 * 在 `target` 中查找 `query` 的模糊命中。
 *
 * 找不到返回 `null`。空查询返回 `{ score: 0, ranges: [] }`（调用方自己决定要不要展示全部）。
 *
 * 采用贪心策略：先对每个查询字符取「最左可用命中」，得到一条基准路径；
 * 若首个命中落在词首，再尝试从该词首重跑一次——这样 `nbl` 打 `new_bbc.local` 时
 * 不会因为 `n` 先咬到前面的某个 n 而错过整串的词首组合。
 */
export function fuzzyMatch(target: string, query: string): FuzzyMatch | null {
  if (!query) return { score: 0, ranges: [] }

  const t = target
  const q = query
  const lowerT = t.toLowerCase()
  const lowerQ = q.toLowerCase()

  /** 按「每个查询字符尽量靠左命中」走一遍，返回命中下标；任一字符找不到则 null */
  function walk(from: number): number[] | null {
    const idx: number[] = []
    let cursor = from
    for (let i = 0; i < lowerQ.length; i++) {
      const found = lowerT.indexOf(lowerQ[i]!, cursor)
      if (found === -1) return null
      idx.push(found)
      cursor = found + 1
    }
    return idx
  }

  let positions = walk(0)
  if (!positions) return null

  // 基准路径的第一个字符若不在词首，试着从「下一个能当词首的相同字符」重跑，
  // 拿到一条更漂亮的路径（更少碎片、更多词首命中）。只在确实更优时才替换。
  if (!isWordStart(t, positions[0]!) && positions.length > 1) {
    const firstChar = lowerQ[0]!
    for (let s = 1; s < lowerT.length; s++) {
      if (lowerT[s] !== firstChar || !isWordStart(t, s)) continue
      const alt = walk(s)
      if (alt && alt.length === positions.length) {
        positions = alt
      }
      break
    }
  }

  // ---- 打分 ----
  let score = 0
  const ranges: MatchRange[] = []

  let runStart = positions[0]!
  let runEnd = positions[0]! + 1
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!
    if (i > 0) {
      const prev = positions[i - 1]!
      if (p === prev + 1) {
        // 与上一个命中紧邻：延续当前连续段
        runEnd = p + 1
        score += 8 // 连续命中：最强信号
      } else {
        // 断开了，收束上一段
        ranges.push([runStart, runEnd])
        runStart = p
        runEnd = p + 1
        score -= 1 // 每断一次扣一点，鼓励紧凑
      }
    }
    if (isWordStart(t, p)) score += 12 // 词首命中：`nbl` → new_bbc.local
    if (p === 0) score += 6 // 落在开头额外奖励
    score += Math.max(0, 4 - p * 0.05) // 位置越靠前越好
  }
  ranges.push([runStart, runEnd])

  // 跨度惩罚：命中散得越开越不像用户想要的
  const span = positions[positions.length - 1]! - positions[0]!
  score -= Math.max(0, span - q.length) * 0.5

  // 完整子串命中（还连续）直接大幅加成：`bbc` vs `new_bbc.local` 里的 bbc 段
  if (ranges.length === 1 && lowerT.includes(lowerQ)) score += 20

  // 目标越短，同样的命中越「精确」，略微加权
  score -= t.length * 0.02

  return { score, ranges }
}

/** 按 fuzzyMatch 的分数对字符串数组排序（不匹配的项自动落到末尾） */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query) return items
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const m = fuzzyMatch(key(item), query)
    if (m) scored.push({ item, score: m.score })
  }
  // 同分时保持原有顺序（排序稳定，避免相同分数下顺序乱跳）
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.item)
}

/**
 * 把字符串按命中区间切成段，供高亮渲染。
 * 返回 `{ text, hit }` 列表——`hit: true` 的段就是用户敲中的字符。
 */
export function splitByRanges(text: string, ranges: MatchRange[]): { text: string; hit: boolean }[] {
  if (!ranges.length) return [{ text, hit: false }]
  const out: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false })
    out.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out
}
