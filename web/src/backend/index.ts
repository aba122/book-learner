import { MockBackend } from './mock'
import type { Backend } from './types'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
if (isTauri) {
  // TODO(Mac 阶段):在此接入 backend/tauri.ts 的 TauriBackend(经 Tauri IPC 调 core),
  // 现阶段即使处于 Tauri 环境也回退 MockBackend。
  console.warn('检测到 Tauri 环境,但 TauriBackend 尚未实现,使用 MockBackend')
}

export const backend: Backend = new MockBackend()
