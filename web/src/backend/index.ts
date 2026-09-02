import { MockBackend } from './mock'
import { TauriBackend } from './tauri'
import type { Backend } from './types'

export function isTauriRuntime(runtime: unknown = globalThis): boolean {
  return (typeof runtime === 'object' || typeof runtime === 'function')
    && runtime !== null
    && '__TAURI_INTERNALS__' in runtime
}

export function createBackend(isTauri = isTauriRuntime()): Backend {
  return isTauri ? new TauriBackend() : new MockBackend()
}

export const backend = createBackend()
