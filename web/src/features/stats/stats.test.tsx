import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import * as errorModule from '../../backend/errors'
import { BackendError } from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import type { Stats } from '../../types'
import StatsPage from './StatsPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

beforeEach(() => {
  ;(backendModule as unknown as { backend: Backend }).backend = new MockBackend()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

describe('统计页', () => {
  it('渲染 stats() 全部指标', async () => {
    render(<StatsPage />)
    expect(await screen.findByText('2/12')).toBeInTheDocument()
    expect(screen.getByTestId('stat-streak')).toHaveTextContent('3')
    expect(screen.getByTestId('stat-minutes')).toHaveTextContent('0')
    expect(screen.getByTestId('stat-weak-open')).toHaveTextContent('1')
    expect(screen.getByTestId('stat-weak-fixed')).toHaveTextContent('1')
  })

  it('不可重试的统计失败显示真实原因且不伪造零值', async () => {
    vi.spyOn(backendModule.backend, 'stats').mockRejectedValue(new BackendError({
      code: 'not_implemented',
      message: '原生统计暂未实现',
      retryable: false,
    }))

    render(<StatsPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('原生统计暂未实现')
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.queryByText('0/0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stat-streak')).not.toBeInTheDocument()
  })

  it('可重试失败只重新请求统计并恢复指标', async () => {
    const user = userEvent.setup()
    const stats = vi.spyOn(backendModule.backend, 'stats').mockRejectedValueOnce(new BackendError({
      code: 'offline',
      message: '统计连接失败',
      retryable: true,
    }))

    render(<StatsPage />)
    await user.click(await screen.findByRole('button', { name: '重试' }))

    expect(await screen.findByText('2/12')).toBeInTheDocument()
    expect(stats).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('统计连接失败')).not.toBeInTheDocument()
  })

  it('较晚到达的旧失败不会覆盖较新的统计', async () => {
    const baseStats = await backendModule.backend.stats()
    const olderAttempt = deferred<Stats>()
    const newerAttempt = deferred<Stats>()
    const stats = vi.spyOn(backendModule.backend, 'stats')
      .mockReturnValueOnce(olderAttempt.promise)
      .mockReturnValueOnce(newerAttempt.promise)

    render(<StrictMode><StatsPage /></StrictMode>)
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

  it('较晚到达的旧成功不会恢复过期指标', async () => {
    const baseStats = await backendModule.backend.stats()
    const olderAttempt = deferred<Stats>()
    const newerAttempt = deferred<Stats>()
    const stats = vi.spyOn(backendModule.backend, 'stats')
      .mockReturnValueOnce(olderAttempt.promise)
      .mockReturnValueOnce(newerAttempt.promise)

    render(<StrictMode><StatsPage /></StrictMode>)
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2))
    await act(async () => newerAttempt.resolve({ ...baseStats, passedBlocks: 7 }))
    expect(await screen.findByText('7/12')).toBeInTheDocument()
    await act(async () => olderAttempt.resolve(baseStats))

    expect(screen.getByText('7/12')).toBeInTheDocument()
    expect(screen.queryByText('2/12')).not.toBeInTheDocument()
  })

  it('卸载后到达的失败不再归一化或更新页面', async () => {
    const attempt = deferred<Stats>()
    vi.spyOn(backendModule.backend, 'stats').mockReturnValue(attempt.promise)
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')
    const { unmount } = render(<StatsPage />)

    unmount()
    await act(async () => attempt.reject(new BackendError({
      code: 'offline',
      message: '过期统计失败',
      retryable: true,
    })))

    expect(normalize).not.toHaveBeenCalled()
  })
})
