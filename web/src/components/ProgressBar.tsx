/**
 * 进度条(视觉改版第二批):`value` 0–1 为定值;null/undefined 为不定(条纹往返);
 * `role=progressbar` + aria-valuenow(百分比)。
 */
export default function ProgressBar({
  value,
  label,
  tone = 'accent',
  size = 'md',
  className = '',
}: {
  value?: number | null
  label?: string
  tone?: 'accent' | 'ok' | 'review'
  /** sm:4px(阅读器页脚);md:6px */
  size?: 'sm' | 'md'
  className?: string
}) {
  const determinate = typeof value === 'number' && Number.isFinite(value)
  const pct = determinate ? Math.round(Math.max(0, Math.min(1, value)) * 100) : undefined
  const fill = tone === 'ok' ? 'bg-ok' : tone === 'review' ? 'bg-review' : 'bg-accent'
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={`relative w-full overflow-hidden rounded-full bg-inset ${size === 'sm' ? 'h-1' : 'h-1.5'} ${className}`}
    >
      {determinate ? (
        <div className={`h-full rounded-full transition-[width] duration-[var(--dur-slow)] ${fill}`} style={{ width: `${pct}%` }} />
      ) : (
        <div className={`bl-indeterminate absolute inset-y-0 w-1/3 rounded-full ${fill}`} />
      )}
    </div>
  )
}
