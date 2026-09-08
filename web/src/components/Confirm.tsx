import type { ReactNode } from 'react'
import Button from './Button'
import Card from './Card'

export default function Confirm({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  confirmDisabled = false,
  cancelDisabled = false,
  children,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  confirmDisabled?: boolean
  cancelDisabled?: boolean
  children?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-ink-1/25" onClick={onCancel} />
      <Card className="relative w-88 max-w-[90vw] p-6 shadow-pop">
        <h2 className="font-serif text-lg font-semibold text-ink-1">{title}</h2>
        {message && <p className="mt-2 text-sm leading-relaxed text-ink-2">{message}</p>}
        {children}
        <div className="mt-6 flex justify-end gap-2">
          <Button disabled={cancelDisabled} onClick={onCancel}>{cancelText}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </div>
      </Card>
    </div>
  )
}
