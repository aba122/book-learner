import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { backend, isTauriRuntime } from './backend'
import { installClientLogging } from './lib/clientLog'
import './index.css'

// 外壳标记:Tauri 下 html/body 透明(侧栏原生材质透出),浏览器 mock 下铺纸色(见 index.css)
document.documentElement.dataset.shell = isTauriRuntime() ? 'tauri' : 'web'

// 前端异常/未处理 Promise/console.error → app 日志(测试阶段诊断)
installClientLogging(backend)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
