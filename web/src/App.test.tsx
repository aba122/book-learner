import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from './App'

describe('App 外壳', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/')
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
})
