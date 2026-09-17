export interface ThemeMeta {
  id: string
  name: string
  dark: boolean
  /** 色卡预览：左侧栏色 / 主色 / 右侧内容面色 */
  swatches: [string, string, string]
}

export const THEMES: ThemeMeta[] = [
  { id: 'dark', name: '深色', dark: true, swatches: ['#16181d', '#4f7cff', '#0f1115'] },
  { id: 'light', name: '简约浅', dark: false, swatches: ['#ececec', '#3b6ef5', '#ffffff'] },
  { id: 'skyblue', name: '晴空蓝', dark: false, swatches: ['#199fd6', '#0d8fd0', '#f7fafc'] },
  { id: 'cream', name: '奶油暖米', dark: false, swatches: ['#a97f52', '#d97b2f', '#faf5ea'] },
  { id: 'mint', name: '薄荷青绿', dark: false, swatches: ['#0e9f6e', '#12996b', '#f5faf6'] },
  { id: 'rose', name: '淡粉蔷薇', dark: false, swatches: ['#d34a6d', '#e05c7e', '#fdf5f7'] }
]
export const CUSTOM_ID = 'custom'
export const CUSTOM_THEME: ThemeMeta = {
  id: CUSTOM_ID, name: '自定义', dark: false, swatches: ['#4f7cff', '#16181d', '#e6e8ee'],
}
/** 主题选择列表：6 个内置 + 自定义 */
export const getThemeList = (): ThemeMeta[] => [...THEMES, CUSTOM_THEME]
