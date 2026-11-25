import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import { EXCERPT_POLL_MS } from '../../config'
import { clearToasts } from '../../lib/toastStore'
import ExcerptsPage from './ExcerptsPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

let mock: MockBackend

beforeEach(() => {
  mock = new MockBackend()
  ;(backendModule as unknown as { backend: Backend }).backend = mock
  try {
    localStorage.clear()
  } catch {
    /* Node 无 localStorage 时忽略 */
  }
})

afterEach(() => {
  cleanup()
  clearToasts()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function Probe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname + loc.search + (loc.state ? JSON.stringify(loc.state) : '')}</div>
}

function renderPage(path = '/excerpts') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/excerpts" element={<ExcerptsPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  )
}

/** 第二本书:亚隆(有正文、无知识块),一条手动存入的书摘 */
async function seedYalom() {
  const { bookId } = await mock.importEpub(new File(['x'], '存在主义心理治疗.epub'), 'humanities')
  await mock.storeSpine(bookId, [{ idx: 0, href: 'Text/c1.xhtml', title: '导论', text: '死亡是存在的终极关怀之一。' }])
  await mock.setBookAuthor(bookId, '[美]欧文·D·亚隆')
  await mock.excerptAdd(bookId, { text: '死亡是存在的终极关怀之一。', spineHref: 'Text/c1.xhtml', cfi: null })
  return bookId
}

