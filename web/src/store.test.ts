import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_KEY } from './config'

describe('会话 store:夜读模式持久化(BL-003)', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })
  afterEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('setTheme 写 localStorage 并打 data-theme;重新加载模块(刷新/重开)沿用上次的模式', async () => {
    const { useSession } = await import('./store')
    expect(useSession.getState().theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    useSession.getState().setTheme('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    vi.resetModules()
    document.documentElement.removeAttribute('data-theme')
    const again = await import('./store')
    expect(again.useSession.getState().theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('非法或缺失的持久化值回落到 light', async () => {
    localStorage.setItem(THEME_KEY, 'blue')
    const { useSession } = await import('./store')
    expect(useSession.getState().theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('外观跟随系统(视觉改版第一批)', () => {
  type Listener = (e: { matches: boolean }) => void
  function stubMatchMedia(dark: boolean) {
    const listeners: Listener[] = []
    const mql = {
      matches: dark,
      addEventListener: (_: string, fn: Listener) => listeners.push(fn),
      removeEventListener: () => {},
    }
    vi.stubGlobal('matchMedia', vi.fn(() => mql))
    return {
      flip(next: boolean) {
        mql.matches = next
        listeners.forEach(fn => fn({ matches: next }))
      },
    }
  }
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('无持久化值 = 跟随系统:系统深色 → 解析为 dark', async () => {
    stubMatchMedia(true)
    const { useSession } = await import('./store')
    expect(useSession.getState().themePreference).toBe('system')
    expect(useSession.getState().theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('跟随系统时系统外观切换即刻生效', async () => {
    const media = stubMatchMedia(false)
    const { useSession } = await import('./store')
    expect(useSession.getState().theme).toBe('light')
    media.flip(true)
    expect(useSession.getState().theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('手动选浅色时无视系统深色;切回跟随系统会删掉持久化键', async () => {
    const media = stubMatchMedia(true)
    const { useSession } = await import('./store')
    useSession.getState().setTheme('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(useSession.getState().theme).toBe('light')
    media.flip(false)
    media.flip(true)
    expect(useSession.getState().theme).toBe('light')
    useSession.getState().setTheme('system')
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(useSession.getState().theme).toBe('dark')
  })

  it('侧栏折叠状态持久化', async () => {
    const { useSession } = await import('./store')
    expect(useSession.getState().sidebarCollapsed).toBe(false)
    useSession.getState().toggleSidebar()
    expect(useSession.getState().sidebarCollapsed).toBe(true)
    vi.resetModules()
    const again = await import('./store')
    expect(again.useSession.getState().sidebarCollapsed).toBe(true)
  })
})
