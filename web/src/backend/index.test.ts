import { describe, expect, it, vi } from 'vitest'
import { MockBackend } from './mock'
import { TauriBackend } from './tauri'
import { backend, createBackend, isTauriRuntime } from './index'

describe('backend runtime selection', () => {
  it('detects Tauri from a supplied runtime object without mutating window', () => {
    expect(isTauriRuntime({})).toBe(false)
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true)
    expect(isTauriRuntime(null)).toBe(false)
  })

  it('uses MockBackend in a browser runtime', () => {
    expect(createBackend(false)).toBeInstanceOf(MockBackend)
    expect(backend).toBeInstanceOf(MockBackend)
  })

  it('uses TauriBackend natively without warning or mock fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const selected = createBackend(true)

    expect(selected).toBeInstanceOf(TauriBackend)
    expect(selected).not.toBeInstanceOf(MockBackend)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
