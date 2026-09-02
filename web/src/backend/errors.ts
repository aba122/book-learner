export interface BackendErrorOptions {
  code: string
  message: string
  retryable: boolean
  details?: unknown
}

export class BackendError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: unknown

  constructor(options: BackendErrorOptions) {
    super(options.message)
    this.name = 'BackendError'
    this.code = options.code
    this.retryable = options.retryable
    this.details = options.details
  }
}

function isStructuredBackendError(value: unknown): value is BackendErrorOptions {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
    && typeof candidate.retryable === 'boolean'
}

export function normalizeBackendError(value: unknown): BackendError {
  if (value instanceof BackendError) return value
  if (isStructuredBackendError(value)) return new BackendError(value)
  if (typeof value === 'string') {
    return new BackendError({ code: 'unknown', message: value, retryable: false })
  }
  if (value instanceof Error) {
    return new BackendError({
      code: 'unknown',
      message: value.message,
      retryable: false,
      details: value,
    })
  }
  return new BackendError({
    code: 'unknown',
    message: '未知后端错误',
    retryable: false,
    details: value,
  })
}

export function isBackendError(value: unknown, code?: string): value is BackendError {
  return value instanceof BackendError && (code === undefined || value.code === code)
}
