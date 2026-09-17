/** 自定义主题色：用户给定 4 个基础色，自动派生整套 CSS 变量 */
export interface CustomColors {
  /** 主色（按钮/链接/高亮/描边） */
  accent: string
  /** 窗体背景色 */
  bg: string
  /** 正文文字色 */
  fg: string
  /** 左侧面板/标题栏底色 */
  sideBg: string
}

export const DEFAULT_CUSTOM: CustomColors = {
  accent: '#3b6ef5',
  bg: '#ececec',
  fg: '#1f232b',
  sideBg: '#f5f5f5',
}

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const rgbToHex = (c: number[]): string =>
  '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('')

/** WCAG 相对亮度 0-1 */
const luminance = (c: [number, number, number]): number => {
  const [r, g, b] = c.map((n) => {
    const s = n / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 线性混合两个 hex，t∈0-1 为朝向 b 的比例（等价 CSS color-mix） */
const mix = (a: string, b: string, t: number): string => {
  const A = hexToRgb(a),
    B = hexToRgb(b)
  return rgbToHex(A.map((v, i) => Math.round(v + (B[i] - v) * t)))
}

/** 固定色相的感知一致状态色：hue 固定，饱和度/亮度随明暗主题协调 */
const statusHex = (h: number, s: number, l: number): string => {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r: number, g: number, b: number
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255])
}

/** hex + 半透明 → rgba() 字符串 */
const rgba = (c: string, a: number): string => {
  const [r, g, b] = hexToRgb(c)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** 依据 4 个基础色派生整套主题变量（CSS 变量名 → 值） */
export function deriveVars(c: CustomColors): Record<string, string> {
  const dark = luminance(hexToRgb(c.bg)) < 0.35
  const content = dark ? c.bg : mix(c.bg, '#ffffff', 0.6)
  const bg2 = dark ? mix(c.bg, '#ffffff', 0.035) : mix(c.bg, '#ffffff', 0.05)
  const bg3 = dark ? mix(c.bg, '#ffffff', 0.08) : mix(c.bg, '#000000', 0.03)
  const line = dark ? mix(c.bg, '#ffffff', 0.13) : mix(c.bg, '#000000', 0.09)
  const fg2 = mix(c.fg, c.bg, 0.42)
  const fieldBg = dark ? bg2 : content
  const fieldLine = mix(c.accent, line, 0.3)

  const sideLight = luminance(hexToRgb(c.sideBg)) >= 0.45
  const sideFg = sideLight ? '#1f232b' : '#ffffff'

  const user = mix(c.accent, content, 0.32)
  const onUser = luminance(hexToRgb(user)) >= 0.5 ? '#1c2129' : '#ffffff'

  return {
    '--bg': c.bg, '--bg2': bg2, '--bg3': bg3, '--line': line,
    '--fg': c.fg, '--fg2': fg2,
    '--accent': c.accent,
    '--on-accent': luminance(hexToRgb(c.accent)) >= 0.5 ? '#1c2129' : '#ffffff',
    '--ok': statusHex(148, dark ? 50 : 45, dark ? 58 : 40),
    '--err': statusHex(356, dark ? 60 : 55, dark ? 62 : 48),
    '--run': dark ? mix(c.accent, '#ffffff', 0.25) : mix(c.accent, '#ffffff', 0.08),
    '--shadow': dark ? 'rgba(0,0,0,0.5)' : 'rgba(30,40,70,0.12)',
    '--field-bg': fieldBg, '--field-line': fieldLine,
    '--content': content,
    '--user': user, '--on-user': onUser,
    '--step-path': mix(c.accent, fg2, 0.52),
    '--side-bg': c.sideBg,
    '--side-fg': sideFg,
    '--side-fg2': mix(sideFg, c.sideBg, 0.4),
    '--side-hover': sideLight ? 'rgba(0,0,0,0.06)' : rgba('#ffffff', 0.14),
    '--side-solid': sideLight ? mix(c.sideBg, '#ffffff', 0.25) : mix(c.sideBg, '#000000', 0.14),
    '--side-line': sideLight ? 'rgba(0,0,0,0.12)' : rgba('#ffffff', 0.2),
    '--side-logo': sideLight ? c.accent : sideFg,
    // 右侧 AI 回复里「点击展开」的详情/代码块背景：
    // 深色主题用主题浮面色 bg3（深底配浅字，对比足够）；浅色主题用左侧菜单底色往白里提一档（通透，配深字）
    '--expand-bg': dark ? bg3 : mix(c.sideBg, '#ffffff', 0.5),
  }
}

/** 全部派生变量名：离开自定义主题时清理这些内联覆盖 */
export const DERIVED_KEYS = [
  '--bg', '--bg2', '--bg3', '--line', '--fg', '--fg2', '--accent', '--on-accent',
  '--ok', '--err', '--run', '--shadow', '--field-bg', '--field-line', '--content',
  '--user', '--on-user', '--step-path',   '--side-bg', '--side-fg', '--side-fg2',
  '--side-hover', '--side-solid', '--side-line', '--side-logo', '--expand-bg',
] as const