describe('书摘页(BL-034)', () => {
  it('空态:一键为有正文的书入队整理', async () => {
    const user = userEvent.setup()
    const generate = vi.spyOn(mock, 'excerptGenerate')
    renderPage()
    const start = await screen.findByRole('button', { name: /为 1 本书整理书摘/ })
    expect(screen.getByText('还没有书摘')).toBeInTheDocument()
    await user.click(start)
    expect(generate).toHaveBeenCalledWith(1, false)
    expect(await screen.findByText('开始整理 1 本书的书摘')).toBeInTheDocument()
    expect(await screen.findByTestId('excerpt-job')).toBeInTheDocument()
  })

  it('整理进行中显示进度,轮询到完成后刷新卡片并提示', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mock.excerptGenerate(1, false)
    renderPage()
    expect(await screen.findByTestId('excerpt-job')).toHaveTextContent(/正在读第 1 \/ 4 段|正在准备|马上开始/)
    for (let i = 0; i < 8 && screen.queryAllByTestId('excerpt-card').length === 0; i++) {
      await act(async () => {
        vi.advanceTimersByTime(EXCERPT_POLL_MS)
      })
    }
    await waitFor(() => expect(screen.getAllByTestId('excerpt-card').length).toBeGreaterThan(0))
    expect(screen.queryByTestId('excerpt-job')).not.toBeInTheDocument()
    expect(await screen.findByText('《微观经济学》的书摘整理好了')).toBeInTheDocument()
  })

  it('按作者归类:作者栏有「全部」与各作者,切到某位作者显示大标题与注记', async () => {
    const user = userEvent.setup()
    await mock.excerptAdd(1, { text: '需求定律说价格越高,需求量越少。', spineHref: 'ch1.xhtml', cfi: null })
    await seedYalom()
    renderPage()
    const authors = await screen.findByRole('navigation', { name: '作者' })
    await within(authors).findByText('欧文·D·亚隆')
    expect(within(authors).getByText('全部书摘')).toBeInTheDocument()
    expect(within(authors).getByText('哈尔·范里安')).toBeInTheDocument()
    // 全部视图两位作者都在
    expect(screen.getByRole('heading', { level: 1, name: '书摘' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '《微观经济学》的书摘' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '《存在主义心理治疗》的书摘' })).toBeInTheDocument()
    await user.click(within(authors).getByText('欧文·D·亚隆'))
    expect(screen.getByRole('heading', { level: 1, name: '欧文·D·亚隆' })).toBeInTheDocument()
    expect(screen.getByText(/美 · 1 本书 · 1 张卡片/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '《微观经济学》的书摘' })).not.toBeInTheDocument()
    expect(localStorage.getItem('bookLearner.excerptAuthor')).toBe('欧文d亚隆')
  })

  it('搜索按文字过滤;没有结果时提示', async () => {
    const user = userEvent.setup()
    await mock.excerptAdd(1, { text: '弹性衡量的是反应的灵敏程度。', spineHref: 'ch1.xhtml', cfi: null })
    await mock.excerptAdd(1, { text: '机会成本是为得到它而放弃的东西。', spineHref: 'ch1.xhtml', cfi: null })
    renderPage()
    await screen.findAllByTestId('excerpt-card')
    await user.type(screen.getByRole('searchbox', { name: '搜索书摘' }), '弹性')
    expect(screen.getAllByTestId('excerpt-card')).toHaveLength(1)
    await user.clear(screen.getByRole('searchbox', { name: '搜索书摘' }))
    await user.type(screen.getByRole('searchbox', { name: '搜索书摘' }), '不存在的词')
    expect(screen.queryAllByTestId('excerpt-card')).toHaveLength(0)
    expect(screen.getByText('没有找到含「不存在的词」的书摘')).toBeInTheDocument()
  })

  it('删除后可撤销', async () => {
    const user = userEvent.setup()
    await mock.excerptAdd(1, { text: '需求定律说价格越高,需求量越少。', spineHref: 'ch1.xhtml', cfi: null })
    renderPage()
    const card = await screen.findByTestId('excerpt-card')
    await user.click(within(card).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryAllByTestId('excerpt-card')).toHaveLength(0))
    const toastEl = (await screen.findByText('已删除')).closest('[role=status]') as HTMLElement
    await user.click(within(toastEl).getByRole('button', { name: '撤销' }))
    expect(await screen.findByTestId('excerpt-card')).toHaveTextContent('需求定律说价格越高,需求量越少。')
  })

  it('编辑:改字后卡片标「已改」,恢复原文回到书中原文', async () => {
    const user = userEvent.setup()
    await mock.excerptAdd(1, { text: '需求定律说价格越高,需求量越少。', spineHref: 'ch1.xhtml', cfi: null })
    renderPage()
    const card = await screen.findByTestId('excerpt-card')
    await user.click(within(card).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑书摘' })
    const box = within(dialog).getByRole('textbox', { name: '书摘文字' })
    await user.clear(box)
    await user.type(box, '价格越高,需求量越少。')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('excerpt-card')).toHaveTextContent('价格越高,需求量越少。')
    expect(screen.getByTestId('excerpt-card')).toHaveTextContent('已改')
    await user.click(within(screen.getByTestId('excerpt-card')).getByRole('button', { name: '编辑' }))
    await user.click(within(await screen.findByRole('dialog', { name: '编辑书摘' })).getByRole('button', { name: '恢复原文' }))
    await waitFor(() => expect(screen.getByTestId('excerpt-card')).toHaveTextContent('需求定律说价格越高,需求量越少。'))
    expect(screen.getByTestId('excerpt-card')).not.toHaveTextContent('已改')
  })

  it('在书中查看:有知识块 → 带原文跳阅读器;没有 → 提示原因', async () => {
    const user = userEvent.setup()
    await mock.excerptAdd(1, { text: '需求定律说价格越高,需求量越少。', spineHref: 'ch1.xhtml', cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:5)' })
    await seedYalom()
    renderPage()
    const regions = await screen.findAllByRole('region')
    const yalom = regions.find(r => r.getAttribute('aria-label') === '《存在主义心理治疗》的书摘')!
    await user.click(within(yalom).getByRole('button', { name: '在书中查看' }))
    expect(await screen.findByText('这本书还没有知识地图,阅读器打不开')).toBeInTheDocument()
    const micro = regions.find(r => r.getAttribute('aria-label') === '《微观经济学》的书摘')!
    await user.click(within(micro).getByRole('button', { name: '在书中查看' }))
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/reader/1'))
    expect(screen.getByTestId('loc')).toHaveTextContent('"cfi":"epubcfi(/6/2!/4/2,/1:0,/1:5)"')
    expect(screen.getByTestId('loc')).toHaveTextContent('"text":"需求定律说价格越高,需求量越少。"')
  })

  it('失败的作业显示原因与重试;重新整理先确认', async () => {
    const user = userEvent.setup()
    await mock.excerptAdd(1, { text: '需求定律说价格越高,需求量越少。', spineHref: 'ch1.xhtml', cfi: null })
    const real = await mock.excerptLibrary()
    const failedJob = { bookId: 1, run: 1, stage: 'failed' as const, nextPiece: 2, totalPieces: 6, target: 12, added: 0, error: 'AI 响应超时。点「重试」会从断点接着整理', queuedAt: 't', updatedAt: 't', finishedAt: null }
    vi.spyOn(mock, 'excerptLibrary').mockResolvedValue({ ...real, books: real.books.map(b => (b.bookId === 1 ? { ...b, job: failedJob } : b)) })
    const generate = vi.spyOn(mock, 'excerptGenerate').mockResolvedValue({ ...failedJob, stage: 'queued', error: null })
    const view = renderPage()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('整理没有完成:AI 响应超时')
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(generate).toHaveBeenCalledWith(1, false)
    // 重试后作业进行中:菜单里不再有「重新整理」
    await user.click(screen.getByRole('button', { name: '《微观经济学》的更多操作' }))
    expect(within(await screen.findByRole('menu')).queryByRole('menuitem', { name: '重新整理' })).not.toBeInTheDocument()
    view.unmount()

    // 重新挂载(作业仍是失败):重新整理先确认
    renderPage()
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: '《微观经济学》的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '重新整理' }))
    const confirm = await screen.findByRole('dialog', { name: '重新整理《微观经济学》的书摘?' })
    expect(confirm).toHaveTextContent('删掉的也不会再出现')
    await user.click(within(confirm).getByRole('button', { name: '重新整理' }))
    expect(generate).toHaveBeenLastCalledWith(1, true)
  })

  it('更正作者:书换到新作者名下', async () => {
    const user = userEvent.setup()
    await mock.excerptAdd(1, { text: '需求定律说价格越高,需求量越少。', spineHref: 'ch1.xhtml', cfi: null })
    renderPage()
    await screen.findByTestId('excerpt-card')
    await user.click(screen.getByRole('button', { name: '《微观经济学》的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '更正作者' }))
    const dialog = await screen.findByRole('dialog', { name: '更正《微观经济学》的作者' })
    const input = within(dialog).getByRole('textbox', { name: '作者' })
    await user.clear(input)
    await user.type(input, '(美)哈尔·R·范里安')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    const authors = screen.getByRole('navigation', { name: '作者' })
    expect(await within(authors).findByText('哈尔·R·范里安')).toBeInTheDocument()
    expect(within(authors).queryByText('哈尔·范里安')).not.toBeInTheDocument()
    expect((await mock.listBooks())[0].author).toBe('(美)哈尔·R·范里安')
  })
})
