import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { BackendError } from '../../backend/errors'
import * as errorModule from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import * as extractModule from '../../epub/extract'
import type { Book, KnowledgeBlock, MapProgress, SpineChapter } from '../../types'
import LibraryPage from './LibraryPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))
// EPUB 抽取在 jsdom 里不可行(epub.js 需真实 DOM/zip),导入向导测试 mock 掉抽取模块;真实抽取由 Playwright 覆盖
vi.mock('../../epub/extract', () => ({
  openEpub: vi.fn(async () => ({ destroy: vi.fn() })),
  extractSpine: vi.fn(async () => CHAPTERS),
}))

const CHAPTERS: SpineChapter[] = [
  { idx: 0, href: 'ch1.xhtml', title: '第一章', text: '第一章正文' },
  { idx: 1, href: 'ch2.xhtml', title: '第二章', text: '第二章正文' },
  { idx: 2, href: 'ch3.xhtml', title: '第三章', text: '第三章正文' },
]
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/

beforeEach(() => {
  ;(backendModule as unknown as { backend: Backend }).backend = new MockBackend()
  // vi.mock 工厂产生的 vi.fn 不受 restoreAllMocks 影响,调用计数需手动清零
  vi.mocked(extractModule.extractSpine).mockClear()
  vi.mocked(extractModule.openEpub).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function Probe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname + loc.search}</div>
}

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <Routes>
        <Route path="/library" element={<LibraryPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('单主攻书补完(M2 T8)', () => {
  it('暂停书显示"计划冻结 · 复习照常";标记为已学完经确认调用 finishBook 并更新徽标', async () => {
    const user = userEvent.setup()
    const { bookId } = await backendModule.backend.importEpub(new File(['x'], '系统之美.epub'), 'methodology')
    // 完成导入(存 spine + 地图作业),否则徽标是「导入未完成」而非「已暂停」
    await backendModule.backend.storeSpine(bookId, [{ idx: 0, href: 'c.xhtml', title: '一', text: '正文' }])
    await backendModule.backend.runMapJob(bookId, 'job-finish')
    const finishBook = vi.spyOn(backendModule.backend, 'finishBook')
    renderLibrary()
    expect(await screen.findByText('系统之美')).toBeInTheDocument()
    expect(screen.getByText('已暂停')).toBeInTheDocument()
    expect(screen.getByText('计划冻结 · 复习照常')).toBeInTheDocument()

    const buttons = screen.getAllByRole('button', { name: '标记为已学完' })
    await user.click(buttons[buttons.length - 1])
    const dialog = screen.getByRole('dialog', { name: '标记为已学完?' })
    expect(dialog).toHaveTextContent('复习照常')
    await user.click(within(dialog).getByRole('button', { name: '标记为已学完' }))
    expect(finishBook).toHaveBeenCalledWith(bookId)
    expect(await screen.findByText('已学完')).toBeInTheDocument()
    expect(screen.getByText('复习照常 · 不再主攻')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('点击已学完的书直接看地图,不弹切换确认', async () => {
    const user = userEvent.setup()
    const { bookId } = await backendModule.backend.importEpub(new File(['x'], '旧书.epub'), 'humanities')
    await backendModule.backend.finishBook(bookId)
    renderLibrary()
    await user.click(await screen.findByText('旧书'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('loc')).toHaveTextContent(`/map/${bookId}`)
  })
})

describe('书架页', () => {
  it('渲染种子书与"主攻中"状态徽标', async () => {
    renderLibrary()
    expect(await screen.findByText('微观经济学')).toBeInTheDocument()
    expect(screen.getByText('主攻中')).toBeInTheDocument()
  })

  it('书架加载失败时显示错误,可重试请求且不伪造书目', async () => {
    const user = userEvent.setup()
    const expected = await backendModule.backend.listBooks()
    const listBooks = vi.spyOn(backendModule.backend, 'listBooks')
      .mockRejectedValueOnce(new BackendError({
        code: 'offline',
        message: '书架暂时不可用',
        retryable: true,
      }))
      .mockResolvedValueOnce(expected)

    renderLibrary()

    expect(await screen.findByRole('alert')).toHaveTextContent('书架暂时不可用')
    expect(screen.queryByText('微观经济学')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('微观经济学')).toBeInTheDocument()
    expect(listBooks).toHaveBeenCalledTimes(2)
  })

  it('不可重试的书架加载失败不显示重试操作', async () => {
    vi.spyOn(backendModule.backend, 'listBooks').mockRejectedValue(new BackendError({
      code: 'internal',
      message: '书架数据损坏',
      retryable: false,
    }))

    renderLibrary()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('书架数据损坏')
    expect(within(alert).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })

  it('卸载后晚到的书架失败不再进入错误状态', async () => {
    const attempt = deferred<Book[]>()
    vi.spyOn(backendModule.backend, 'listBooks').mockReturnValue(attempt.promise)
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')
    const view = renderLibrary()

    view.unmount()
    await act(async () => attempt.reject(new BackendError({
      code: 'offline',
      message: '卸载后的书架失败',
      retryable: true,
    })))

    expect(normalize).not.toHaveBeenCalled()
  })

  it('删除书:确认后调用 deleteBook(日期为本地日历日),书从书架消失;主攻书删后无主攻', async () => {
    const user = userEvent.setup()
    const deleteBook = vi.spyOn(backendModule.backend, 'deleteBook')
    renderLibrary()
    await user.click(await screen.findByRole('button', { name: '删除《微观经济学》' }))
    const dialog = await screen.findByRole('dialog', { name: '删除《微观经济学》?' })
    expect(dialog).toHaveTextContent('删除前会更新今日快照')
    await user.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryByText('微观经济学')).toBeNull())
    expect(deleteBook).toHaveBeenCalledWith(1, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    expect(await screen.findByText('书架还空着——导入一本 EPUB 开始。')).toBeInTheDocument()
  })

  it('导入未完成的书显示徽标,也可删除', async () => {
    const user = userEvent.setup()
    await backendModule.backend.importEpub(new File(['epub'], '半途.epub', { type: 'application/epub+zip' }), 'textbook')
    renderLibrary()
    expect(await screen.findByText('导入未完成')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '删除《半途》' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryByText('半途')).toBeNull())
    expect(screen.getByText('微观经济学')).toBeInTheDocument()
  })

  it('导入向导:上传→选"教材"→抽取→storeSpine→作业进度→完成跳 /map/:bookId', async () => {
    const user = userEvent.setup()
    let progress!: (p: MapProgress) => void
    let resolveJob!: (v: KnowledgeBlock[]) => void
    const storeSpine = vi.spyOn(backendModule.backend, 'storeSpine')
    const runMapJob = vi.spyOn(backendModule.backend, 'runMapJob').mockImplementation(
      async (_bookId, _jobId, onProgress) => {
        progress = onProgress!
        return new Promise<KnowledgeBlock[]>(res => {
          resolveJob = res
        })
      },
    )
    renderLibrary()
    await user.click(await screen.findByRole('button', { name: '导入书籍' }))

    const selected = new File(['epub'], '深度工作.epub', { type: 'application/epub+zip' })
    await user.upload(screen.getByLabelText(/选择 EPUB 文件/), selected)
    await user.click(await screen.findByRole('button', { name: '教材' }))

    expect(await screen.findByText('正在生成知识地图…')).toBeInTheDocument()
    expect(vi.mocked(extractModule.extractSpine)).toHaveBeenCalledTimes(1)
    expect(storeSpine).toHaveBeenCalledWith(2, CHAPTERS)
    expect(runMapJob).toHaveBeenCalledTimes(1)
    expect(runMapJob.mock.calls[0][0]).toBe(2)
    expect(runMapJob.mock.calls[0][1]).toMatch(ID_RE)

    await act(async () => progress({ stage: 'chapter', index: 0, total: 3, title: '第一章' }))
    expect(screen.getByText('正在分析第 1/3 章:第一章')).toBeInTheDocument()
    await act(async () => progress({ stage: 'merging' }))
    expect(screen.getByText('正在整合知识地图…')).toBeInTheDocument()
    await act(async () => progress({ stage: 'done', blocks: 3 }))
    expect(screen.getByText('已生成 3 个知识块')).toBeInTheDocument()

    resolveJob([])
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/map/2'))
  })

  it('选到 PDF 不导入:提示 Calibre 转换命令,换成 EPUB 后继续', async () => {
    const user = userEvent.setup()
    const importEpub = vi.spyOn(backendModule.backend, 'importEpub')
    renderLibrary()
    await user.click(await screen.findByRole('button', { name: '导入书籍' }))
    await user.upload(screen.getByLabelText(/选择 EPUB 文件/), new File(['%PDF-1.7'], '经济学原理.pdf', { type: 'application/pdf' }))
    const hint = await screen.findByRole('alert')
    expect(hint).toHaveTextContent('ebook-convert "经济学原理.pdf" "经济学原理.epub"')
    expect(screen.queryByRole('button', { name: '教材' })).toBeNull()
    expect(importEpub).not.toHaveBeenCalled()
    await user.upload(screen.getByLabelText(/选择 EPUB 文件/), new File(['epub'], '经济学原理.epub', { type: 'application/epub+zip' }))
    expect(await screen.findByRole('button', { name: '教材' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('作业失败后重试:导入与抽取只做一次,runMapJob 复用同一 jobId', async () => {
    const user = userEvent.setup()
    const importEpub = vi.spyOn(backendModule.backend, 'importEpub')
    const runMapJob = vi.spyOn(backendModule.backend, 'runMapJob')
      .mockRejectedValueOnce(new BackendError({ code: 'io_failure', message: '地图作业中断', retryable: true }))
      .mockResolvedValueOnce([])
    renderLibrary()
    await user.click(await screen.findByRole('button', { name: '导入书籍' }))
    await user.upload(screen.getByLabelText(/选择 EPUB 文件/), new File(['epub'], '重试.epub', { type: 'application/epub+zip' }))
    await user.click(screen.getByRole('button', { name: '教材' }))

    const dialog = screen.getByRole('dialog', { name: '导入书籍' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('地图作业中断')
    await user.click(within(dialog).getByRole('button', { name: '重试' }))

    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/map/2'))
    expect(importEpub).toHaveBeenCalledTimes(1)
    expect(vi.mocked(extractModule.extractSpine)).toHaveBeenCalledTimes(1)
    expect(runMapJob).toHaveBeenCalledTimes(2)
    expect(runMapJob.mock.calls[1][1]).toBe(runMapJob.mock.calls[0][1])
  })

  it('EPUB 抽取失败:不可重试错误,保留文件与类型,只提供关闭', async () => {
    const user = userEvent.setup()
    vi.mocked(extractModule.extractSpine).mockRejectedValueOnce(new Error('bad zip'))
    const storeSpine = vi.spyOn(backendModule.backend, 'storeSpine')
    renderLibrary()
    await user.click(await screen.findByRole('button', { name: '导入书籍' }))
    await user.upload(screen.getByLabelText(/选择 EPUB 文件/), new File(['epub'], '坏文件.epub', { type: 'application/epub+zip' }))
    await user.click(screen.getByRole('button', { name: '人文·社科' }))

    const dialog = screen.getByRole('dialog', { name: '导入书籍' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('无法解析这个 EPUB 文件')
    expect(within(dialog).getByText(/坏文件/)).toBeInTheDocument()
    expect(within(dialog).getByText(/人文·社科/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeEnabled()
    expect(storeSpine).not.toHaveBeenCalled()
  })

  it('原生不支持导入时保留所选文件和类型,只提供关闭', async () => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, 'importEpub').mockRejectedValue(new BackendError({
      code: 'not_implemented',
      message: '桌面端暂不支持导入 EPUB',
      retryable: false,
    }))
    renderLibrary()
    await user.click(await screen.findByRole('button', { name: '导入书籍' }))
    const selected = new File(['epub'], '系统设计.epub', { type: 'application/epub+zip' })
    await user.upload(screen.getByLabelText(/选择 EPUB 文件/), selected)
    await user.click(screen.getByRole('button', { name: '教材' }))

    const dialog = screen.getByRole('dialog', { name: '导入书籍' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('桌面端暂不支持导入 EPUB')
    expect(within(dialog).getByText(/系统设计/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeEnabled()
  })

  it('可重试导入复用精确的文件和类型快照', async () => {
    const user = userEvent.setup()
    const importEpub = vi.spyOn(backendModule.backend, 'importEpub')
      .mockRejectedValueOnce(new BackendError({
        code: 'offline',
        message: '导入暂时失败',
        retryable: true,
      }))
      .mockResolvedValueOnce({ bookId: 42 })
    vi.spyOn(backendModule.backend, 'storeSpine').mockResolvedValue(undefined) // bookId 42 不在 Mock 种子里
    const runMapJob = vi.spyOn(backendModule.backend, 'runMapJob').mockResolvedValue([])
    renderLibrary()
    await user.click(await screen.findByRole('button', { name: '导入书籍' }))
    const selected = new File(['epub'], '可靠系统.epub', { type: 'application/epub+zip' })
    await user.upload(screen.getByLabelText(/选择 EPUB 文件/), selected)
    await user.click(screen.getByRole('button', { name: '方法论' }))

    await user.click(await screen.findByRole('button', { name: '重试' }))

    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/map/42'))
    expect(importEpub).toHaveBeenCalledTimes(2)
    expect(importEpub.mock.calls[0]).toEqual([selected, 'methodology'])
    expect(importEpub.mock.calls[1]).toEqual([selected, 'methodology'])
    expect(runMapJob).toHaveBeenCalledTimes(1)
    expect(runMapJob.mock.calls[0][1]).toMatch(ID_RE)
  })

  it('导入写入进行中同步阻止重复提交', async () => {
    const attempt = deferred<{ bookId: number }>()
    const importEpub = vi.spyOn(backendModule.backend, 'importEpub').mockReturnValue(attempt.promise)
    renderLibrary()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '导入书籍' }))
    await user.upload(
      screen.getByLabelText(/选择 EPUB 文件/),
      new File(['epub'], '并发.epub', { type: 'application/epub+zip' }),
    )
    const typeButton = screen.getByRole('button', { name: '教材' })
    fireEvent.click(typeButton)
    fireEvent.click(typeButton)

    expect(importEpub).toHaveBeenCalledTimes(1)
    attempt.reject(new BackendError({ code: 'offline', message: '稍后重试', retryable: true }))
    expect(await screen.findByRole('alert')).toHaveTextContent('稍后重试')
  })
})

describe('书架 · 导出到 Obsidian(M3 T2)', () => {
  it('预览清单 → 确认导出 → 结果与"在 Finder 中显示";目标目录不存在时禁用导出', async () => {
    const user = userEvent.setup()
    const preview = vi.spyOn(backendModule.backend, 'exportPreview')
    const exportObsidian = vi.spyOn(backendModule.backend, 'exportObsidian')
    const reveal = vi.spyOn(backendModule.backend, 'exportReveal')
    renderLibrary()
    expect(await screen.findByText('微观经济学')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: '导出到 Obsidian' })[0])
    const dialog = await screen.findByRole('dialog', { name: '导出到 Obsidian' })
    expect(preview).toHaveBeenCalledWith(1)
    const files = await within(dialog).findByTestId('export-files')
    expect(files).toHaveTextContent('微观经济学/00-学习报告.md')
    expect(files).toHaveTextContent('微观经济学/blocks/01-需求曲线与需求定律.md')
    expect(dialog).toHaveTextContent('共 13 个文件')
    await user.click(within(dialog).getByRole('button', { name: '确认导出' }))
    expect(exportObsidian).toHaveBeenCalledWith(1)
    expect(await within(dialog).findByTestId('export-written')).toHaveTextContent('13')
    expect(within(dialog).getByTestId('export-unchanged')).toHaveTextContent('0')
    await user.click(within(dialog).getByRole('button', { name: '在 Finder 中显示' }))
    expect(reveal).toHaveBeenCalledWith(1)
    await user.click(within(dialog).getByRole('button', { name: '完成' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    preview.mockResolvedValueOnce({ target: '/nope', targetExists: false, dir: '/nope/微观经济学', files: ['微观经济学/00-学习报告.md'] })
    await user.click(screen.getAllByRole('button', { name: '导出到 Obsidian' })[0])
    const again = await screen.findByRole('dialog', { name: '导出到 Obsidian' })
    expect(await within(again).findByRole('alert')).toHaveTextContent('目录不存在')
    expect(within(again).getByRole('button', { name: '确认导出' })).toBeDisabled()
  })

  it('导出失败:错误在对话框内可重试', async () => {
    const user = userEvent.setup()
    const exportObsidian = vi.spyOn(backendModule.backend, 'exportObsidian')
      .mockRejectedValueOnce(new BackendError({ code: 'io_failure', message: '无法访问本地文件', retryable: true }))
    renderLibrary()
    expect(await screen.findByText('微观经济学')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: '导出到 Obsidian' })[0])
    const dialog = await screen.findByRole('dialog', { name: '导出到 Obsidian' })
    await within(dialog).findByTestId('export-files')
    await user.click(within(dialog).getByRole('button', { name: '确认导出' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('无法访问本地文件')
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(exportObsidian).toHaveBeenCalledTimes(2)
    expect(await within(dialog).findByTestId('export-written')).toHaveTextContent('13')
  })
})

