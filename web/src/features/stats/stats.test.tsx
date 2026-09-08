import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import * as errorModule from '../../backend/errors'
import { BackendError } from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import type { Stats, StatsDetail } from '../../types'
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

describe('统计页 · 三区详情(M2 T7)', () => {
  it('进度按书显示通过/巩固/截止/预计完成;投入 14 根柱与 56 格打卡;质量显示均分与复习通过率', async () => {
    render(<StatsPage />)
    const progress = await screen.findByTestId('section-progress')
    const rows = within(progress).getAllByTestId('progress-book')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('微观经济学')
    expect(rows[0]).toHaveTextContent('主攻中')
    expect(rows[0]).toHaveTextContent(/已通过 2\/12 · 已巩固 0 · 截止 未设 · 预计完成 \d{4}-\d{2}-\d{2}/)
    const effort = screen.getByTestId('section-effort')
    expect(within(effort).getAllByTestId('effort-bar')).toHaveLength(14)
    expect(within(effort).getByTestId('effort-minutes')).toHaveTextContent('320')
    expect(within(effort).getByTestId('effort-pomodoros')).toHaveTextContent('13')
    const cells = within(effort).getAllByTestId('streak-cell')
    expect(cells).toHaveLength(56)
    expect(cells[55]).toHaveAttribute('data-active', 'true')
    expect(cells[54]).toHaveAttribute('data-active', 'false')
    const quality = screen.getByTestId('section-quality')
    expect(within(quality).getByTestId('weak-opened')).toHaveTextContent('6')
    expect(within(quality).getByTestId('weak-fixed')).toHaveTextContent('4')
    expect(within(quality).getAllByTestId('avg-score').map(e => e.textContent)).toEqual(['4.5', '4.0', '4.5'])
    expect(within(quality).getByText(/近 2 次/)).toBeInTheDocument()
    expect(within(quality).getByTestId('review-pass-rate')).toHaveTextContent('75%')
  })

  it('空数据:每区给出说明而不是伪造数字', async () => {
    const empty: StatsDetail = { books: [], days: [], streakCalendar: [], weakTrend: [], avgScores: null, reviewPassRate: null }
    vi.spyOn(backendModule.backend, 'statsDetail').mockResolvedValue(empty)
    render(<StatsPage />)
    expect(await screen.findByText(/书架为空/)).toBeInTheDocument()
    expect(screen.queryAllByTestId('effort-bar')).toHaveLength(0)
    expect(screen.getByText(/尚无评估/)).toBeInTheDocument()
    expect(screen.getByText(/近 30 天没有间隔复习记录/)).toBeInTheDocument()
    expect(screen.getByTestId('effort-minutes')).toHaveTextContent('0')
  })

  it('详情失败只影响三区,汇总卡照常;重试后出现', async () => {
    const detail = vi.spyOn(backendModule.backend, 'statsDetail')
      .mockRejectedValueOnce(new BackendError({ code: 'io_failure', message: '详情汇总失败', retryable: true }))
    render(<StatsPage />)
    expect(await screen.findByText('2/12')).toBeInTheDocument()
    const alert = (await screen.findByText('详情汇总失败')).closest('[role="alert"]') as HTMLElement
    expect(screen.queryByTestId('section-progress')).toBeNull()
    await userEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByTestId('section-progress')).toBeInTheDocument()
    expect(detail).toHaveBeenCalledTimes(2)
  })
})
