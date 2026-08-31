import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendModule from '../../backend'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import SettingsPage from './SettingsPage'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

beforeEach(() => {
  ;(backendModule as unknown as { backend: Backend }).backend = new MockBackend()
})

afterEach(() => {
  vi.restoreAllMocks()
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
    })
    expect(await screen.findByText('已保存')).toBeInTheDocument()
  })
})
