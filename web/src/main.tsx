import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { backend } from './backend'
import { installClientLogging } from './lib/clientLog'
import './index.css'

// 前端异常/未处理 Promise/console.error → app 日志(测试阶段诊断)
installClientLogging(backend)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
