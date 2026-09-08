import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { BackendError } from '../../backend/errors'
import * as errorModule from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import { DAILY_CAP_DEFAULT } from '../../config'
import type { KnowledgeBlock } from '../../types'
import MapPage from './MapPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

beforeEach(() => {
  ;(backendModule as unknown as { backend: Backend }).backend = new MockBackend()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function Probe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname + loc.search}</div>
}

function SwitchBook() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/map/2')}>切换测试书</button>
}

function renderMap() {
  return render(
    <MemoryRouter initialEntries={['/map/1']}>
      <Routes>
        <Route path="/map/:bookId" element={<MapPage />} />
        <Route path="*" element={null} />
      </Routes>
      <SwitchBook />
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

describe('知识地图页', () => {
  it('按模块分组渲染 12 块,含状态徽标与已通过块星级', async () => {
    renderMap()
    expect(await screen.findByText('供给与需求')).toBeInTheDocument()
    expect(screen.getByText('消费者选择')).toBeInTheDocument()
    expect(screen.getByText('生产与成本')).toBeInTheDocument()
    expect(screen.getAllByTestId('block-item')).toHaveLength(12)
    expect(screen.getAllByText('已通过')).toHaveLength(2)
    expect(screen.getAllByTestId('block-stars')).toHaveLength(2)
  })

  it('地图加载失败时不发布空地图,可独立重试块列表', async () => {
    const user = userEvent.setup()
    const expected = await backendModule.backend.listBlocks(1)
    const listBlocks = vi.spyOn(backendModule.backend, 'listBlocks')
      .mockRejectedValueOnce(new BackendError({
        code: 'offline',
        message: '知识地图暂时不可用',
        retryable: true,
      }))
      .mockResolvedValueOnce(expected)

    renderMap()

    expect(await screen.findByRole('alert')).toHaveTextContent('知识地图暂时不可用')
    expect(screen.queryByTestId('block-item')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findAllByTestId('block-item')).toHaveLength(12)
    expect(listBlocks).toHaveBeenCalledTimes(2)
  })

  it('书名请求失败不阻断已成功的知识块列表', async () => {
    vi.spyOn(backendModule.backend, 'listBooks').mockRejectedValue(new BackendError({
      code: 'offline',
      message: '书籍信息暂时不可用',
      retryable: true,
    }))

    renderMap()

    expect(await screen.findAllByTestId('block-item')).toHaveLength(12)
    expect(screen.getByRole('alert')).toHaveTextContent('书籍信息暂时不可用')
  })

  it('参数切换后较晚到达的旧地图结果不会覆盖新快照', async () => {
    const oldBlocks = await backendModule.backend.listBlocks(1)
    const olderAttempt = deferred<KnowledgeBlock[]>()
    const newerAttempt = deferred<KnowledgeBlock[]>()
    const listBlocks = vi.spyOn(backendModule.backend, 'listBlocks')
      .mockReturnValueOnce(olderAttempt.promise)
      .mockReturnValueOnce(newerAttempt.promise)
    renderMap()

    fireEvent.click(screen.getByRole('button', { name: '切换测试书' }))
    await waitFor(() => expect(listBlocks).toHaveBeenCalledTimes(2))
    await act(async () => newerAttempt.resolve([]))
    await act(async () => olderAttempt.resolve(oldBlocks))

    expect(screen.queryByTestId('block-item')).not.toBeInTheDocument()
    expect(screen.getByTestId('loc')).toHaveTextContent('/map/2')
  })

  it('卸载后晚到的地图失败不再进入错误状态', async () => {
    const attempt = deferred<KnowledgeBlock[]>()
    vi.spyOn(backendModule.backend, 'listBlocks').mockReturnValue(attempt.promise)
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')
    const view = renderMap()

    view.unmount()
    await act(async () => attempt.reject(new BackendError({
      code: 'offline',
      message: '卸载后的地图失败',
      retryable: true,
    })))

    expect(normalize).not.toHaveBeenCalled()
  })

  it('编辑模式:跳过与上移在定稿时差分为稳定 id 操作集并带修订号', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(backendModule.backend, 'confirmMap')
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    const items = screen.getAllByTestId('block-item')
    await user.click(within(items[3]).getByRole('button', { name: '跳过' }))
    await user.click(within(items[1]).getByRole('button', { name: '上移' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]).toEqual([1, 1, [
      { op: 'setSkipped', blockId: 4, skipped: true },
      { op: 'reorder', blockIds: [2, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    ]])
    // 成功后修订号刷新:第二次定稿带 expectedRevision=2
    await screen.findByRole('dialog', { name: '目标设定' })
    await user.click(screen.getByRole('button', { name: '稍后再定' }))
    await user.click(screen.getByRole('button', { name: '编辑地图' }))
    await user.click(within(screen.getAllByTestId('block-item')[0]).getByRole('button', { name: '跳过' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))
    expect(spy.mock.calls[1][1]).toBe(2)
  })

  it('改模块名差分为 renameModule 且排在首位', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(backendModule.backend, 'confirmMap')
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    const input = screen.getByLabelText('模块名:供给与需求')
    fireEvent.change(input, { target: { value: '新模块' } })
    fireEvent.blur(input)
    await user.click(within(screen.getAllByTestId('block-item')[5]).getByRole('button', { name: '跳过' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))
    expect(spy.mock.calls[0][2]).toEqual([
      { op: 'renameModule', from: '供给与需求', to: '新模块' },
      { op: 'setSkipped', blockId: 6, skipped: true },
    ])
  })

  it('无改动定稿:不调用后端,退出编辑态并打开目标设定', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(backendModule.backend, 'confirmMap')
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '目标设定' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认定稿' })).not.toBeInTheDocument()
  })

  it('修订号冲突(不可重试):错误可见、无重试、编辑保留', async () => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, 'confirmMap').mockRejectedValue(new BackendError({
      code: 'conflict', message: '数据状态冲突，请刷新后重试', retryable: false,
    }))
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    await user.click(within(screen.getAllByTestId('block-item')[3]).getByRole('button', { name: '跳过' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('数据状态冲突')
    expect(within(alert).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(within(screen.getAllByTestId('block-item')[3]).getByRole('button', { name: '恢复' })).toBeEnabled()
  })

  it('浏览模式显示已跳过的块,编辑初值沿用其 skipped', async () => {
    const user = userEvent.setup()
    await backendModule.backend.confirmMap(1, 1, [{ op: 'setSkipped', blockId: 4, skipped: true }])
    renderMap()
    const item = (await screen.findAllByTestId('block-item'))[3]
    expect(within(item).getByText('已跳过')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '编辑地图' }))
    expect(within(screen.getAllByTestId('block-item')[3]).getByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(screen.getByText(/11 个知识块/)).toBeInTheDocument()
  })

  it('不可重试的地图定稿失败保留全部编辑且不提供重试', async () => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, 'confirmMap').mockRejectedValue(new BackendError({
      code: 'not_implemented',
      message: '桌面端暂不支持地图定稿',
      retryable: false,
    }))
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    const items = screen.getAllByTestId('block-item')
    await user.click(within(items[3]).getByRole('button', { name: '跳过' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('桌面端暂不支持地图定稿')
    expect(within(alert).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(within(screen.getAllByTestId('block-item')[3]).getByRole('button', { name: '恢复' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '确认定稿' })).toBeEnabled()
  })

  it('地图定稿重试只重发精确编辑快照,失败期间不重载列表', async () => {
    const user = userEvent.setup()
    const listBlocks = vi.spyOn(backendModule.backend, 'listBlocks')
    const confirmMap = vi.spyOn(backendModule.backend, 'confirmMap')
      .mockRejectedValue(new BackendError({
        code: 'offline',
        message: '地图定稿暂时失败',
        retryable: true,
      }))
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    const items = screen.getAllByTestId('block-item')
    await user.click(within(items[1]).getByRole('button', { name: '上移' }))
    await user.click(within(items[3]).getByRole('button', { name: '跳过' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))
    await user.click(await screen.findByRole('button', { name: '重试' }))

    expect(confirmMap).toHaveBeenCalledTimes(2)
    expect(confirmMap.mock.calls[1]).toEqual(confirmMap.mock.calls[0])
    expect(listBlocks).toHaveBeenCalledTimes(1)
  })

  it('地图定稿写入进行中同步阻止重复提交', async () => {
    const attempt = deferred<void>()
    const confirmMap = vi.spyOn(backendModule.backend, 'confirmMap').mockReturnValue(attempt.promise)
    renderMap()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    await user.click(within(screen.getAllByTestId('block-item')[3]).getByRole('button', { name: '跳过' }))
    const confirm = screen.getByRole('button', { name: '确认定稿' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(confirmMap).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '定稿中…' })).toBeDisabled()
    attempt.reject(new BackendError({ code: 'offline', message: '稍后重试', retryable: true }))
    expect(await screen.findByRole('alert')).toHaveTextContent('稍后重试')
  })

  it('定稿后目标设定:期限换算每日块数,开始学习落 setPlan 并回今日', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-31T12:00:00Z') })
    const user = userEvent.setup()
    const planSpy = vi.spyOn(backendModule.backend, 'setPlan')
    const activeSpy = vi.spyOn(backendModule.backend, 'setActiveBook')
    const confirmSpy = vi.spyOn(backendModule.backend, 'confirmMap')
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))
    expect(confirmSpy).not.toHaveBeenCalled() // 无改动:不调用后端,但目标设定必须可达

    const deadline = await screen.findByLabelText('完成期限')
    fireEvent.change(deadline, { target: { value: '2026-09-09' } })
    // 12 个未跳过块 ÷ 10 天(含今天与截止日)= 每日 2 块(向上取整)
    expect(await screen.findByText(/每日 2 块/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('提醒时间'), { target: { value: '08:30' } })
    await user.click(screen.getByRole('button', { name: '开始学习' }))

    expect(planSpy).toHaveBeenCalledWith({
      bookId: 1,
      deadline: '2026-09-09',
      dailyNewBlocks: 2,
      dailyCap: DAILY_CAP_DEFAULT,
      remindTime: '08:30',
    })
    expect(activeSpy).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/))
  })
})
