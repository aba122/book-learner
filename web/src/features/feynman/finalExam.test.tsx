import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { BackendError } from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import MapPage from '../map/MapPage'
import FinalExamPage from './FinalExamPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/

beforeEach(() => {
  ;(backendModule as unknown as { backend: Backend }).backend = new MockBackend()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function Probe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

async function renderAt(entry: string) {
  const view = render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/final/:bookId" element={<FinalExamPage />} />
        <Route path="/map/:bookId" element={<MapPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  )
  await act(async () => {})
  await act(async () => {})
  return view
}

/** 把 Mock 书 1 的全部未跳过块置为通过 */
async function passAllBlocks() {
  const blocks = await backendModule.backend.listBlocks(1)
  for (const b of blocks) {
    if (b.status !== 'passed' && b.status !== 'consolidated') Object.assign(b, { status: 'passed', passedAt: '2026-09-01' })
  }
}

async function click(el: HTMLElement) {
  fireEvent.click(el)
  await act(async () => {})
}

describe('整书终评(M3 T1)', () => {
  it('地图页只在全部块通过时出现"整书终评"入口,点击进入 /final/:bookId', async () => {
    const first = await renderAt('/map/1')
    expect(screen.queryByRole('button', { name: '整书终评' })).toBeNull()
    first.unmount()
    await passAllBlocks()
    await renderAt('/map/1')
    await click(screen.getAllByRole('button', { name: '整书终评' })[0])
    expect(screen.getByTestId('loc')).toHaveTextContent('/final/1')
  })

  it('未全部通过时 finalExamStart 冲突,页面显示错误并可返回书架', async () => {
    await renderAt('/final/1')
    expect(screen.getByRole('alert')).toHaveTextContent(/冲突/)
    await click(screen.getByRole('button', { name: '返回书架' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/library')
  })

  it('固定 opener 先开口 → 两次作答后可生成报告 → 报告页与书状态', async () => {
    await passAllBlocks()
    const start = vi.spyOn(backendModule.backend, 'finalExamStart')
    const submit = vi.spyOn(backendModule.backend, 'submitTurn')
    const finish = vi.spyOn(backendModule.backend, 'finalExamFinish')
    await renderAt('/final/1')
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0][0]).toBe(1)
    expect(start.mock.calls[0][1]).toMatch(ID_RE)
    expect(submit.mock.calls.filter(c => c[2] === 'opener').map(c => c[3])).toEqual(['请开始终评'])
    expect(screen.getByText('请开始终评')).toBeInTheDocument()
    expect(screen.getByText(/先说说这本书分几个模块/)).toBeInTheDocument()
    const finishBtn = screen.getByRole('button', { name: '生成学习报告' })
    expect(finishBtn).toBeDisabled()

    const box = screen.getByRole('textbox', { name: '终评输入' })
    fireEvent.change(box, { target: { value: '全书分三个模块:供需、消费者选择、生产成本。' } })
    await click(screen.getByRole('button', { name: '发送' }))
    expect(finishBtn).toBeDisabled()
    fireEvent.change(box, { target: { value: '供需是基础,消费者选择解释需求曲线的来源。' } })
    await click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByText(/综合题 1/)).toBeInTheDocument()
    expect(finishBtn).not.toBeDisabled()

    await click(finishBtn)
    expect(finish).toHaveBeenCalledTimes(1)
    const [sessionId, version, requestId] = finish.mock.calls[0]
    expect(typeof sessionId).toBe('number')
    expect(version).toBe(3)
    expect(requestId).toBe('final-report')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^学习报告:/)
    expect(screen.getByTestId('final-overall')).toHaveAttribute('aria-label', '4 星')
    expect(screen.getByText(/最强模块/)).toBeInTheDocument()
    expect(screen.getByText(/books\/microeconomics\/_report\.md/)).toBeInTheDocument()
    const books = await backendModule.backend.listBooks()
    expect(books.find(b => b.id === 1)?.status).toBe('finished')
    await click(screen.getByRole('button', { name: '返回书架' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/library')
  })

  it('已结束的终评重进直接以常量 id 重放报告', async () => {
    await passAllBlocks()
    const view = await backendModule.backend.finalExamStart(1, 'pre')
    await backendModule.backend.submitTurn(view.sessionId, 0, 'opener', '请开始终评')
    await backendModule.backend.submitTurn(view.sessionId, 1, 'a1', '答 1')
    await backendModule.backend.submitTurn(view.sessionId, 2, 'a2', '答 2')
    await backendModule.backend.finalExamFinish(view.sessionId, 3, 'final-report')
    const finish = vi.spyOn(backendModule.backend, 'finalExamFinish')
    await renderAt('/final/1')
    expect(finish).toHaveBeenCalledWith(view.sessionId, 4, 'final-report')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^学习报告:/)
  })

  it('生成报告失败:错误可见可重试,不离开页面', async () => {
    await passAllBlocks()
    const finish = vi.spyOn(backendModule.backend, 'finalExamFinish')
      .mockRejectedValueOnce(new BackendError({ code: 'ai_unavailable', message: 'AI 暂时没有回应,请重试', retryable: true }))
    await renderAt('/final/1')
    const box = screen.getByRole('textbox', { name: '终评输入' })
    for (const t of ['答 1', '答 2']) {
      fireEvent.change(box, { target: { value: t } })
      await click(screen.getByRole('button', { name: '发送' }))
    }
    await click(screen.getByRole('button', { name: '生成学习报告' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('AI 暂时没有回应')
    await click(within(alert).getByRole('button', { name: '重试' }))
    expect(finish).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^学习报告:/)
  })
})
