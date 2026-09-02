import type { BackendError } from '../backend/errors'
import Button from './Button'

type Variant = 'compact' | 'full'

export default function AsyncError({
  error,
  onRetry,
  variant = 'full',
}: {
  error: BackendError
  onRetry?: () => void
  variant?: Variant
}) {
  return (
    <div
      role="alert"
      className={variant === 'compact'
        ? 'flex items-center gap-3 text-sm text-weak'
        : 'flex items-center justify-between gap-4 rounded-l border border-line bg-paper-2 p-4 text-sm text-weak'}
    >
      <span>{error.message}</span>
      {error.retryable && onRetry && (
        <Button type="button" className="shrink-0" onClick={onRetry}>重试</Button>
      )}
    </div>
  )
}
