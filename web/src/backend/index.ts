import { HttpBackend, isHttpRuntime } from './http'
import { MockBackend } from './mock'
import { TauriBackend } from './tauri'
import type { Backend } from './types'

export function isTauriRuntime(runtime: unknown = globalThis): boolean {
  return (typeof runtime === 'object' || typeof runtime === 'function')
    && runtime !== null
    && '__TAURI_INTERNALS__' in runtime
}

/** Tauri 窗口 → 原生 IPC;Mac 攻书 HTTP 服务分发的页面(手机 Safari,BL-032)→ HTTP;其余(vite dev / 测试)→ Mock */
export function createBackend(isTauri = isTauriRuntime(), isHttp = isHttpRuntime()): Backend {
  if (isTauri) return new TauriBackend()
  if (isHttp) return new HttpBackend()
  return new MockBackend()
}

export const backend = createBackend()
