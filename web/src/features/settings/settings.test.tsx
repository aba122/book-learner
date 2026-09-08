import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

describe('设置页 · codex 路径(M3 T6)', () => {
  it('显示当前解析到的路径;保存绝对路径后生效,相对路径报错,清空恢复自动寻找', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    const input = await screen.findByLabelText('codex 可执行路径')
    expect(await screen.findByText('当前使用 /opt/homebrew/bin/codex')).toHaveAttribute('data-testid', 'codex-status')
    expect(screen.getByRole('button', { name: '保存路径' })).toBeDisabled()
    await user.type(input, 'codex')
    await user.click(screen.getByRole('button', { name: '保存路径' }))
    expect((await screen.findByText('设置中的 codex 路径必须是绝对路径')).closest('[role=alert]')).toBeTruthy()
    await user.clear(input)
    await user.type(input, '/usr/local/bin/codex')
    await user.click(screen.getByRole('button', { name: '保存路径' }))
    expect(await screen.findByText('当前使用 /usr/local/bin/codex')).toBeInTheDocument()
    expect(input).toHaveValue('/usr/local/bin/codex')
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: '保存路径' }))
    expect(await screen.findByText('当前使用 /opt/homebrew/bin/codex')).toBeInTheDocument()
  })
})

describe('设置页 · 语音(M3 T3)', () => {
  it('列出 whisper 模型(已导入者可选/可删),按路径导入后出现并可切换,删除经确认', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    const list = await screen.findByRole('list', { name: 'whisper 模型' })
    expect(within(list).getAllByTestId('voice-model-row')).toHaveLength(3)
    expect(within(list).getByRole('radio', { name: '使用 small' })).toBeChecked()
    expect(within(list).getByRole('radio', { name: '使用 base' })).toBeDisabled()
    expect(within(list).queryByRole('button', { name: '删除模型 base' })).toBeNull()

    await user.type(screen.getByLabelText('模型文件路径'), '~/Downloads/ggml-large-v3-turbo-q5_0.bin')
    await user.click(screen.getByRole('button', { name: '导入路径' }))
    await waitFor(() => expect(within(list).getByRole('radio', { name: '使用 large-v3-turbo-q5_0' })).toBeEnabled())
    expect(screen.getByLabelText('模型文件路径')).toHaveValue('')
    await user.click(within(list).getByRole('radio', { name: '使用 large-v3-turbo-q5_0' }))
    await waitFor(() => expect(within(list).getByRole('radio', { name: '使用 large-v3-turbo-q5_0' })).toBeChecked())
    expect(within(list).getByRole('radio', { name: '使用 small' })).not.toBeChecked()

    await user.click(within(list).getByRole('button', { name: '删除模型 small' }))
    await user.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(within(list).getByRole('radio', { name: '使用 small' })).toBeDisabled())
    expect(within(list).getAllByText('未导入')).toHaveLength(2)
  })

  it('导入非法文件名展示后端错误;选择文件被取消不报错', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await screen.findByRole('list', { name: 'whisper 模型' })
    await user.type(screen.getByLabelText('模型文件路径'), '/tmp/model.bin')
    await user.click(screen.getByRole('button', { name: '导入路径' }))
    expect((await screen.findByText('模型文件名必须形如 ggml-<名称>.bin')).closest('[role=alert]')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '选择文件…' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '选择文件…' })).toBeEnabled())
    expect(screen.getByLabelText('输入设备')).toHaveValue('')
  })
})

