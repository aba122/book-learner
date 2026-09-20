import { useId, type ReactNode } from 'react'

export interface FieldControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

/**
 * 表单行(视觉改版第一批):`row` = 标签左、控件右(macOS 设置行,最小高 44);`stack` = 标签在上。
 * id 由 useId 生成(不再用中文标签拼 id);hint/error 经 aria-describedby 关联,error 带 role=alert。
 */
export default function Field({
  label,
  hint,
  error,
  layout = 'row',
  className = '',
  children,
}: {
  label: string
  hint?: string
  error?: string
  layout?: 'row' | 'stack'
  className?: string
  children: (ctl: FieldControlProps) => ReactNode
}) {
  const id = useId()
  const hintId = useId()
  const errId = useId()
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
  const ctl: FieldControlProps = { id, 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': true as const } : {}) }
  const notes = (
    <>
      {hint && !error && (
        <p id={hintId} className="text-footnote text-label-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="text-footnote text-weak">
          {error}
        </p>
      )}
    </>
  )
  if (layout === 'stack') {
    return (
      <div className={`flex flex-col gap-1.5 ${className}`}>
        <label htmlFor={id} className="text-body font-medium text-label-1">
          {label}
        </label>
        {children(ctl)}
        {notes}
      </div>
    )
  }
  return (
    <div className={`flex min-h-11 items-center justify-between gap-6 py-2 ${className}`}>
      <label htmlFor={id} className="text-body text-label-1">
        {label}
      </label>
      <div className="flex flex-col items-end gap-1">
        {children(ctl)}
        {notes}
      </div>
    </div>
  )
}
