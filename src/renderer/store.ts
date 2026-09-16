/** 渲染层本地持久化（localStorage，Electron userData 下自动落盘） */

export function load<T>(key: string, fallback: T): T {
  try {
    let raw = localStorage.getItem(key)
    // 一次性迁移：旧版存档前缀是 justdo.，改名后首次读时搬过来
    if (raw == null && key.startsWith('qingniao.')) {
      const legacy = localStorage.getItem('justdo.' + key.slice('qingniao.'.length))
      if (legacy != null) {
        localStorage.setItem(key, legacy)
        raw = legacy
      }
    }
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}