describe('设置页 · 学习者画像(M2 T6)', () => {
  it('展示画像四节:知识背景/个人情境可编辑,已掌握/误区只读', async () => {
    render(<SettingsPage />)
    expect(await screen.findByLabelText('知识背景')).toHaveValue('经济学本科,读过曼昆《经济学原理》')
    expect(screen.getByLabelText('个人情境')).toHaveValue('在做平台定价的研究,想把弹性分析用到实验设计上')
    expect(screen.getByText('- 容易把弹性和斜率混为一谈')).toBeInTheDocument()
    expect(screen.getByText('- 供需曲线与均衡')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '误区模式(AI 观察,只读)' })).toBeNull()
  })

  it('保存画像只提交画像,不触发 saveSettings,并显示已保存', async () => {
    const profileSave = vi.spyOn(MockBackend.prototype, 'profileSave')
    const saveSettings = vi.spyOn(MockBackend.prototype, 'saveSettings')
    render(<SettingsPage />)
    const context = await screen.findByLabelText('个人情境')
    fireEvent.change(context, { target: { value: '准备转做实验经济学' } })
    fireEvent.click(screen.getByRole('button', { name: '保存画像' }))
    await screen.findByText('画像已保存')
    expect(profileSave).toHaveBeenCalledTimes(1)
    expect(profileSave.mock.calls[0][0]).toEqual({
      background: '经济学本科,读过曼昆《经济学原理》',
      mastered: '- 供需曲线与均衡',
      pitfalls: '- 容易把弹性和斜率混为一谈',
      context: '准备转做实验经济学',
    })
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('画像保存失败显示错误并可重试', async () => {
    const profileSave = vi.spyOn(MockBackend.prototype, 'profileSave')
      .mockRejectedValueOnce(new BackendError({ code: 'storage_error', message: '写入 profile.md 失败', retryable: true }))
    render(<SettingsPage />)
    await screen.findByLabelText('个人情境')
    fireEvent.click(screen.getByRole('button', { name: '保存画像' }))
    const alert = (await screen.findByText('写入 profile.md 失败')).closest('[role="alert"]')
    expect(alert).not.toBeNull()
    fireEvent.click(within(alert as HTMLElement).getByRole('button', { name: '重试' }))
    await screen.findByText('画像已保存')
    expect(screen.queryByText('写入 profile.md 失败')).toBeNull()
    expect(profileSave).toHaveBeenCalledTimes(2)
  })

  it('画像读取失败不影响设置表单,且可重试', async () => {
    vi.spyOn(MockBackend.prototype, 'profileGet')
      .mockRejectedValueOnce(new BackendError({ code: 'storage_error', message: '记忆库不可读', retryable: true }))
    render(<SettingsPage />)
    expect(await screen.findByLabelText('番茄钟(分钟)')).toHaveValue(25)
    const alert = (await screen.findByText('记忆库不可读')).closest('[role="alert"]')
    fireEvent.click(within(alert as HTMLElement).getByRole('button', { name: '重试' }))
    expect(await screen.findByLabelText('知识背景')).toHaveValue('经济学本科,读过曼昆《经济学原理》')
  })
})

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
      eveningRemindTime: '22:00',
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
      eveningRemindTime: '22:00',
    })
    expect(save).toHaveBeenNthCalledWith(2, {
      obsidianVault: '~/Obsidian/book-learner',
      pomodoroMinutes: 30,
      breakMinutes: 10,
      remindTime: '21:00',
      eveningRemindTime: '22:00',
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
      eveningRemindTime: '22:00',
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
      eveningRemindTime: '22:00',
    }))
    expect(await screen.findByLabelText('番茄钟(分钟)')).toHaveValue(45)
    await act(async () => olderAttempt.resolve({
      obsidianVault: '/old-vault',
      pomodoroMinutes: 10,
      breakMinutes: 2,
      remindTime: '08:00',
      eveningRemindTime: '22:00',
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

describe('数字输入校验(F10)', () => {
  it('清空番茄钟分钟不会变成 0:显示校验提示、禁用保存、不发请求', async () => {
    const user = userEvent.setup()
    const saveSettings = vi.spyOn(backendModule.backend, 'saveSettings')
    render(<SettingsPage />)
    const pomo = await screen.findByLabelText('番茄钟(分钟)')
    await user.clear(pomo)
    expect(pomo).toHaveValue(null)
    expect(screen.getByRole('alert')).toHaveTextContent('请输入正整数')
    const saveButton = screen.getByRole('button', { name: '保存' })
    expect(saveButton).toBeDisabled()
    fireEvent.click(saveButton)
    expect(saveSettings).not.toHaveBeenCalled()

    await user.type(pomo, '40')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(saveButton).toBeEnabled()
    await user.click(saveButton)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ pomodoroMinutes: 40 }))
  })
})

describe('设置页 · 数据(M3 T5)', () => {
  it('快照清单、立即快照、登记恢复(确认)与取消恢复', async () => {
    const snapshot = vi.spyOn(MockBackend.prototype, 'backupSnapshotNow')
    const restore = vi.spyOn(MockBackend.prototype, 'backupRestore')
    render(<SettingsPage />)
    expect(await screen.findAllByTestId('snapshot-row')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '立即快照' }))
    await waitFor(() => expect(screen.getAllByTestId('snapshot-row')).toHaveLength(2))
    expect(snapshot).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    fireEvent.click(within(screen.getAllByTestId('snapshot-row')[1]).getByRole('button', { name: '恢复' }))
    const dialog = screen.getByRole('dialog', { name: '恢复到这份快照?' })
    expect(dialog).toHaveTextContent('app-2026-09-07.db')
    fireEvent.click(within(dialog).getByRole('button', { name: '登记恢复' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已登记恢复 app-2026-09-07.db')
    expect(restore).toHaveBeenCalledWith('app-2026-09-07.db')
    fireEvent.click(screen.getByRole('button', { name: '取消恢复' }))
    await waitFor(() => expect(screen.queryByText(/已登记恢复/)).toBeNull())
  })

  it('远程 URL 保存并校验,校验失败显示错误;立即推送显示结果', async () => {
    const setRemote = vi.spyOn(MockBackend.prototype, 'gitRemoteSet')
    const push = vi.spyOn(MockBackend.prototype, 'gitPushNow')
    render(<SettingsPage />)
    const input = await screen.findByLabelText('记忆库 git 远程')
    fireEvent.change(input, { target: { value: '-bad url' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并校验' }))
    expect(await screen.findByText('请求内容无效')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'git@example.com:me/memory.git' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并校验' }))
    await waitFor(() => expect(setRemote).toHaveBeenLastCalledWith('git@example.com:me/memory.git'))
    fireEvent.click(screen.getByRole('button', { name: '立即推送' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已推送到远程')
    expect(push).toHaveBeenCalledTimes(1)
  })
})

