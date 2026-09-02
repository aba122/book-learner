// 注:计划约定 fake timers + userEvent 时用 advanceTimers 注入;实测 vitest 4 fake timers
// 下 user-event 连纯点击都会互等死锁(同 T4),故本文件统一用 fireEvent + act 推进。
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { BackendError } from '../../backend/errors'
import * as errorModule from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import FeynmanPage from './FeynmanPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

beforeEach(() => {
  vi.useFakeTimers()
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

async function renderFeynman(entry = '/feynman/3') {
  const view = render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/feynman/:taskId" element={<FeynmanPage />} />
        <Route path="*" element={null} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  )
  await act(async () => {}) // 初始加载(microtask 链)
  return view
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

async function click(el: HTMLElement) {
  fireEvent.click(el)
  await act(async () => {}) // 异步 handler 的 microtask
}

/** 输入复述并发送,推进打字机到整段渐显完成 */
async function sendOne(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  await click(screen.getByRole('button', { name: '发送' }))
  await act(async () => {
    vi.advanceTimersByTime(8000)
  })
}

describe('费曼对话页', () => {
  it('发送复述后,学生第 1 条渐显完成并完整出现', async () => {
    await renderFeynman()
    await sendOne('需求曲线向右下方倾斜')
    expect(screen.getByText(/降价反而能增加总收入/)).toBeInTheDocument()
  })

  it('4 轮后"结束讲授"变主强调态;评估卡完整;确认通过回今日', async () => {
    const spy = vi.spyOn(backendModule.backend, 'confirmVerdict')
    await renderFeynman()

    expect(screen.getByRole('button', { name: '结束讲授' })).toHaveAttribute(
      'data-ready',
      'false',
    )
    for (let i = 1; i <= 4; i++) await sendOne(`第${i}轮复述`)
    expect(screen.getByRole('button', { name: '结束讲授' })).toHaveAttribute('data-ready', 'true')

    await click(screen.getByRole('button', { name: '结束讲授' }))

    const card = screen.getByRole('dialog', { name: '讲授评估' })
    expect(within(card).getAllByTestId('eval-stars')).toHaveLength(3)
    expect(within(card).getByText('建议通过')).toBeInTheDocument()
    expect(within(card).getByText('混淆弹性与斜率')).toBeInTheDocument()
    expect(within(card).getByText('交叉价格弹性未覆盖')).toBeInTheDocument()
    expect(within(card).getAllByText('已当场修复')).toHaveLength(1)
    expect(within(card).getByText(/数字例子锚定概念/)).toBeInTheDocument()

    await click(within(card).getByRole('button', { name: '确认通过' }))
    expect(spy).toHaveBeenCalledWith(1, true)
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/)
  })

  it('"回读原文"跳 /reader/:blockId?back=<taskId>', async () => {
    await renderFeynman()
    await click(screen.getByRole('button', { name: '回读原文' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/reader/4?back=3')
  })

  it('"放弃本次"经 Confirm 后不调 confirmVerdict 直接返回', async () => {
    const spy = vi.spyOn(backendModule.backend, 'confirmVerdict')
    await renderFeynman()
    await click(screen.getByRole('button', { name: '放弃本次' }))
    const dialog = screen.getByRole('dialog', { name: '放弃这次讲授?' })
    await click(within(dialog).getByRole('button', { name: '放弃' }))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/)
  })

  it('todayQueue 初始化失败显示安全返回态且不启动 session', async () => {
    const startSession = vi.spyOn(backendModule.backend, 'startSession')
    vi.spyOn(backendModule.backend, 'todayQueue').mockRejectedValue(new BackendError({
      code: 'offline',
      message: '今日任务暂时不可用',
      retryable: true,
    }))

    await renderFeynman()

    expect(screen.getByRole('alert')).toHaveTextContent('今日任务暂时不可用')
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '返回今日' })).toBeEnabled()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('getBlock 初始化失败不调用后续原文或 session', async () => {
    const blockSource = vi.spyOn(backendModule.backend, 'blockSource')
    const startSession = vi.spyOn(backendModule.backend, 'startSession')
    vi.spyOn(backendModule.backend, 'getBlock').mockRejectedValue(new BackendError({
      code: 'not_found',
      message: '知识块不存在',
      retryable: false,
    }))

    await renderFeynman()

    expect(screen.getByRole('alert')).toHaveTextContent('知识块不存在')
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(blockSource).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('blockSource 初始化失败不调用 startSession', async () => {
    const startSession = vi.spyOn(backendModule.backend, 'startSession')
    vi.spyOn(backendModule.backend, 'blockSource').mockRejectedValue(new BackendError({
      code: 'offline',
      message: '讲授原文暂时不可用',
      retryable: true,
    }))

    await renderFeynman()

    expect(screen.getByRole('alert')).toHaveTextContent('讲授原文暂时不可用')
    expect(startSession).not.toHaveBeenCalled()
  })

  it('startSession 一旦尝试,即使错误标记可重试也只允许安全返回', async () => {
    const studentReply = vi.spyOn(backendModule.backend, 'studentReply')
    const endSession = vi.spyOn(backendModule.backend, 'endSession')
    const confirmVerdict = vi.spyOn(backendModule.backend, 'confirmVerdict')
    const completeTask = vi.spyOn(backendModule.backend, 'completeTask')
    const startSession = vi.spyOn(backendModule.backend, 'startSession').mockRejectedValue(new BackendError({
      code: 'offline',
      message: '会话启动结果未知',
      retryable: true,
    }))

    await renderFeynman()

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('会话启动结果未知')
    expect(within(alert).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(studentReply).not.toHaveBeenCalled()
    expect(endSession).not.toHaveBeenCalled()
    expect(confirmVerdict).not.toHaveBeenCalled()
    expect(completeTask).not.toHaveBeenCalled()
  })

  it('只读初始化失败可重试,成功后只启动一次 session', async () => {
    const original = backendModule.backend.todayQueue.bind(backendModule.backend)
    vi.spyOn(backendModule.backend, 'todayQueue')
      .mockRejectedValueOnce(new BackendError({
        code: 'offline',
        message: '队列暂时不可用',
        retryable: true,
      }))
      .mockImplementation(original)
    const startSession = vi.spyOn(backendModule.backend, 'startSession')
    await renderFeynman()

    await click(screen.getByRole('button', { name: '重试' }))

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox')).toBeEnabled()
  })

  it('会话启动进行中不提供重复启动入口,卸载后失败被忽略', async () => {
    const attempt = deferred<{ sessionId: number }>()
    const startSession = vi.spyOn(backendModule.backend, 'startSession').mockReturnValue(attempt.promise)
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')
    const view = await renderFeynman()

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回今日' })).toBeEnabled()
    view.unmount()
    await act(async () => attempt.reject(new BackendError({
      code: 'offline',
      message: '卸载后的启动失败',
      retryable: true,
    })))

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(normalize).not.toHaveBeenCalled()
  })
})
