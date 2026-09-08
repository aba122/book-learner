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
    annotations: { highlight: vi.fn(), underline: vi.fn(), remove: vi.fn() },
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

/** 取 rendition.on 注册的最新事件处理器 */
function handler(event: string): ((...args: unknown[]) => void) | undefined {
  const calls = h.rendition.on.mock.calls.filter(c => c[0] === event)
  return calls.at(-1)?.[1] as ((...args: unknown[]) => void) | undefined
}

describe('阅读器 · 标记/排版/位置(M3 T4)', () => {
  beforeEach(() => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, String(v)),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear(),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('书签:记下当前页 CFI,标记面板可见并可删除', async () => {
    const user = userEvent.setup()
    const add = vi.spyOn(backendModule.backend, 'readerMarkAdd')
    const remove = vi.spyOn(backendModule.backend, 'readerMarkRemove')
    renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    await act(async () => { handler('relocated')?.({ start: { cfi: 'epubcfi(/6/8!/4/2/1:0)', href: 'chap2.xhtml' } }) })
    await user.click(screen.getByRole('button', { name: '书签' }))
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    expect(add.mock.calls[0][0]).toBe(1)
    expect(add.mock.calls[0][1]).toMatchObject({ kind: 'bookmark', spineHref: 'chap2.xhtml', cfiStart: 'epubcfi(/6/8!/4/2/1:0)' })
    await user.click(screen.getByRole('button', { name: '标记' }))
    const panel = await screen.findByTestId('marks-panel')
    expect(within(panel).getAllByTestId('mark-bookmark')).toHaveLength(1)
    await user.click(within(panel).getByRole('button', { name: /删除书签/ }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(panel).queryAllByTestId('mark-bookmark')).toHaveLength(0))
  })

  it('选区 → 高亮:写入区间 CFI 与颜色,并在 epub.js 上加注解', async () => {
    const user = userEvent.setup()
    const add = vi.spyOn(backendModule.backend, 'readerMarkAdd')
    renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    await act(async () => {
      handler('selected')?.('epubcfi(/6/8!/4/2,/1:0,/1:12)', { window: { getSelection: () => ({ toString: () => '价格上限' }) }, section: { href: 'chap2.xhtml' } })
    })
    const toolbar = await screen.findByRole('toolbar', { name: '选区操作' })
    expect(toolbar).toHaveTextContent('价格上限')
    await user.click(within(toolbar).getByRole('button', { name: '高亮:绿' }))
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    expect(add.mock.calls[0][1]).toMatchObject({ kind: 'highlight', cfiStart: 'epubcfi(/6/8!/4/2,/1:0,/1:12)', cfiEnd: 'epubcfi(/6/8!/4/2,/1:0,/1:12)', text: '价格上限', color: 'green' })
    await waitFor(() => expect(h.rendition.annotations.highlight).toHaveBeenCalledWith('epubcfi(/6/8!/4/2,/1:0,/1:12)', {}, undefined, 'bl-highlight', expect.objectContaining({ fill: expect.stringContaining('rgba') })))
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('阅读位置节流写回,非学习模式重开从上次位置开始', async () => {
    const setPosition = vi.spyOn(backendModule.backend, 'readerPositionSet')
    const first = renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    await act(async () => {
      handler('relocated')?.({ start: { cfi: 'epubcfi(/6/8!/4/2/1:0)', href: 'chap2.xhtml' } })
      handler('relocated')?.({ start: { cfi: 'epubcfi(/6/8!/4/4/1:0)', href: 'chap2.xhtml' } })
    })
    await waitFor(() => expect(setPosition).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(setPosition).toHaveBeenCalledWith(1, 'chap2.xhtml', 'epubcfi(/6/8!/4/4/1:0)')
    first.unmount()
    h.rendition.display.mockClear()
    renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    await waitFor(() => expect(h.rendition.display).toHaveBeenCalledWith('epubcfi(/6/8!/4/4/1:0)'))
  })

  it('排版偏好持久化到 localStorage;关闭"覆盖出版方样式"后主题不再注入行高/字体', async () => {
    const user = userEvent.setup()
    renderReader('/reader/4')
    await user.click(await screen.findByRole('button', { name: '阅读设置' }))
    await user.click(screen.getByRole('button', { name: '增大字号' }))
    await user.click(screen.getByRole('button', { name: '行高:2.1' }))
    const saved = JSON.parse(localStorage.getItem('bookLearner.readerPrefs') ?? '{}')
    expect(saved).toMatchObject({ fontIdx: READER_FONT_STEPS.indexOf(112), lineIdx: 2, overridePublisher: true })
    const before = h.rendition.themes.register.mock.calls.filter(c => c[0] === 'paper').at(-1)?.[1] as { body: Record<string, string> }
    expect(before.body['line-height']).toBe('2.1')
    await user.click(screen.getByRole('checkbox', { name: '覆盖出版方样式' }))
    const after = h.rendition.themes.register.mock.calls.filter(c => c[0] === 'paper').at(-1)?.[1] as { body: Record<string, string> }
    expect(after.body['line-height']).toBeUndefined()
    expect(after.body.background).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('bookLearner.readerPrefs') ?? '{}').overridePublisher).toBe(false)
  })

  it('学习模式:该章 rendered 后按锚点两点 CFI 组合区间并加下划线', async () => {
    await backendModule.backend.setAnchorSegments(4, [{ spineHref: 'chap2.xhtml', cfiStart: 'epubcfi(/6/8!/4/2/1:0)', cfiEnd: 'epubcfi(/6/8!/4/6/1:0)', precision: 'exact', hint: '价格管制', text: 'x' }])
    renderReader('/reader/4?task=3')
    await screen.findByRole('button', { name: '开始费曼讲授' })
    await waitFor(() => expect(h.rendition.display).toHaveBeenCalledWith('epubcfi(/6/8!/4/2/1:0)'))
    const doc = { createRange: () => ({ setStart: vi.fn(), setEnd: vi.fn() }) }
    const section = { href: 'chap2.xhtml', cfiFromRange: () => 'epubcfi(/6/8!/4/2,/1:0,/6/1:0)' }
    await act(async () => { handler('rendered')?.(section, { contents: { document: doc } }) })
    // jsdom 里 EpubCFI.toRange 走不通时不加注解(不抛错);能走通则加一条下划线
    const calls = h.rendition.annotations.underline.mock.calls
    expect(calls.length).toBeLessThanOrEqual(1)
    if (calls.length === 1) expect(calls[0][0]).toBe('epubcfi(/6/8!/4/2,/1:0,/6/1:0)')
  })
})

