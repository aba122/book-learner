import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import * as errorModule from '../../backend/errors'
import { BackendError } from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import type { AppSettings } from '../../types'
import SettingsPage from './SettingsPage'

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

describe('设置页', () => {
  it('表单显示 getSettings 的当前值', async () => {
    render(<SettingsPage />)
    expect(await screen.findByLabelText('番茄钟(分钟)')).toHaveValue(25)
    expect(screen.getByLabelText('休息(分钟)')).toHaveValue(5)
    expect(screen.getByLabelText('提醒时间')).toHaveValue('21:00')
    expect(screen.getByLabelText('Obsidian 仓库路径')).toHaveValue('~/Obsidian/book-learner')
  })

  it('修改番茄钟分钟并保存:saveSettings 收到新值并提示已保存', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(backendModule.backend, 'saveSettings')
    render(<SettingsPage />)
    const pomo = await screen.findByLabelText('番茄钟(分钟)')
    await user.clear(pomo)
    await user.type(pomo, '30')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(spy).toHaveBeenCalledWith({
      obsidianVault: '~/Obsidian/book-learner',
      pomodoroMinutes: 30,
      breakMinutes: 5,
      remindTime: '21:00',
    })
    expect(await screen.findByText('已保存')).toBeInTheDocument()
  })

  it('不可重试的设置加载失败不显示空表单', async () => {
    vi.spyOn(backendModule.backend, 'getSettings').mockRejectedValue(new BackendError({
      code: 'not_implemented',
      message: '原生设置暂未实现',
      retryable: false,
    }))

    render(<SettingsPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('原生设置暂未实现')
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('番茄钟(分钟)')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('可重试的设置加载失败可独立恢复表单', async () => {
    const user = userEvent.setup()
    const load = vi.spyOn(backendModule.backend, 'getSettings').mockRejectedValueOnce(new BackendError({
      code: 'offline',
      message: '设置加载失败',
      retryable: true,
    }))
    const save = vi.spyOn(backendModule.backend, 'saveSettings')

    render(<SettingsPage />)
    await user.click(await screen.findByRole('button', { name: '重试' }))

    expect(await screen.findByLabelText('番茄钟(分钟)')).toHaveValue(25)
    expect(load).toHaveBeenCalledTimes(2)
    expect(save).not.toHaveBeenCalled()
  })

  it('保存失败保留编辑值，重试使用当前快照并清除旧错误', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(backendModule.backend, 'saveSettings').mockRejectedValueOnce(new BackendError({
      code: 'busy',
      message: '设置保存失败',
      retryable: true,
    }))

    render(<SettingsPage />)
    const pomo = await screen.findByLabelText('番茄钟(分钟)')
    await user.clear(pomo)
    await user.type(pomo, '30')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('设置保存失败')
    expect(pomo).toHaveValue(30)

    const rest = screen.getByLabelText('休息(分钟)')
    await user.clear(rest)
    await user.type(rest, '10')
    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(save).toHaveBeenNthCalledWith(1, {
      obsidianVault: '~/Obsidian/book-learner',
      pomodoroMinutes: 30,
      breakMinutes: 5,
      remindTime: '21:00',
    })
    expect(save).toHaveBeenNthCalledWith(2, {
      obsidianVault: '~/Obsidian/book-learner',
      pomodoroMinutes: 30,
      breakMinutes: 10,
      remindTime: '21:00',
    })
    expect(await screen.findByText('已保存')).toBeInTheDocument()
    expect(screen.queryByText('设置保存失败')).not.toBeInTheDocument()
  })

  it('不可重试的保存失败保留表单且不提供重试', async () => {
    const user = userEvent.setup()
    vi.spyOn(backendModule.backend, 'saveSettings').mockRejectedValue(new BackendError({
      code: 'invalid_settings',
      message: '设置值无效',
      retryable: false,
    }))

    render(<SettingsPage />)
    const vault = await screen.findByLabelText('Obsidian 仓库路径')
    await user.clear(vault)
    await user.type(vault, '/tmp/my-vault')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('设置值无效')
    expect(vault).toHaveValue('/tmp/my-vault')
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })

  it('写入在途时同步阻止重复保存', async () => {
    const user = userEvent.setup()
    const attempt = deferred<void>()
    const save = vi.spyOn(backendModule.backend, 'saveSettings').mockReturnValue(attempt.promise)

    render(<SettingsPage />)
    await screen.findByLabelText('番茄钟(分钟)')
    const saveButton = screen.getByRole('button', { name: '保存' })
    fireEvent.click(saveButton)
    fireEvent.click(saveButton)

    expect(save).toHaveBeenCalledTimes(1)
    expect(saveButton).toBeDisabled()
    await act(async () => attempt.resolve())
    expect(await screen.findByText('已保存')).toBeInTheDocument()
    expect(saveButton).not.toBeDisabled()
    await user.click(saveButton)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('较晚到达的旧加载失败不会覆盖较新设置', async () => {
    const olderAttempt = deferred<AppSettings>()
    const newerAttempt = deferred<AppSettings>()
    const load = vi.spyOn(backendModule.backend, 'getSettings')
      .mockReturnValueOnce(olderAttempt.promise)
      .mockReturnValueOnce(newerAttempt.promise)

    render(<StrictMode><SettingsPage /></StrictMode>)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await act(async () => newerAttempt.resolve({
      obsidianVault: '/new-vault',
      pomodoroMinutes: 45,
      breakMinutes: 8,
      remindTime: '20:30',
    }))
    expect(await screen.findByLabelText('番茄钟(分钟)')).toHaveValue(45)
    await act(async () => olderAttempt.reject(new BackendError({
      code: 'offline',
      message: '过期设置失败',
      retryable: true,
    })))

    expect(screen.queryByText('过期设置失败')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Obsidian 仓库路径')).toHaveValue('/new-vault')
  })

  it('较晚到达的旧加载成功不会恢复过期设置', async () => {
    const olderAttempt = deferred<AppSettings>()
    const newerAttempt = deferred<AppSettings>()
    const load = vi.spyOn(backendModule.backend, 'getSettings')
      .mockReturnValueOnce(olderAttempt.promise)
      .mockReturnValueOnce(newerAttempt.promise)

    render(<StrictMode><SettingsPage /></StrictMode>)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await act(async () => newerAttempt.resolve({
      obsidianVault: '/new-vault',
      pomodoroMinutes: 45,
      breakMinutes: 8,
      remindTime: '20:30',
    }))
    expect(await screen.findByLabelText('番茄钟(分钟)')).toHaveValue(45)
    await act(async () => olderAttempt.resolve({
      obsidianVault: '/old-vault',
      pomodoroMinutes: 10,
      breakMinutes: 2,
      remindTime: '08:00',
    }))

    expect(screen.getByLabelText('番茄钟(分钟)')).toHaveValue(45)
    expect(screen.getByLabelText('Obsidian 仓库路径')).toHaveValue('/new-vault')
  })

  it('卸载后到达的加载失败不再归一化或更新页面', async () => {
    const attempt = deferred<AppSettings>()
    vi.spyOn(backendModule.backend, 'getSettings').mockReturnValue(attempt.promise)
    const normalize = vi.spyOn(errorModule, 'normalizeBackendError')
    const { unmount } = render(<SettingsPage />)

    unmount()
    await act(async () => attempt.reject(new BackendError({
      code: 'offline',
      message: '过期加载失败',
      retryable: true,
    })))

    expect(normalize).not.toHaveBeenCalled()
  })
})
