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
import type { EvalResult, SessionView, TurnResult } from '../../types'
import FeynmanPage from './FeynmanPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EVAL: EvalResult = {
  verdict: 'pass_suggested',
  scores: { accuracy: 4, completeness: 4, clarity: 5 },
  summary: '讲解到位',
  weakPoints: [{ title: '弹性vs斜率', detail: '未完全修复', fixedInSession: false }],
  finalRestatement: '弹性是相对变化率',
  observationNote: '举例能力强',
}

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

/** 让 startOrResumeSession 返回改写后的视图(水合场景) */
function hydrateWith(patch: Partial<SessionView>) {
  const original = backendModule.backend.startOrResumeSession.bind(backendModule.backend)
  return vi.spyOn(backendModule.backend, 'startOrResumeSession').mockImplementation(
    async (...args) => ({ ...(await original(...args)), ...patch }),
  )
}

const retryable = (message: string) => new BackendError({ code: 'io_failure', message, retryable: true })
const fatal = (message: string) => new BackendError({ code: 'conflict', message, retryable: false })

describe('费曼对话页(契约 v2)', () => {
  it('发送复述后学生第 1 条渐显;startOrResumeSession/submitTurn 参数符合契约', async () => {
    const start = vi.spyOn(backendModule.backend, 'startOrResumeSession')
    const submit = vi.spyOn(backendModule.backend, 'submitTurn')
    await renderFeynman()
    await sendOne('需求曲线向右下方倾斜')
    expect(screen.getByText(/降价反而能增加总收入/)).toBeInTheDocument()
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0][0]).toBe(3)
    expect(start.mock.calls[0][1]).toMatch(ID_RE)
    expect(start.mock.calls[0][2]).toMatch(DATE_RE)
    const [sessionId, expectedVersion, clientTurnId, text] = submit.mock.calls[0]
    expect(typeof sessionId).toBe('number')
    expect(expectedVersion).toBe(0)
    expect(clientTurnId).toMatch(ID_RE)
    expect(text).toBe('需求曲线向右下方倾斜')
  })

  it('4 轮后"结束讲授"变主强调态;评估卡完整;确认通过走原子判定并回今日', async () => {
    const evaluate = vi.spyOn(backendModule.backend, 'requestEvaluation')
    const confirm = vi.spyOn(backendModule.backend, 'confirmSessionVerdict')
    await renderFeynman()

    expect(screen.getByRole('button', { name: '结束讲授' })).toHaveAttribute('data-ready', 'false')
    for (let i = 1; i <= 4; i++) await sendOne(`第${i}轮复述`)
    expect(screen.getByRole('button', { name: '结束讲授' })).toHaveAttribute('data-ready', 'true')

    await click(screen.getByRole('button', { name: '结束讲授' }))
    expect(evaluate).toHaveBeenCalledWith(expect.any(Number), 'eval')

    const card = screen.getByRole('dialog', { name: '讲授评估' })
    expect(within(card).getAllByTestId('eval-stars')).toHaveLength(3)
    expect(within(card).getByText('建议通过')).toBeInTheDocument()
    expect(within(card).getByText('混淆弹性与斜率')).toBeInTheDocument()
    expect(within(card).getByText('交叉价格弹性未覆盖')).toBeInTheDocument()
    expect(within(card).getAllByText('已当场修复')).toHaveLength(1)
    expect(within(card).getByText(/数字例子锚定概念/)).toBeInTheDocument()

    await click(within(card).getByRole('button', { name: '确认通过' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    const [sessionId, version, requestId, pass, date] = confirm.mock.calls[0]
    expect(typeof sessionId).toBe('number')
    expect(version).toBe(5) // 4 回合 + 1 评估
    expect(requestId).toBe('verdict')
    expect(pass).toBe(true)
    expect(date).toMatch(DATE_RE)
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/)
  })

  it('重挂载水合:同任务恢复同一会话,已有对话立即可见', async () => {
    const first = await renderFeynman()
    await sendOne('第一轮')
    first.unmount()

    const start = vi.spyOn(backendModule.backend, 'startOrResumeSession')
    await renderFeynman()
    expect(screen.getByText('第一轮')).toBeInTheDocument()
    expect(screen.getByText(/降价反而能增加总收入/)).toBeInTheDocument()
    expect(start).toHaveBeenCalledTimes(1)
    const resumed = await start.mock.results[0].value
    expect(resumed.version).toBe(1)
    const probe = await backendModule.backend.startOrResumeSession(3, 'probe', '2026-09-05')
    expect(probe.sessionId).toBe(resumed.sessionId)
    // 续讲用水合后的版本
    const submit = vi.spyOn(backendModule.backend, 'submitTurn')
    await sendOne('第二轮')
    expect(submit.mock.calls[0][1]).toBe(1)
  })

  it('已评估会话水合:直接出现评估卡,确认带水合版本', async () => {
    hydrateWith({ state: 'evaluated', eval: EVAL, version: 9 })
    const confirm = vi.spyOn(backendModule.backend, 'confirmSessionVerdict')
      .mockResolvedValue({ passed: true, blockStatus: 'passed', taskDone: true, outboxOps: 4, version: 10 })
    await renderFeynman()
    const card = screen.getByRole('dialog', { name: '讲授评估' })
    expect(within(card).getByText('弹性vs斜率')).toBeInTheDocument()
    await click(within(card).getByRole('button', { name: '确认通过' }))
    expect(confirm.mock.calls[0][1]).toBe(9)
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/)
  })

  it('评估中断(evaluating)水合:输入禁用,"继续评估"用同 id 续跑', async () => {
    hydrateWith({ state: 'evaluating', version: 4 })
    const evaluate = vi.spyOn(backendModule.backend, 'requestEvaluation').mockResolvedValue({ eval: EVAL, version: 5 })
    await renderFeynman()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await click(screen.getByRole('button', { name: '继续评估' }))
    expect(evaluate).toHaveBeenCalledWith(expect.any(Number), 'eval')
    expect(screen.getByRole('dialog', { name: '讲授评估' })).toBeInTheDocument()
  })

  it('submitTurn 失败:错误可见可重试、无永久"思考中"、消息保留;重试四个参数与首次完全相同', async () => {
    const submit = vi.spyOn(backendModule.backend, 'submitTurn').mockRejectedValueOnce(retryable('学生走神了'))
    await renderFeynman()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '需求曲线向右下方倾斜' } })
    await click(screen.getByRole('button', { name: '发送' }))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('学生走神了')
    expect(screen.queryByText(/学生思考中/)).not.toBeInTheDocument()
    expect(screen.getByText('需求曲线向右下方倾斜')).toBeInTheDocument()

    await click(within(alert).getByRole('button', { name: '重试' }))
    await act(async () => { vi.advanceTimersByTime(8000) })
    expect(screen.getByText(/降价反而能增加总收入/)).toBeInTheDocument()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('pending 回合水合:显示该消息与"上次发送未完成";重试用原 id 与水合版本', async () => {
    hydrateWith({
      version: 2,
      transcript: [
        { role: 'user', text: '早先的一轮', status: 'done', clientTurnId: 'turn-0', readyToEnd: false },
        { role: 'student', text: '为什么?', status: 'done', clientTurnId: null, readyToEnd: false },
        { role: 'user', text: '上次讲到一半', status: 'pending', clientTurnId: 'turn-x', readyToEnd: false },
      ],
    })
    const submit = vi.spyOn(backendModule.backend, 'submitTurn')
      .mockResolvedValue({ studentText: '接着讲', readyToEnd: false, version: 3 } satisfies TurnResult)
    await renderFeynman()
    expect(screen.getByText('上次讲到一半')).toBeInTheDocument()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('上次发送未完成')
    expect(screen.getByRole('textbox')).toBeDisabled()

    await click(within(alert).getByRole('button', { name: '重试' }))
    expect(submit).toHaveBeenCalledWith(expect.any(Number), 2, 'turn-x', '上次讲到一半')
    await act(async () => { vi.advanceTimersByTime(8000) })
    expect(screen.getByText('接着讲')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeEnabled()
  })

  it('版本冲突(不可重试):错误可见、无重试按钮、输入框仍可用', async () => {
    vi.spyOn(backendModule.backend, 'submitTurn').mockRejectedValueOnce(fatal('会话版本已变化,请刷新'))
    await renderFeynman()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })
    await click(screen.getByRole('button', { name: '发送' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('会话版本已变化')
    expect(within(alert).queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeEnabled()
  })

  it('放弃:abandonSession(sessionId, 当前版本) 后回今日', async () => {
    const abandon = vi.spyOn(backendModule.backend, 'abandonSession')
    const confirm = vi.spyOn(backendModule.backend, 'confirmSessionVerdict')
    await renderFeynman()
    await sendOne('一轮')
    await click(screen.getByRole('button', { name: '放弃本次' }))
    const dialog = screen.getByRole('dialog', { name: '放弃这次讲授?' })
    await click(within(dialog).getByRole('button', { name: '放弃' }))
    expect(abandon).toHaveBeenCalledWith(expect.any(Number), 1)
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/)
  })

  it('放弃失败:留在页面、错误可见可重试', async () => {
    const abandon = vi.spyOn(backendModule.backend, 'abandonSession').mockRejectedValueOnce(retryable('放弃未保存'))
    await renderFeynman()
    await click(screen.getByRole('button', { name: '放弃本次' }))
    await click(within(screen.getByRole('dialog', { name: '放弃这次讲授?' })).getByRole('button', { name: '放弃' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('放弃未保存')
    expect(screen.getByTestId('loc')).toHaveTextContent('/feynman/3')
    await click(within(alert).getByRole('button', { name: '重试' }))
    expect(abandon).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/)
  })

  it('"回读原文"跳 /reader/:blockId?back=<taskId>', async () => {
    await renderFeynman()
    await click(screen.getByRole('button', { name: '回读原文' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/reader/4?back=3')
  })

  it('初始化失败可重试;startOrResumeSession 幂等,重试沿用同一 clientRequestId', async () => {
    const original = backendModule.backend.startOrResumeSession.bind(backendModule.backend)
    const start = vi.spyOn(backendModule.backend, 'startOrResumeSession')
      .mockRejectedValueOnce(retryable('会话启动结果未知'))
      .mockImplementation(original)
    await renderFeynman()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('会话启动结果未知')
    await click(within(alert).getByRole('button', { name: '重试' }))
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls[1][1]).toBe(start.mock.calls[0][1])
    expect(screen.getByRole('textbox')).toBeEnabled()
  })

  it('todayQueue 初始化失败显示安全返回态且不启动会话', async () => {
    const start = vi.spyOn(backendModule.backend, 'startOrResumeSession')
    vi.spyOn(backendModule.backend, 'todayQueue').mockRejectedValue(retryable('今日任务暂时不可用'))
    await renderFeynman()
    expect(screen.getByRole('alert')).toHaveTextContent('今日任务暂时不可用')
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '返回今日' })).toBeEnabled()
    expect(start).not.toHaveBeenCalled()
  })

  it('getBlock/blockSource 初始化失败不调用后续步骤', async () => {
    const blockSource = vi.spyOn(backendModule.backend, 'blockSource')
    const start = vi.spyOn(backendModule.backend, 'startOrResumeSession')
    vi.spyOn(backendModule.backend, 'getBlock').mockRejectedValue(new BackendError({
      code: 'not_found', message: '知识块不存在', retryable: false,
    }))
    await renderFeynman()
    expect(screen.getByRole('alert')).toHaveTextContent('知识块不存在')
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(blockSource).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('会话启动进行中不提供重复启动入口,卸载后失败被忽略', async () => {
    const attempt = deferred<SessionView>()
    const start = vi.spyOn(backendModule.backend, 'startOrResumeSession').mockReturnValue(attempt.promise)
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')
    const view = await renderFeynman()
    expect(start).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    view.unmount()
    await act(async () => attempt.reject(retryable('卸载后的启动失败')))
    expect(start).toHaveBeenCalledTimes(1)
    expect(normalize).not.toHaveBeenCalled()
  })
})

describe('写操作错误隔离(契约 v2)', () => {
  it('submitTurn 进行中再点发送不会产生第二次调用', async () => {
    const pending = deferred<TurnResult>()
    const submit = vi.spyOn(backendModule.backend, 'submitTurn').mockReturnValue(pending.promise)
    await renderFeynman()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '第一段' } })
    await click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByText(/学生思考中/)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(submit).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ studentText: '哦', readyToEnd: false, version: 1 }))
  })

  it('requestEvaluation 失败:错误显示、"结束讲授"可重试、不导航;重试成功出现评估卡', async () => {
    vi.spyOn(backendModule.backend, 'requestEvaluation').mockRejectedValueOnce(retryable('评估服务暂不可用'))
    await renderFeynman()
    await sendOne('一轮')
    await click(screen.getByRole('button', { name: '结束讲授' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('评估服务暂不可用')
    expect(screen.queryByRole('dialog', { name: '讲授评估' })).not.toBeInTheDocument()
    expect(screen.getByTestId('loc')).toHaveTextContent('/feynman/3')
    expect(screen.getByRole('button', { name: '结束讲授' })).toBeEnabled()
    await click(within(alert).getByRole('button', { name: '重试' }))
    expect(screen.getByRole('dialog', { name: '讲授评估' })).toBeInTheDocument()
  })

  it('confirmSessionVerdict 失败:错误在评估卡内、不导航;不可重试则禁用确认', async () => {
    const confirm = vi.spyOn(backendModule.backend, 'confirmSessionVerdict')
      .mockRejectedValueOnce(retryable('判定写入超时'))
      .mockRejectedValueOnce(fatal('判定与服务端状态冲突'))
    await renderFeynman()
    await sendOne('一轮')
    await click(screen.getByRole('button', { name: '结束讲授' }))
    const card = screen.getByRole('dialog', { name: '讲授评估' })

    await click(within(card).getByRole('button', { name: '确认通过' }))
    expect(within(card).getByRole('alert')).toHaveTextContent('判定写入超时')
    expect(screen.getByTestId('loc')).toHaveTextContent('/feynman/3')
    expect(within(card).getByRole('button', { name: '确认通过' })).toBeEnabled()

    await click(within(card).getByRole('button', { name: '重试' }))
    expect(within(card).getByRole('alert')).toHaveTextContent('判定与服务端状态冲突')
    expect(within(card).getByRole('button', { name: '确认暂不可用' })).toBeDisabled()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1]).toEqual(confirm.mock.calls[0])
  })

  it('卸载后晚到的学生回复不再处理(无 setState、不归一化)', async () => {
    const pending = deferred<TurnResult>()
    vi.spyOn(backendModule.backend, 'submitTurn').mockReturnValue(pending.promise)
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = await renderFeynman()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '讲一段' } })
    await click(screen.getByRole('button', { name: '发送' }))
    view.unmount()
    await act(async () => pending.reject(retryable('晚到失败')))
    expect(normalize).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('写操作进行中"放弃本次"被禁用', async () => {
    const pending = deferred<TurnResult>()
    vi.spyOn(backendModule.backend, 'submitTurn').mockReturnValue(pending.promise)
    await renderFeynman()
    expect(screen.getByRole('button', { name: '放弃本次' })).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '讲一段' } })
    await click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByRole('button', { name: '放弃本次' })).toBeDisabled()
    await act(async () => pending.resolve({ studentText: '哦', readyToEnd: false, version: 1 }))
    await act(async () => { vi.advanceTimersByTime(8000) })
    expect(screen.getByRole('button', { name: '放弃本次' })).toBeEnabled()
  })
})
