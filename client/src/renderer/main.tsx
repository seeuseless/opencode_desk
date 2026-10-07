import { Component, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { hydrateUiStore } from './store'
import './index.css'

/** 渲染兜底：任何组件渲染抛异常时显示错误卡与「重新加载」，而不是整窗灰死（无边界时 React 会卸载整棵树） */
class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) {
    return { err }
  }
  render() {
    if (this.state.err) {
      return (
        <div
          style={{
            height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 14, color: '#c2404f', fontSize: 14, padding: 24, textAlign: 'center', background: '#fafafa'
          }}
        >
          <div>界面渲染出错：{String(this.state.err.message ?? this.state.err)}</div>
          <button
            onClick={() => location.reload()}
            style={{ padding: '6px 18px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// 不套 StrictMode：dev 下 effect 双调用会把展开状态冲掉（要点两次才展开）
// 渲染前先把主进程那份 UI 存档灌进 localStorage 缓存（项目清单 / 排序 / 展开态…），
// 否则首帧读到的是空列表再补上，会闪一下
void hydrateUiStore().finally(() =>
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <Boundary>
      <App />
    </Boundary>
  )
)
