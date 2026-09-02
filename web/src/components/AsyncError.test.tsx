import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BackendError } from '../backend/errors'
import AsyncError from './AsyncError'

describe('AsyncError', () => {
  it('以 alert 显示中文错误消息', () => {
    const error = new BackendError({
      code: 'offline',
      message: '暂时无法连接后端',
      retryable: false,
    })

    render(<AsyncError error={error} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('暂时无法连接后端')
    expect(alert).toHaveClass('rounded-l', 'border', 'border-line', 'bg-paper-2')
  })

  it('可重试错误提供重试操作', async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    const error = new BackendError({
      code: 'busy',
      message: '后端正忙',
      retryable: true,
    })

    render(<AsyncError error={error} onRetry={retry} />)
    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(retry).toHaveBeenCalledOnce()
  })

  it('在表单中重试不会提交表单', async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const error = new BackendError({
      code: 'busy',
      message: '后端正忙',
      retryable: true,
    })

    render(
      <form onSubmit={submit}>
        <AsyncError error={error} onRetry={retry} />
      </form>,
    )
    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(retry).toHaveBeenCalledOnce()
    expect(submit).not.toHaveBeenCalled()
  })

  it('不可重试错误即使收到回调也不显示重试操作', () => {
    const error = new BackendError({
      code: 'not_implemented',
      message: '此功能暂不可用',
      retryable: false,
    })

    render(<AsyncError error={error} onRetry={() => undefined} />)

    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })

  it('可重试错误没有回调时不显示重试操作', () => {
    const error = new BackendError({
      code: 'busy',
      message: '后端正忙',
      retryable: true,
    })

    render(<AsyncError error={error} />)

    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })

  it('compact 变体使用行内紧凑展示', () => {
    const error = new BackendError({
      code: 'offline',
      message: '统计暂不可用',
      retryable: true,
    })

    render(<AsyncError error={error} variant="compact" onRetry={() => undefined} />)

    expect(screen.getByRole('alert')).toHaveClass('flex', 'items-center')
    expect(screen.getByRole('alert')).not.toHaveClass('border', 'bg-paper-2')
  })
})
