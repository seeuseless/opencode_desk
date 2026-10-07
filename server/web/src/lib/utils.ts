import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}

/** 后端时间（UTC ISO）→ 本地时区 Y-m-d H:i:s；short=true 时为 MM-DD HH:mm:ss */
export function fmtTime(v?: string | null, short = false): string {
    if (!v) return ""
    const d = new Date(v)
    const p = (n: number) => String(n).padStart(2, "0")
    const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    return short ? s.slice(5) : s
}

/** 去掉小数末尾多余的 0：1.50 → 1.5，2.00 → 2 */
function trim(n: number): string {
    return n.toFixed(2).replace(/\.?0+$/, "")
}

/**
 * token 数自动换单位：满万用「万」，满亿用「亿」，否则原样。
 * 全站展示 token 只走这一个函数，口径才不会到处打架。
 */
export function fmtTokens(n?: number | null): string {
    const v = Number(n || 0)
    if (v >= 100_000_000) return `${trim(v / 100_000_000)} 亿`
    if (v >= 10_000) return `${trim(v / 10_000)} 万`
    return String(v)
}

/** 带千分位的整数（积分等纯计数用，不做单位换算） */
export function fmtNumber(n?: number | null): string {
    return Number(n || 0).toLocaleString("zh-CN")
}

/** 今天的 YYYY-MM-DD（本地时区），日期筛选默认值用 */
export function today(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** n 天前的 YYYY-MM-DD */
export function daysAgo(n: number): string {
    const d = new Date()
    d.setDate(d.getDate() - n)
    const p = (x: number) => String(x).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
