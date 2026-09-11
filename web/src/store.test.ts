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
