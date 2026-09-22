import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from './backend'
import { BackendError } from './backend/errors'
import App from './App'
import { useSession } from './store'

describe('App 外壳', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/')
    useSession.getState().setActiveBookId(null)
  })

  it('侧栏渲染五项导航', async () => {
    render(<App />)
    for (const label of ['今日学习', '书架', '知识地图', '统计', '设置']) {
      expect(await screen.findByRole('link', { name: label })).toBeInTheDocument()
    }
  })

  it('点击"书架"进入书架页', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('link', { name: '书架' }))
    expect(await screen.findByRole('heading', { level: 1, name: '书架' })).toBeInTheDocument()
  })

  it('主攻书启动探测失败时侧栏仍可用且拒绝被消费', async () => {
    const listBooks = vi.spyOn(backend, 'listBooks').mockRejectedValue(new BackendError({
      code: 'offline',
      message: '启动探测失败',
      retryable: true,
    }))

    render(<App />)

    expect(await screen.findByRole('link', { name: '知识地图' })).toHaveAttribute('href', '/library')
    await waitFor(() => expect(listBooks).toHaveBeenCalled())
  })
})

describe('App 外壳 · 视觉改版第一批', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/')
    localStorage.clear()
    if (useSession.getState().sidebarCollapsed) useSession.getState().toggleSidebar()
  })

  it('当前页导航项带 aria-current;侧栏底部日读/夜读快捷钮切换 data-theme(用户要求,2026-09-21)', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByRole('link', { name: '今日学习' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: '书架' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '切换为夜读' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(useSession.getState().themePreference).toBe('dark')
    await user.click(screen.getByRole('button', { name: '切换为日读' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('⌥⌘D(mock 菜单映射「显示 › 外观」)切换深浅色', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('link', { name: '书架' })
    await user.keyboard('{Meta>}{Alt>}d{/Alt}{/Meta}')
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'))
    await user.keyboard('{Meta>}{Alt>}d{/Alt}{/Meta}')
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'))
  })

  it('⌃⌘S(mock 菜单映射)折叠侧栏,主区出现「显示侧栏」;再按恢复', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('link', { name: '书架' })
    await user.keyboard('{Control>}{Meta>}s{/Meta}{/Control}')
    await waitFor(() => expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: '显示侧栏' }))
    expect(await screen.findByRole('navigation', { name: '主导航' })).toBeInTheDocument()
  })

  it('⌘,(mock 菜单映射)进设置页', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('link', { name: '设置' })
    await user.keyboard('{Meta>},{/Meta}')
    expect(await screen.findByRole('heading', { level: 1, name: '设置' })).toBeInTheDocument()
  })
})
