import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import * as errorModule from '../../backend/errors'
import { BackendError } from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import { KIND_LABEL, POMODORO_DEFAULT, TASK_EST_MINUTES } from '../../config'
import type { DailyTask, Stats } from '../../types'
import TodayPage from './TodayPage'

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

function renderToday({ strict = false }: { strict?: boolean } = {}) {
  const page = (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<TodayPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>
  )
  return render(strict ? <StrictMode>{page}</StrictMode> : page)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

describe('今日学习页', () => {
  it('队列按 weak→review→new 渲染,卡片含类型标签与预估分钟', async () => {
    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    expect(cards).toHaveLength(4)
    const kinds = [KIND_LABEL.weak_retest, KIND_LABEL.review, KIND_LABEL.new, KIND_LABEL.new]
    kinds.forEach((label, i) => {
      expect(within(cards[i]).getByText(label)).toBeInTheDocument()
    })
    expect(
      within(cards[0]).getByText(new RegExp(`${TASK_EST_MINUTES.weak_retest} 分钟`)),
    ).toBeInTheDocument()
    expect(
      within(cards[2]).getByText(new RegExp(`${TASK_EST_MINUTES.new} 分钟`)),
    ).toBeInTheDocument()
  })

  it('顶部显示 passed/total 进度', async () => {
    renderToday()
    expect(await screen.findByText('2/12')).toBeInTheDocument()
  })

  it('不可重试的今日队列失败只显示错误消息', async () => {
    vi.spyOn(backendModule.backend, 'todayQueue').mockRejectedValue(new BackendError({
      code: 'not_implemented',
      message: '今日队列暂不可用',
      retryable: false,
    }))

    renderToday()

    expect(await screen.findByRole('alert')).toHaveTextContent('今日队列暂不可用')
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })

  it('可重试的今日队列失败可恢复队列', async () => {
    const user = userEvent.setup()
    const listBlocks = vi.spyOn(backendModule.backend, 'listBlocks')
    const stats = vi.spyOn(backendModule.backend, 'stats')
    const queue = vi.spyOn(backendModule.backend, 'todayQueue').mockRejectedValueOnce(new BackendError({
      code: 'busy',
      message: '今日队列加载失败',
      retryable: true,
    }))

    renderToday()
    await user.click(await screen.findByRole('button', { name: '重试' }))

    expect(await screen.findAllByTestId('task-card')).toHaveLength(4)
    expect(queue).toHaveBeenCalledTimes(2)
    expect(listBlocks).toHaveBeenCalledTimes(1)
    expect(stats).toHaveBeenCalledTimes(1)
  })

  it('跨午夜重试队列仍使用当前页面的同一日期', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 2, 23, 59, 59))
    const user = userEvent.setup()
    const queue = vi.spyOn(backendModule.backend, 'todayQueue').mockRejectedValueOnce(new BackendError({
      code: 'busy',
      message: '今日队列加载失败',
      retryable: true,
    }))

    renderToday()
    const retry = await screen.findByRole('button', { name: '重试' })
    vi.setSystemTime(new Date(2026, 8, 3, 0, 0, 1))
    await user.click(retry)

    expect(await screen.findAllByTestId('task-card')).toHaveLength(4)
    expect(queue).toHaveBeenNthCalledWith(1, '2026-09-02')
    expect(queue).toHaveBeenNthCalledWith(2, '2026-09-02')
  })

  it('队列 hydration 的 listBlocks 失败时不发布半成品快照', async () => {
    vi.spyOn(backendModule.backend, 'listBlocks').mockRejectedValue(new BackendError({
      code: 'offline',
      message: '知识块加载失败',
      retryable: false,
    }))

    renderToday()

    expect(await screen.findByRole('alert')).toHaveTextContent('知识块加载失败')
    expect(screen.queryByTestId('task-card')).not.toBeInTheDocument()
  })

  it('统计失败时保留可用队列且不伪造统计', async () => {
    vi.spyOn(backendModule.backend, 'stats').mockRejectedValue(new BackendError({
      code: 'offline',
      message: '统计加载失败',
      retryable: true,
    }))

    renderToday()

    expect(await screen.findAllByTestId('task-card')).toHaveLength(4)
    expect(screen.getByRole('alert')).toHaveTextContent('统计加载失败')
    expect(screen.queryByText('0/0')).not.toBeInTheDocument()
  })

  it('重试统计只重新请求统计', async () => {
    const user = userEvent.setup()
    const queue = vi.spyOn(backendModule.backend, 'todayQueue')
    const listBlocks = vi.spyOn(backendModule.backend, 'listBlocks')
    const stats = vi.spyOn(backendModule.backend, 'stats').mockRejectedValueOnce(new BackendError({
      code: 'offline',
      message: '统计加载失败',
      retryable: true,
    }))

    renderToday()
    await user.click(await screen.findByRole('button', { name: '重试' }))

    expect(await screen.findByText('2/12')).toBeInTheDocument()
    expect(stats).toHaveBeenCalledTimes(2)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(listBlocks).toHaveBeenCalledTimes(1)
  })

  it('较晚到达的旧统计成功不会覆盖较新的统计', async () => {
    const oldStats = await backendModule.backend.stats()
    const olderAttempt = deferred<Stats>()
    const newerAttempt = deferred<Stats>()
    const stats = vi.spyOn(backendModule.backend, 'stats')
      .mockReturnValueOnce(olderAttempt.promise)
      .mockReturnValueOnce(newerAttempt.promise)

    renderToday({ strict: true })
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2))
    await act(async () => newerAttempt.resolve({ ...oldStats, passedBlocks: 7 }))
    expect(await screen.findByText('7/12')).toBeInTheDocument()
    await act(async () => olderAttempt.resolve(oldStats))

    expect(screen.getByText('7/12')).toBeInTheDocument()
    expect(screen.queryByText('2/12')).not.toBeInTheDocument()
  })

  it('较晚到达的旧统计失败不会覆盖较新的统计', async () => {
    const baseStats = await backendModule.backend.stats()
    const olderAttempt = deferred<Stats>()
    const newerAttempt = deferred<Stats>()
    const stats = vi.spyOn(backendModule.backend, 'stats')
      .mockReturnValueOnce(olderAttempt.promise)
      .mockReturnValueOnce(newerAttempt.promise)

    renderToday({ strict: true })
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2))
    await act(async () => newerAttempt.resolve({ ...baseStats, passedBlocks: 7 }))
    expect(await screen.findByText('7/12')).toBeInTheDocument()
    await act(async () => olderAttempt.reject(new BackendError({
      code: 'offline',
      message: '旧统计失败',
      retryable: true,
    })))

    expect(screen.queryByText('旧统计失败')).not.toBeInTheDocument()
    expect(screen.getByText('7/12')).toBeInTheDocument()
  })

  it('每种重试只清除并恢复对应的错误', async () => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, 'todayQueue').mockRejectedValueOnce(new BackendError({
      code: 'busy',
      message: '队列加载失败',
      retryable: true,
    }))
    vi.spyOn(backendModule.backend, 'stats').mockRejectedValueOnce(new BackendError({
      code: 'offline',
      message: '统计加载失败',
      retryable: true,
    }))

    renderToday()
    const statsMessage = await screen.findByText('统计加载失败')
    await screen.findByText('队列加载失败')
    const statsAlert = statsMessage.closest('[role="alert"]')
    expect(statsAlert).not.toBeNull()
    await user.click(within(statsAlert as HTMLElement).getByRole('button', { name: '重试' }))

    expect(await screen.findByText('2/12')).toBeInTheDocument()
    expect(screen.queryByText('统计加载失败')).not.toBeInTheDocument()
    const queueMessage = screen.getByText('队列加载失败')
    const queueAlert = queueMessage.closest('[role="alert"]')
    expect(queueAlert).not.toBeNull()
    await user.click(within(queueAlert as HTMLElement).getByRole('button', { name: '重试' }))

    expect(await screen.findAllByTestId('task-card')).toHaveLength(4)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('较晚到达的旧队列成功不会覆盖较新的成功快照', async () => {
    const oldQueue = await backendModule.backend.todayQueue('2026-09-02')
    const olderAttempt = deferred<DailyTask[]>()
    const newerAttempt = deferred<DailyTask[]>()
    const queue = vi.spyOn(backendModule.backend, 'todayQueue')
    vi.spyOn(backendModule.backend, 'completeTask').mockResolvedValue(undefined)

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    queue.mockReturnValueOnce(olderAttempt.promise).mockReturnValueOnce(newerAttempt.promise)
    fireEvent.click(within(cards[0]).getByRole('button', { name: '完成' }))
    fireEvent.click(within(cards[1]).getByRole('button', { name: '完成' }))
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(3))

    await act(async () => newerAttempt.resolve([]))
    expect(await screen.findByText('今天没有排定的任务')).toBeInTheDocument()
    await act(async () => olderAttempt.resolve(oldQueue))

    expect(screen.queryByTestId('task-card')).not.toBeInTheDocument()
    expect(screen.getByText('今天没有排定的任务')).toBeInTheDocument()
  })

  it('较晚到达的旧队列失败不会覆盖较新的成功快照', async () => {
    const olderAttempt = deferred<DailyTask[]>()
    const newerAttempt = deferred<DailyTask[]>()
    const queue = vi.spyOn(backendModule.backend, 'todayQueue')
    vi.spyOn(backendModule.backend, 'completeTask').mockResolvedValue(undefined)

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    queue.mockReturnValueOnce(olderAttempt.promise).mockReturnValueOnce(newerAttempt.promise)
    fireEvent.click(within(cards[0]).getByRole('button', { name: '完成' }))
    fireEvent.click(within(cards[1]).getByRole('button', { name: '完成' }))
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(3))

    await act(async () => newerAttempt.resolve([]))
    expect(await screen.findByText('今天没有排定的任务')).toBeInTheDocument()
    await act(async () => olderAttempt.reject(new BackendError({
      code: 'offline',
      message: '旧队列失败',
      retryable: true,
    })))

    expect(screen.queryByText('旧队列失败')).not.toBeInTheDocument()
    expect(screen.getByText('今天没有排定的任务')).toBeInTheDocument()
  })

  it('卸载后晚到的队列成功不再继续 hydration', async () => {
    const oldQueue = await backendModule.backend.todayQueue('2026-09-02')
    const queueAttempt = deferred<DailyTask[]>()
    vi.spyOn(backendModule.backend, 'todayQueue').mockReturnValue(queueAttempt.promise)
    const listBlocks = vi.spyOn(backendModule.backend, 'listBlocks')

    const view = renderToday()
    view.unmount()
    await act(async () => queueAttempt.resolve(oldQueue))

    expect(listBlocks).not.toHaveBeenCalled()
  })

  it('新块卡"开始"跳 /reader/:blockId?task=<taskId>', async () => {
    const user = userEvent.setup()
    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    await user.click(within(cards[2]).getByRole('button', { name: '开始' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/reader/4?task=3')
  })

  it('review 卡可直接完成:completeTask 被调且卡片变完成态', async () => {
    const user = userEvent.setup()
    renderToday()
    const spy = vi.spyOn(backendModule.backend, 'completeTask')
    const cards = await screen.findAllByTestId('task-card')
    await user.click(within(cards[1]).getByRole('button', { name: '完成' }))
    expect(spy).toHaveBeenCalledWith(2)
    expect(await screen.findByText('已完成')).toBeInTheDocument()
  })

  it('完成任务失败时保留原任务与未完成状态', async () => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, 'completeTask').mockRejectedValue(new BackendError({
      code: 'offline',
      message: '完成任务失败',
      retryable: true,
    }))

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    await user.click(within(cards[1]).getByRole('button', { name: '完成' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('完成任务失败')
    expect(within(cards[1]).getByRole('button', { name: '完成' })).toBeEnabled()
    expect(within(cards[1]).queryByText('已完成')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('task-card')).toHaveLength(4)
  })

  it('不可重试的完成失败禁用完成动作但不阻塞其他任务动作', async () => {
    const user = userEvent.setup()
    const completeTask = vi.spyOn(backendModule.backend, 'completeTask').mockRejectedValue(new BackendError({
      code: 'not_implemented',
      message: '桌面端暂不支持完成任务',
      retryable: false,
    }))

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    await user.click(within(cards[1]).getByRole('button', { name: '完成' }))

    const row = screen.getByTestId('task-row-2')
    const alert = await within(row).findByRole('alert')
    expect(alert).toHaveTextContent('桌面端暂不支持完成任务')
    expect(within(alert).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    const unavailableButton = within(cards[1]).getByRole('button', { name: '完成暂不可用' })
    expect(unavailableButton).toBeDisabled()
    expect(within(cards[1]).getByRole('button', { name: '专注' })).toBeEnabled()
    expect(within(cards[1]).getByRole('button', { name: '回读原文' })).toBeEnabled()

    await user.click(within(cards[0]).getByRole('button', { name: '完成' }))
    const weakRetestUnavailableButton = within(cards[0]).getByRole('button', { name: '完成暂不可用' })
    expect(weakRetestUnavailableButton).toBeDisabled()
    expect(within(cards[0]).getByRole('button', { name: '专注' })).toBeEnabled()
    expect(within(cards[0]).getByRole('button', { name: '开始重考' })).toBeEnabled()

    fireEvent.click(unavailableButton)
    fireEvent.click(weakRetestUnavailableButton)
    expect(completeTask).toHaveBeenCalledTimes(2)
  })

  it('卸载后晚到的完成失败不再处理错误', async () => {
    const completion = deferred<void>()
    vi.spyOn(backendModule.backend, 'completeTask').mockReturnValue(completion.promise)
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')

    const view = renderToday()
    const cards = await screen.findAllByTestId('task-card')
    fireEvent.click(within(cards[1]).getByRole('button', { name: '完成' }))
    view.unmount()
    await act(async () => completion.reject(new BackendError({
      code: 'offline',
      message: '卸载后的失败',
      retryable: true,
    })))

    expect(normalize).not.toHaveBeenCalled()
  })

  it('卸载后晚到的完成成功不再刷新队列', async () => {
    const completion = deferred<void>()
    const queue = vi.spyOn(backendModule.backend, 'todayQueue')
    vi.spyOn(backendModule.backend, 'completeTask').mockReturnValue(completion.promise)

    const view = renderToday()
    const cards = await screen.findAllByTestId('task-card')
    fireEvent.click(within(cards[1]).getByRole('button', { name: '完成' }))
    view.unmount()
    await act(async () => completion.resolve())

    expect(queue).toHaveBeenCalledTimes(1)
  })

  it('不同任务分别显示自己的完成错误', async () => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, 'completeTask').mockImplementation(async taskId => {
      throw new BackendError({
        code: 'offline',
        message: `任务 ${taskId} 完成失败`,
        retryable: true,
      })
    })

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    await user.click(within(cards[0]).getByRole('button', { name: '完成' }))
    await user.click(within(cards[1]).getByRole('button', { name: '完成' }))

    expect(await within(screen.getByTestId('task-row-1')).findByRole('alert'))
      .toHaveTextContent('任务 1 完成失败')
    expect(within(screen.getByTestId('task-row-2')).getByRole('alert'))
      .toHaveTextContent('任务 2 完成失败')
  })

  it('同一任务完成写进行中时阻止重复提交且不阻塞其他任务', async () => {
    const completion = deferred<void>()
    const completeTask = vi.spyOn(backendModule.backend, 'completeTask').mockReturnValue(completion.promise)

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    const completeButton = within(cards[1]).getByRole('button', { name: '完成' })
    const otherCompleteButton = within(cards[0]).getByRole('button', { name: '完成' })
    fireEvent.click(completeButton)
    fireEvent.click(completeButton)
    fireEvent.click(otherCompleteButton)

    expect(completeTask).toHaveBeenCalledTimes(2)
    expect(completeTask).toHaveBeenNthCalledWith(1, 2)
    expect(completeTask).toHaveBeenNthCalledWith(2, 1)
    expect(within(cards[1]).getByRole('button', { name: '处理中…' })).toBeDisabled()
    expect(within(cards[0]).getByRole('button', { name: '处理中…' })).toBeDisabled()

    await act(async () => completion.resolve())
    await waitFor(() => {
      expect(within(cards[1]).getByRole('button', { name: '完成' })).toBeEnabled()
    })
  })

  it('重试完成操作只重发同一任务并在成功后刷新队列', async () => {
    const user = userEvent.setup()
    const queue = vi.spyOn(backendModule.backend, 'todayQueue')
    const listBlocks = vi.spyOn(backendModule.backend, 'listBlocks')
    const stats = vi.spyOn(backendModule.backend, 'stats')
    const completeTask = vi.spyOn(backendModule.backend, 'completeTask').mockRejectedValueOnce(new BackendError({
      code: 'offline',
      message: '完成任务失败',
      retryable: true,
    }))

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    await user.click(within(cards[1]).getByRole('button', { name: '完成' }))
    await user.click(await screen.findByRole('button', { name: '重试' }))

    expect(await screen.findByText('已完成')).toBeInTheDocument()
    expect(completeTask).toHaveBeenCalledTimes(2)
    expect(completeTask).toHaveBeenNthCalledWith(1, 2)
    expect(completeTask).toHaveBeenNthCalledWith(2, 2)
    expect(queue).toHaveBeenCalledTimes(2)
    expect(listBlocks).toHaveBeenCalledTimes(2)
    expect(stats).toHaveBeenCalledTimes(1)
  })

  it('完成后的队列刷新失败时保留旧快照', async () => {
    const user = userEvent.setup()
    const queue = vi.spyOn(backendModule.backend, 'todayQueue')
    vi.spyOn(backendModule.backend, 'completeTask').mockResolvedValue(undefined)

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    queue.mockRejectedValueOnce(new BackendError({
      code: 'offline',
      message: '队列刷新失败',
      retryable: true,
    }))
    await user.click(within(cards[1]).getByRole('button', { name: '完成' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('队列刷新失败')
    expect(screen.getAllByTestId('task-card')).toHaveLength(4)
    expect(within(cards[1]).getByRole('button', { name: '处理中…' })).toBeDisabled()
    expect(within(cards[1]).queryByText('已完成')).not.toBeInTheDocument()
  })

  it('完成写已提交但队列刷新失败时保持 guard 直到重试刷新成功', async () => {
    const user = userEvent.setup()
    const queue = vi.spyOn(backendModule.backend, 'todayQueue')
    const completeTask = vi.spyOn(backendModule.backend, 'completeTask').mockResolvedValue(undefined)

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    queue.mockRejectedValueOnce(new BackendError({
      code: 'offline',
      message: '队列刷新失败',
      retryable: true,
    }))
    fireEvent.click(within(cards[1]).getByRole('button', { name: '完成' }))

    const queueMessage = await screen.findByText('队列刷新失败')
    const guardedButton = within(cards[1]).getByRole('button', { name: '处理中…' })
    expect(guardedButton).toBeDisabled()
    fireEvent.click(guardedButton)
    expect(completeTask).toHaveBeenCalledTimes(1)

    const queueAlert = queueMessage.closest('[role="alert"]')
    expect(queueAlert).not.toBeNull()
    await user.click(within(queueAlert as HTMLElement).getByRole('button', { name: '重试' }))

    await waitFor(() => {
      expect(within(cards[1]).getByRole('button', { name: '完成' })).toBeEnabled()
    })
    expect(completeTask).toHaveBeenCalledTimes(1)
  })

  it('完成后的 hydration 刷新失败时保留旧任务与知识块快照', async () => {
    const user = userEvent.setup()
    const listBlocks = vi.spyOn(backendModule.backend, 'listBlocks')
    vi.spyOn(backendModule.backend, 'completeTask').mockResolvedValue(undefined)

    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    expect(within(cards[1]).getByText('需求曲线与需求定律')).toBeInTheDocument()
    listBlocks.mockRejectedValueOnce(new BackendError({
      code: 'offline',
      message: '知识块刷新失败',
      retryable: true,
    }))
    await user.click(within(cards[1]).getByRole('button', { name: '完成' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('知识块刷新失败')
    expect(screen.getAllByTestId('task-card')).toHaveLength(4)
    expect(within(cards[1]).getByText('需求曲线与需求定律')).toBeInTheDocument()
    expect(within(cards[1]).getByRole('button', { name: '处理中…' })).toBeDisabled()
  })

  it('番茄钟:点"专注"后从 25:00 开始倒计时', async () => {
    renderToday()
    const cards = await screen.findAllByTestId('task-card')
    vi.useFakeTimers()
    fireEvent.click(within(cards[0]).getByRole('button', { name: '专注' }))
    expect(screen.getByText(`${POMODORO_DEFAULT.work}:00`)).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByText('24:00')).toBeInTheDocument()
  })
})
