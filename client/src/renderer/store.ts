/**
 * 渲染层本地持久化。
 *
 * 读是**同步**的（界面里到处 load），但事实源在主进程的 ~/.qingniaoai/ui-store.json：
 * 早先只存在 localStorage，而 localStorage **按 origin 隔离**——`npm run dev` 走
 * http://localhost:5173，打包安装后走 file://，两边各存一份互不可见，于是「开发时加的
 * 项目，装完就没了」。现在：
 *   1. hydrateUiStore() 启动时从主进程把全量数据灌进 localStorage（首屏等它一次，之后读都是同步的）；
 *   2. save() 仍然写 localStorage 当缓存，同时把这一键同步给主进程文件。
 * 冲突时以主进程文件为准（那是跨 dev/安装版共用的那一份）。
 */

/** 键名归一：统一 qingniao. 前缀，老存档的 justdo. 前缀读时顺手搬过来 */
function readKey(key: string): string | null {
  let raw = localStorage.getItem(key)
  // 一次性迁移：旧版存档前缀是 justdo.，改名后首次读时搬过来
  if (raw == null && key.startsWith('qingniao.')) {
    const legacy = localStorage.getItem('justdo.' + key.slice('qingniao.'.length))
    if (legacy != null) {
      localStorage.setItem(key, legacy)
      raw = legacy
    }
  }
  return raw
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = readKey(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存储写满等极端情况不阻断界面 */
  }
  // 同步给主进程存档（不 await：写缓存是即时可用的，落盘慢一点无妨）
  void window.qingniao?.uiStore.set(key, value).catch(() => {})
}

/**
 * 启动时把主进程那份存档灌进 localStorage 缓存。
 *
 * 合并规则：**主进程已有的键覆盖 localStorage；只存在于 localStorage 的键（首次升级时用户
 * 攒下的项目清单等）上传到主进程**。这样升级后不会丢数据，而两边已有的同一个键以主进程为准。
 */
export async function hydrateUiStore(): Promise<void> {
  let all: Record<string, unknown>
  try {
    all = (await window.qingniao.uiStore.get()) ?? {}
  } catch {
    return // 主进程不可用（极少见）：沿用 localStorage 缓存
  }
  const orphan: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(all)) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* 单个键写失败不阻断 */
    }
  }
  // localStorage 里有、但主进程还没这份数据的键：升级迁移时一并上传
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('qingniao.') || key in all) continue
    try {
      orphan[key] = JSON.parse(localStorage.getItem(key) as string)
    } catch {
      /* 坏值不上传 */
    }
  }
  for (const [key, value] of Object.entries(orphan)) {
    await window.qingniao.uiStore.set(key, value).catch(() => {})
  }
}
