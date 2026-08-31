import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import { KIND_LABEL, POMODORO_DEFAULT, TASK_EST_MINUTES } from '../../config'
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

function renderToday() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<TodayPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  )
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
