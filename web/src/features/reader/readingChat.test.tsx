import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import type { ReadingSendResult } from '../../types'
import ReaderPage from './ReaderPage'

/** 与 reader.test 同一套 epub.js 桩:只要能挂起阅读器、拿到 rendered/selected 回调即可 */
const h = vi.hoisted(() => {
  const rendition = {
    display: vi.fn(() => Promise.resolve()),
    next: vi.fn(() => Promise.resolve()),
    prev: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    themes: { register: vi.fn(), select: vi.fn(), fontSize: vi.fn() },
    annotations: { highlight: vi.fn(), underline: vi.fn(), remove: vi.fn() },
    getContents: vi.fn((): unknown[] => []),
    spread: vi.fn(),
  }
  const book = {
    renderTo: vi.fn(() => rendition),
    loaded: { navigation: Promise.resolve({ toc: [] }) },
    destroy: vi.fn(),
    ready: Promise.resolve(),
    locations: { generate: vi.fn(() => Promise.resolve()), percentageFromCfi: vi.fn(() => 0.5) },
  }
  return { rendition, book, ePub: vi.fn(() => book) }
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

function renderReader(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/reader/:blockId" element={<ReaderPage />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  )
}

const msgs = () => screen.getAllByTestId('reading-msg')
const typeAndSend = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  const box = screen.getByLabelText('问书输入')
  await user.type(box, text)
  await user.keyboard('{Enter}')
}

describe('问书面板(spec 2026-09-16)', () => {
  it('无任务:右栏只有「问书」且默认展开;带任务:两个标签、默认学习模式,切换后学习面板不卸载', async () => {
    const { unmount } = renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    expect(screen.getByRole('tab', { name: '问书' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: '学习模式' })).toBeNull()
    expect(screen.getByText(/选中正文里的一段文字点「问 AI」/)).toBeVisible()
    unmount()

    const user = userEvent.setup()
    renderReader('/reader/4?task=3')
    await screen.findByRole('button', { name: '书签' })
    expect(screen.getByRole('tab', { name: '学习模式' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('chat-panel')).not.toBeVisible()
    await user.click(screen.getByRole('tab', { name: '问书' }))
    expect(screen.getByTestId('chat-panel')).toBeVisible()
    expect(screen.getByTestId('learn-panel')).not.toBeVisible()
    const learn = screen.getByTestId('learn-panel')
    await user.click(screen.getByRole('tab', { name: '学习模式' }))
    expect(screen.getByTestId('learn-panel')).toBe(learn) // 同一节点,只是隐藏/显示
    expect(screen.getByRole('button', { name: '开始费曼讲授' })).toBeVisible()
  })

  it('回车发送:带书/章节/块信息调 readingSend,出现用户与 AI 气泡;发送中输入禁用;Shift+Enter 只换行;续聊带 topicId', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(backendModule.backend, 'readingSend')
    renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    const box = screen.getByLabelText('问书输入')
    await user.type(box, '第一行')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(spy).not.toHaveBeenCalled()
    expect((box as HTMLTextAreaElement).value).toContain('\n')
    await user.clear(box)
    await typeAndSend(user, '什么是需求定律')
    expect(spy).toHaveBeenCalledTimes(1)
    const input = spy.mock.calls[0][0]
    expect(input).toMatchObject({ bookId: 1, topicId: null, text: '什么是需求定律', quote: '', spineHref: expect.stringMatching(/\.xhtml$/) })
    expect(input.clientMsgId).toMatch(/^rq-[a-z0-9]+-[a-z0-9]+$/)
    await waitFor(() => expect(msgs()).toHaveLength(2))
    expect(msgs()[0]).toHaveAttribute('data-role', 'user')
    expect(msgs()[0]).toHaveAttribute('data-status', 'done')
    expect(msgs()[1]).toHaveAttribute('data-role', 'assistant')
    expect(msgs()[1]).toHaveTextContent('需求定律')
    expect(screen.queryByTestId('reading-thinking')).toBeNull()
    // 第二条续同一话题
    await typeAndSend(user, '再问一句')
    await waitFor(() => expect(msgs()).toHaveLength(4))
    expect(spy.mock.calls[1][0].topicId).toBe(spy.mock.results[0].value ? (await spy.mock.results[0].value).topicId : null)
    // 历史里出现该话题,状态点为待整理(第一批不提炼)
    expect(within(screen.getByLabelText('历史话题')).getAllByRole('option').length).toBe(2)
    expect(screen.getByTestId('topic-state')).toHaveAttribute('data-state', 'pending')
  })

  it('「问 AI」把选文带进引用区并切到问书;发送时 quote 带上,blockId 按锚点段判定', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(backendModule.backend, 'readingSend')
    renderReader('/reader/4?task=3')
    await screen.findByRole('button', { name: '书签' })
    const range = {} as Range
    const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => '需求曲线向右下方倾斜', removeAllRanges: vi.fn() }
    h.rendition.getContents.mockReturnValue([{ window: { getSelection: () => selection }, cfiFromRange: () => 'epubcfi(/6/8!/4/4,/1:0,/1:4)' }])
    const toolbar = await screen.findByRole('toolbar', { name: '选区操作' })
    await user.click(within(toolbar).getByRole('button', { name: '问 AI' }))
    expect(screen.getByRole('tab', { name: '问书' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('quote-draft')).toHaveTextContent('需求曲线向右下方倾斜')
    expect(screen.queryByRole('toolbar', { name: '选区操作' })).toBeNull()
    h.rendition.getContents.mockReturnValue([])
    await typeAndSend(user, '这句怎么理解')
    expect(spy.mock.calls[0][0]).toMatchObject({ quote: '需求曲线向右下方倾斜', text: '这句怎么理解' })
    // 块 4 的锚点 href 与当前章节一致 → blockId=4
    const anchors = await backendModule.backend.listAnchors(4)
    const expected = anchors.some(a => a.spineHref === spy.mock.calls[0][0].spineHref) ? 4 : null
    expect(spy.mock.calls[0][0].blockId).toBe(expected)
    await waitFor(() => expect(msgs()[0]).toHaveTextContent('需求曲线向右下方倾斜'))
    // 引用可删
    await user.click(screen.getByRole('tab', { name: '问书' }))
    expect(screen.queryByTestId('quote-draft')).toBeNull()
  })

  it('AI 失败:用户气泡标 failed 并可「重试」,重试用同一 clientMsgId 与 topicId', async () => {
    const user = userEvent.setup()
    const real = backendModule.backend
    const spy = vi.spyOn(real, 'readingSend')
    spy.mockImplementationOnce(async input => {
      const r = await MockBackend.prototype.readingSend.call(real, input)
      const failed: ReadingSendResult = { topicId: r.topicId, userMessage: { ...r.userMessage, status: 'failed' }, assistantMessage: null }
      return failed
    })
    renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    await typeAndSend(user, '问')
    await waitFor(() => expect(msgs()[0]).toHaveAttribute('data-status', 'failed'))
    expect(msgs()).toHaveLength(1)
    const retry = within(msgs()[0]).getByRole('button', { name: '重试' })
    await user.click(retry)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    expect(spy.mock.calls[1][0].clientMsgId).toBe(spy.mock.calls[0][0].clientMsgId)
    expect(spy.mock.calls[1][0].topicId).toBe((await spy.mock.results[0].value).topicId)
    await waitFor(() => expect(msgs()).toHaveLength(2))
    expect(msgs()[0]).toHaveAttribute('data-status', 'done')
  })

  it('另起话题:立即清空并调 readingTopicEnd;无消息时禁用;历史下拉可回看并续聊旧话题', async () => {
    const user = userEvent.setup()
    const end = vi.spyOn(backendModule.backend, 'readingTopicEnd')
    const send = vi.spyOn(backendModule.backend, 'readingSend')
    renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    expect(screen.getByRole('button', { name: '另起话题' })).toBeDisabled()
    await typeAndSend(user, '第一话题')
    await waitFor(() => expect(msgs()).toHaveLength(2))
    const first = (await send.mock.results[0].value).topicId
    await user.click(screen.getByRole('button', { name: '另起话题' }))
    expect(screen.queryAllByTestId('reading-msg')).toHaveLength(0)
    await waitFor(() => expect(end).toHaveBeenCalledWith(first))
    await typeAndSend(user, '第二话题')
    await waitFor(() => expect(msgs()).toHaveLength(2))
    const second = (await send.mock.results[1].value).topicId
    expect(second).not.toBe(first)
    const history = screen.getByLabelText('历史话题')
    await waitFor(() => expect(within(history).getAllByRole('option')).toHaveLength(3))
    await user.selectOptions(history, String(first))
    await waitFor(() => expect(msgs()[0]).toHaveTextContent('第一话题'))
    await typeAndSend(user, '接着第一话题问')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    expect(send.mock.calls[2][0].topicId).toBe(first)
  })

  it('另起话题触发提炼后,历史里该话题状态点变「已记入记忆」(第二批)', async () => {
    const user = userEvent.setup()
    renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    await typeAndSend(user, '第一话题的问题')
    await waitFor(() => expect(msgs()).toHaveLength(2))
    expect(screen.getByTestId('topic-state')).toHaveAttribute('data-state', 'pending')
    await user.click(screen.getByRole('button', { name: '另起话题' }))
    // 回看该话题:状态点应为已记入记忆
    const history = screen.getByLabelText('历史话题')
    await waitFor(() => expect(within(history).getAllByRole('option').length).toBeGreaterThanOrEqual(2))
    const first = within(history).getAllByRole('option').at(-1)!.getAttribute('value')!
    await user.selectOptions(history, first)
    await waitFor(() => expect(screen.getByTestId('topic-state')).toHaveAttribute('data-state', 'done'))
    expect(screen.getByTestId('topic-state')).toHaveTextContent('已记入记忆')
  })

  it('BL-015/BL-014:AI 回复渲染 Markdown(**加粗** 不再是星号),面板可放大/收窄', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(backendModule.backend, 'readingSend')
    spy.mockImplementationOnce(async () => ({
      topicId: 1,
      userMessage: { id: 1, topicId: 1, role: 'user', text: '问', quote: '', spineHref: 'chap1.xhtml', blockId: null, status: 'done', clientMsgId: 'q1', createdAt: '2026-09-17T00:00:00Z' },
      assistantMessage: { id: 2, topicId: 1, role: 'assistant', text: '核心是:**贫穷是一种处境**。\n\n- 第一点\n- 第二点', quote: '', spineHref: 'chap1.xhtml', blockId: null, status: 'done', clientMsgId: null, createdAt: '2026-09-17T00:00:01Z' },
    }))
    renderReader('/reader/4')
    await screen.findByRole('button', { name: '书签' })
    await typeAndSend(user, '问')
    await waitFor(() => expect(msgs()).toHaveLength(2))
    const ai = msgs()[1]
    // 加粗渲染成 <strong>,正文里无原始星号
    expect(within(ai).getByText('贫穷是一种处境').tagName).toBe('STRONG')
    expect(ai.textContent).not.toContain('**')
    // 列表渲染
    expect(within(ai).getAllByRole('listitem')).toHaveLength(2)
    // 放大 / 收窄
    await user.click(screen.getByRole('button', { name: '放大对话' }))
    expect(screen.getByRole('button', { name: '收窄对话' })).toBeInTheDocument()
  })

  it('取消 = 停止等待:输入恢复、该条显示等待中;轮询到后端结果后补上回复', async () => {
    const user = userEvent.setup()
    const real = backendModule.backend
    let release!: (value: ReadingSendResult) => void
    const spy = vi.spyOn(real, 'readingSend').mockImplementationOnce(input => {
      // 后端照常完成:先落库,再让前端的 await 一直挂着
      const done = MockBackend.prototype.readingSend.call(real, input)
      return new Promise<ReadingSendResult>(resolve => {
        release = resolve
        void done
      })
    })
    render(
      <MemoryRouter initialEntries={['/reader/4']}>
        <Routes>
          <Route path="/reader/:blockId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: '书签' })
    await typeAndSend(user, '慢问题')
    expect(screen.getByTestId('reading-thinking')).toBeInTheDocument()
    expect(screen.getByLabelText('问书输入')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByTestId('reading-thinking')).toBeNull()
    expect(msgs()[0]).toHaveTextContent('等待中')
    expect(spy).toHaveBeenCalledTimes(1)
    // 轮询(pollMs 默认 3 s):后端已落库,readingMessages 会拿到 done 的用户消息与回复
    await waitFor(() => expect(msgs()).toHaveLength(2), { timeout: 5000 })
    expect(msgs()[0]).toHaveAttribute('data-status', 'done')
    expect(screen.getByLabelText('问书输入')).not.toBeDisabled()
    await act(async () => {
      release({ topicId: 1, userMessage: msgs()[0] as never, assistantMessage: null })
    })
  })
})
