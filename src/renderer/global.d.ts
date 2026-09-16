import type { QingniaoBridge } from '../../electron/preload'

declare global {
  interface Window {
    qingniao: QingniaoBridge
  }
}

export {}
