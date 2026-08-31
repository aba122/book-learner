import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import { DAILY_CAP_DEFAULT } from '../../config'
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

function renderMap() {
  return render(
    <MemoryRouter initialEntries={['/map/1']}>
      <Routes>
        <Route path="/map/:bookId" element={<MapPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  )
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

  it('编辑模式:跳过与上移在定稿时传给 confirmMap', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(backendModule.backend, 'confirmMap')
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    const items = screen.getAllByTestId('block-item')
    await user.click(within(items[3]).getByRole('button', { name: '跳过' }))
    await user.click(within(items[1]).getByRole('button', { name: '上移' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))

    expect(spy).toHaveBeenCalledTimes(1)
    const [bookId, blocks] = spy.mock.calls[0]
    expect(bookId).toBe(1)
    expect(blocks[0].title).toBe('供给曲线与市场均衡')
    expect(blocks[1].title).toBe('需求曲线与需求定律')
    expect(blocks.find(b => b.title === '价格管制与市场干预')?.skipped).toBe(true)
  })

  it('定稿后目标设定:期限换算每日块数,开始学习落 setPlan 并回今日', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-31T12:00:00Z') })
    const user = userEvent.setup()
    const planSpy = vi.spyOn(backendModule.backend, 'setPlan')
    const activeSpy = vi.spyOn(backendModule.backend, 'setActiveBook')
    renderMap()
    await user.click(await screen.findByRole('button', { name: '编辑地图' }))
    await user.click(screen.getByRole('button', { name: '确认定稿' }))

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
