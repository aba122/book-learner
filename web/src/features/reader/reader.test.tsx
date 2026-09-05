import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { BackendError } from '../../backend/errors'
import * as errorModule from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import { READER_FONT_STEPS } from '../../config'
import EpubView from './EpubView'
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
    ready: Promise.resolve(),
    locations: { generate: vi.fn(() => Promise.resolve()), percentageFromCfi: vi.fn(() => 0.5) },
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

  it.each([
    ['getBlock', '知识块读取失败'],
    ['blockSource', '原文读取失败'],
    ['epubUrl', 'EPUB 地址读取失败'],
  ] as const)('%s 初始化失败会替换 loading 且保留返回讲授上下文', async (method, message) => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, method).mockRejectedValue(new BackendError({
      code: 'not_implemented',
      message,
      retryable: false,
    }))

    renderReader('/reader/4?back=3')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(screen.queryByText('正在打开书籍…')).not.toBeInTheDocument()
    expect(h.ePub).not.toHaveBeenCalled()
    expect(within(alert).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '返回讲授' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/feynman/3')
  })

  it('可重试初始化失败只重发完整内容管线', async () => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, 'blockSource').mockResolvedValue({
      href: 'chap1.xhtml',
      text: '原文',
    })
    const original = backendModule.backend.getBlock.bind(backendModule.backend)
    const getBlock = vi.spyOn(backendModule.backend, 'getBlock')
      .mockRejectedValueOnce(new BackendError({
        code: 'offline',
        message: '阅读内容暂时不可用',
        retryable: true,
      }))
      .mockImplementation(original)

    renderReader('/reader/4?task=3')
    await user.click(await screen.findByRole('button', { name: '重试' }))

    await waitFor(() => expect(h.ePub).toHaveBeenCalledWith('/fixtures/sample.epub'))
    expect(getBlock).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('价格管制与市场干预')).toBeInTheDocument()
  })

  it('卸载后晚到的初始化失败不会进入错误状态', async () => {
    let reject!: (reason?: unknown) => void
    vi.spyOn(backendModule.backend, 'getBlock').mockReturnValue(new Promise((_resolve, rej) => {
      reject = rej
    }))
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')
    const view = renderReader('/reader/4')

    view.unmount()
    await act(async () => reject(new BackendError({
      code: 'offline',
      message: '卸载后的阅读失败',
      retryable: true,
    })))

    expect(normalize).not.toHaveBeenCalled()
  })
})

describe('EpubView 回调 ref(H-T6)', () => {
  it('epub 事件触发时调用最新回调,而非首次渲染时传入的', async () => {
    const toc1 = vi.fn(); const toc2 = vi.fn()
    const prog1 = vi.fn(); const prog2 = vi.fn()
    const { rerender } = render(
      <EpubView url="/fixtures/sample.epub" fontSizePct="100%" theme="paper" onToc={toc1} onProgress={prog1} />,
    )
    rerender(
      <EpubView url="/fixtures/sample.epub" fontSizePct="100%" theme="paper" onToc={toc2} onProgress={prog2} />,
    )
    await act(async () => {})
    await act(async () => {})
    expect(toc2).toHaveBeenCalledTimes(1)
    expect(toc1).not.toHaveBeenCalled()
    const relocated = h.rendition.on.mock.calls.find(c => c[0] === 'relocated')?.[1] as
      | ((loc: { start: { cfi: string } }) => void)
      | undefined
    expect(relocated).toBeTypeOf('function')
    relocated!({ start: { cfi: 'epubcfi(/6/2!/4/2)' } })
    expect(prog2).toHaveBeenCalledWith(0.5)
    expect(prog1).not.toHaveBeenCalled()
  })
})
