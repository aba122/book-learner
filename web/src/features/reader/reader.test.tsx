import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import { READER_FONT_STEPS } from '../../config'
import ReaderPage from './ReaderPage'

const h = vi.hoisted(() => {
  const rendition = {
    display: vi.fn(() => Promise.resolve()),
    next: vi.fn(() => Promise.resolve()),
    prev: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    themes: { register: vi.fn(), select: vi.fn(), fontSize: vi.fn() },
  }
  const book = {
    renderTo: vi.fn(() => rendition),
    loaded: {
      navigation: Promise.resolve({
        toc: [
          { id: '1', href: 'chap1.xhtml', label: '第一章 供给与需求', subitems: [] },
          { id: '2', href: 'chap2.xhtml', label: '第二章 消费者选择', subitems: [] },
          { id: '3', href: 'chap3.xhtml', label: '第三章 生产与成本', subitems: [] },
        ],
      }),
    },
    destroy: vi.fn(),
  }
  const ePub = vi.fn(() => book)
  return { rendition, book, ePub }
})

vi.mock('epubjs', () => ({ default: h.ePub }))
vi.mock('../../backend', () => ({ backend: null as unknown as object }))

beforeEach(() => {
  vi.clearAllMocks()
  ;(backendModule as unknown as { backend: Backend }).backend = new MockBackend()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function Probe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname + loc.search}</div>
}

function renderReader(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/reader/:blockId" element={<ReaderPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  )
}

describe('阅读器', () => {
  it('用 epubUrl 初始化 epub.js 并渲染', async () => {
    renderReader('/reader/4')
    await waitFor(() => expect(h.ePub).toHaveBeenCalled())
    expect(h.ePub.mock.calls[0][0]).toBe('/fixtures/sample.epub')
    await waitFor(() => expect(h.book.renderTo).toHaveBeenCalled())
  })

  it('字号 +/- 调用 themes.fontSize', async () => {
    const user = userEvent.setup()
    renderReader('/reader/4')
    await waitFor(() => expect(h.book.renderTo).toHaveBeenCalled())
    await user.click(await screen.findByRole('button', { name: '阅读设置' }))
    await user.click(screen.getByRole('button', { name: '增大字号' }))
    expect(h.rendition.themes.fontSize).toHaveBeenCalledWith(`${READER_FONT_STEPS[2]}%`)
    await user.click(screen.getByRole('button', { name: '减小字号' }))
    await user.click(screen.getByRole('button', { name: '减小字号' }))
    expect(h.rendition.themes.fontSize).toHaveBeenCalledWith(`${READER_FONT_STEPS[0]}%`)
  })

  it('切换阅读主题调用 themes.select', async () => {
    const user = userEvent.setup()
    renderReader('/reader/4')
    await waitFor(() => expect(h.book.renderTo).toHaveBeenCalled())
    await user.click(await screen.findByRole('button', { name: '阅读设置' }))
    await user.click(screen.getByRole('button', { name: '主题:夜读' }))
    expect(h.rendition.themes.select).toHaveBeenCalledWith('night')
  })

  it('带 ?task= 进入学习模式:块信息栏 + 开始费曼讲授', async () => {
    const user = userEvent.setup()
    renderReader('/reader/4?task=3')
    expect(await screen.findByText('价格管制与市场干预')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: '开始费曼讲授' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/feynman/3')
  })
})
