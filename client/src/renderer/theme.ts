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
  { id: 'klein', name: '克莱因蓝', dark: false, swatches: ['#002fa7', '#0037c8', '#f5f7fd'] },
  { id: 'tiffany', name: '蒂芙尼蓝', dark: false, swatches: ['#0bbab2', '#0eaaa2', '#f2faf9'] },
  { id: 'prussian', name: '普鲁士蓝', dark: false, swatches: ['#003153', '#0a5090', '#f2f6fa'] },
  { id: 'titian', name: '提香红', dark: false, swatches: ['#b13e30', '#c94b37', '#fcf6f1'] },
  { id: 'mars', name: '马尔斯绿', dark: false, swatches: ['#3f7d5c', '#2e9e6f', '#f3f8f4'] },
  { id: 'vandyke', name: '凡戴克棕', dark: false, swatches: ['#6a442f', '#945430', '#faf5ea'] },
  { id: 'burgundy', name: '勃艮第红', dark: false, swatches: ['#6b1f22', '#8c2a2e', '#fcf6f7'] },
  { id: 'china', name: '中国红', dark: false, swatches: ['#c9101e', '#d7232c', '#fff6f5'] },
  { id: 'schonbrunn', name: '申布伦黄', dark: false, swatches: ['#e0c05f', '#c9922a', '#fdf9ee'] },
  { id: 'hermes', name: '爱马仕橙', dark: false, swatches: ['#f37021', '#e8611a', '#fff8f1'] },
  { id: 'lapis', name: '青金石', dark: false, swatches: ['#4a2f9c', '#6c3fd8', '#f5f2fc'] },
  { id: 'malachite', name: '孔雀绿', dark: false, swatches: ['#0d8a64', '#0fa37a', '#f1fbf6'] },
]
export const CUSTOM_ID = 'custom'
export const CUSTOM_THEME: ThemeMeta = {
  id: CUSTOM_ID, name: '自定义', dark: false, swatches: ['#3b6ef5', '#f5f5f5', '#ececec'],
}
/** 主题选择列表：12 个内置 + 自定义 */
export const getThemeList = (): ThemeMeta[] => [...THEMES, CUSTOM_THEME]

/* ================= 主题背景图（设置 → 主题 → 主题背景图） =================
 * 两种模式（名字 2026-09-29 定版）：
 *   full  —— 整屏一张：一张图同时铺在左侧栏与右侧内容区，界面看着是同一幅底图
 *   split —— 左右分开：左侧栏（侧栏面板）一张、右侧内容区一张，互不相关
 * 持久化只存「复制进 ~/.qingniaoai/themes/ 的文件路径」，data URL 由主进程按需读出
 * （壁纸动辄几 MB，base64 塞进 localStorage/uistore 会白白撑爆配额）。 */
export type ThemeBgMode = 'none' | 'full' | 'split'
export interface ThemeBgCfg {
  mode: ThemeBgMode
  /** 整屏一张：图在 themes 目录里的落盘路径 */
  full: string | null
  /** 左右分开：左侧栏的图 */
  left: string | null
  /** 左右分开：右侧内容区的图 */
  right: string | null
}
export const DEFAULT_THEME_BG: ThemeBgCfg = { mode: 'none', full: null, left: null, right: null }
export type ThemeBgSlot = 'full' | 'left' | 'right'
