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
