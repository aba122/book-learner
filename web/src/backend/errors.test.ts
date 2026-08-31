import { describe, expect, it } from 'vitest'
import { BackendError, isBackendError, normalizeBackendError } from './errors'

describe('BackendError', () => {
  it('preserves a structured invoke rejection', () => {
    const rejection = {
      code: 'not_implemented',
      message: '此功能暂不可用',
      retryable: false,
      details: { command: 'import_epub' },
    }

    const error = normalizeBackendError(rejection)

    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject(rejection)
    expect(error.name).toBe('BackendError')
    expect(isBackendError(error)).toBe(true)
    expect(isBackendError(error, 'not_implemented')).toBe(true)
    expect(isBackendError(error, 'unknown')).toBe(false)
  })

  it('normalizes a plain string rejection', () => {
    expect(normalizeBackendError('连接已断开')).toMatchObject({
      code: 'unknown',
      message: '连接已断开',
      retryable: false,
    })
  })

  it('normalizes a native Error and keeps it as details', () => {
    const cause = new Error('network failed')

    expect(normalizeBackendError(cause)).toMatchObject({
      code: 'unknown',
      message: 'network failed',
      retryable: false,
      details: cause,
    })
  })

  it('normalizes an unknown rejection without losing its value', () => {
    const rejection = { reason: 42 }

    expect(normalizeBackendError(rejection)).toMatchObject({
      code: 'unknown',
      message: '未知后端错误',
      retryable: false,
      details: rejection,
    })
    expect(isBackendError(rejection)).toBe(false)
  })

  it('keeps an existing BackendError instance', () => {
    const existing = new BackendError({
      code: 'busy',
      message: '请稍后再试',
      retryable: true,
      details: { waitSeconds: 1 },
    })

    expect(normalizeBackendError(existing)).toBe(existing)
  })
})
