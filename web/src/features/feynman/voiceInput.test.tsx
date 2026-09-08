import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureFn, Recorder } from '../../audio/pcm'
import * as backendModule from '../../backend'
import { BackendError } from '../../backend/errors'
import { MockBackend } from '../../backend/mock'
import type { Backend } from '../../backend/types'
import VoiceInput from './VoiceInput'
import { describeVoiceError } from './voiceSupport'

vi.mock('../../backend', () => ({ backend: null as unknown as object }))

let mock: MockBackend
beforeEach(() => {
  mock = new MockBackend()
  ;(backendModule as unknown as { backend: Backend }).backend = mock
})
afterEach(() => {
  vi.restoreAllMocks()
})

function fakeCapture(pcm: Int16Array): { capture: CaptureFn; cancelled: () => boolean; options: () => Parameters<CaptureFn>[0] | null } {
  let cancelled = false
  let received: Parameters<CaptureFn>[0] | null = null
  const capture: CaptureFn = async options => {
    received = options
    options.onLevel?.(0.2)
    const recorder: Recorder = {
      stop: async () => pcm,
      cancel: () => {
        cancelled = true
      },
    }
    return recorder
  }
  return { capture, cancelled: () => cancelled, options: () => received }
}

describe('语音输入(M3 T3)', () => {
  it('点击开始 → 录音态(停止/取消) → 停止后转写,文本经 onText 填入并提示可编辑', async () => {
    const onText = vi.fn()
    const pcm = new Int16Array(16_000 * 3)
    const { capture, options } = fakeCapture(pcm)
    const spy = vi.spyOn(mock, 'voiceTranscribe')
    render(<VoiceInput hint="需求弹性" onText={onText} capture={capture} />)
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const stop = await screen.findByRole('button', { name: '停止录音' })
    expect(screen.getByTestId('voice-input')).toHaveAttribute('data-phase', 'recording')
    expect(screen.getByTestId('voice-level').style.width).toBe('80%')
    expect(options()?.deviceId).toBeNull()
    fireEvent.click(stop)
    expect(screen.getByRole('button', { name: '转写中' })).toBeDisabled()
    await waitFor(() => expect(onText).toHaveBeenCalledTimes(1))
    expect(spy).toHaveBeenCalledWith(pcm, 'zh', '需求弹性')
    expect(onText.mock.calls[0][0]).toContain('需求弹性')
    expect(screen.getByRole('status').textContent).toContain('3.0 秒语音')
    expect(screen.getByRole('button', { name: '语音输入' })).toBeEnabled()
  })

  it('取消录音不转写;权限被拒绝给出系统设置指引;后端错误原样展示', async () => {
    const onText = vi.fn()
    const { capture, cancelled } = fakeCapture(new Int16Array(16))
    const spy = vi.spyOn(mock, 'voiceTranscribe')
    const { unmount } = render(<VoiceInput hint="x" onText={onText} capture={capture} />)
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    expect(cancelled()).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '语音输入' })).toBeInTheDocument()
    unmount()

    const denied: CaptureFn = async () => {
      throw new DOMException('denied', 'NotAllowedError')
    }
    render(<VoiceInput hint="x" onText={onText} capture={denied} />)
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    expect((await screen.findByRole('alert')).textContent).toContain('系统设置')
    expect(onText).not.toHaveBeenCalled()
  })

  it('没有可用模型时转写报错并可重试;自动停止回调触发转写', async () => {
    await mock.voiceDeleteModel('small')
    const onText = vi.fn()
    let autoStop: (() => void) | undefined
    const capture: CaptureFn = async options => {
      autoStop = options.onAutoStop
      return { stop: async () => new Int16Array(16_000), cancel: () => {} }
    }
    render(<VoiceInput hint="x" onText={onText} capture={capture} />)
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByRole('button', { name: '停止录音' })
    await act(async () => {
      autoStop?.()
    })
    expect((await screen.findByRole('alert')).textContent).toContain('模型')
    expect(onText).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '语音输入' })).toBeEnabled()
  })

  it('describeVoiceError 覆盖常见错误名', () => {
    expect(describeVoiceError(new DOMException('x', 'NotFoundError'))).toContain('麦克风')
    expect(describeVoiceError(new DOMException('x', 'NotReadableError'))).toContain('占用')
    expect(describeVoiceError(new BackendError({ code: 'internal', message: '应用内部错误', retryable: false }))).toBe('应用内部错误')
    expect(describeVoiceError(new Error('boom'))).toBe('boom')
    expect(describeVoiceError(null)).toBe('录音失败,请重试。')
  })
})
