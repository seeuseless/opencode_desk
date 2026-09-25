/**
 * 展示层的数字格式化。
 *
 * token 量级跨好几个数量级（一次对话几千，一个月几亿），所以统一按万/亿换单位；
 * 积分是纯计数，只加千分位、不做单位换算——「1.2 万积分」不如「12,345 积分」好核对。
 */

import { getLang } from './i18n'

/** 去掉小数末尾多余的 0：1.50 → 1.5，2.00 → 2 */
function trim(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '')
}

/** token 数自动换单位：满万用「万」，满亿用「亿」，否则原样；英文走 K/M/B 缩写 */
export function fmtTokens(n?: number | null): string {
  const v = Number(n || 0)
  if (getLang() === 'en') {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
  }
  if (v >= 100_000_000) return `${trim(v / 100_000_000)} ${getLang() === 'tw' ? '億' : '亿'}`
  if (v >= 10_000) return `${trim(v / 10_000)} ${getLang() === 'tw' ? '萬' : '万'}`
  return String(v)
}

/** 带千分位的整数（积分、调用次数等） */
export function fmtNumber(n?: number | null): string {
  return Number(n || 0).toLocaleString('zh-CN')
}

/** 本地时区的 YYYY-MM-DD（日期筛选框的 value 格式） */
export function ymd(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** n 天前的 YYYY-MM-DD */
export function daysAgoYmd(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return ymd(d)
}
