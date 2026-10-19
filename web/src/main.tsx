import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MobileGate from './features/mobile/MobileGate'
import { backend, isTauriRuntime } from './backend'
import { installClientLogging } from './lib/clientLog'
import './index.css'

// 外壳标记:Tauri 下 html/body 透明(侧栏原生材质透出),浏览器 mock 下铺纸色(见 index.css)
document.documentElement.dataset.shell = isTauriRuntime() ? 'tauri' : 'web'

// 前端异常/未处理 Promise/console.error → app 日志(测试阶段诊断)
installClientLogging(backend)

// 手机(经 Mac 攻书的 HTTP 服务打开,BL-032):先过配对门,配好才挂 app
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {backend.runtime === 'http' ? (
      <MobileGate>
        <App />
      </MobileGate>
    ) : (
      <App />
    )}
  </StrictMode>,
)
