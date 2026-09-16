import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 不套 StrictMode：dev 下 effect 双调用会把展开状态冲掉（要点两次才展开）
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
