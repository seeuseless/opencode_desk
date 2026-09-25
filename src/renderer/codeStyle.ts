export type CodeStyle = 'github' | 'vscode' | 'one' | 'tokyo-night' | 'a11y'

export const CODE_STYLES: { id: CodeStyle; name: string; desc: string }[] = [
  { id: 'github', name: 'GitHub', desc: '通用清晰' },
  { id: 'vscode', name: 'VS Code', desc: '编辑器原生' },
  { id: 'one', name: 'One', desc: '克制蓝紫' },
  { id: 'tokyo-night', name: 'Tokyo Night', desc: '蓝紫夜间' },
  { id: 'a11y', name: 'A11y', desc: '高对比阅读' }
]

export const CODE_STYLE_PREVIEWS: Record<CodeStyle, { bg: string; fg: string; keyword: string; string: string }> = {
  github: { bg: '#f6f8fa', fg: '#24292f', keyword: '#cf222e', string: '#0a3069' },
  vscode: { bg: '#1e1e1e', fg: '#d4d4d4', keyword: '#569cd6', string: '#ce9178' },
  one: { bg: '#f7f7f8', fg: '#383a42', keyword: '#6554c0', string: '#50a14f' },
  'tokyo-night': { bg: '#1a1b26', fg: '#c0caf5', keyword: '#bb9af7', string: '#9ece6a' },
  a11y: { bg: '#101214', fg: '#ffffff', keyword: '#7dd3fc', string: '#fbbf24' }
}
