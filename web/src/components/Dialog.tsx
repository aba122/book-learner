import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { popModal, pushModal } from '../lib/modalStack'
import { useFocusTrap } from '../lib/useFocusTrap'
import IconButton from './IconButton'

type Size = 'sm' | 'md' | 'lg' | 'xl'
const WIDTH: Record<Size, string> = {
  sm: 'w-[352px]',
  md: 'w-[440px]',
  lg: 'w-[520px]',
  xl: 'w-[600px]',
}

export interface DialogProps {
  open: boolean
  title: string
  /** 可访问名固定值(标题随阶段变化时用;默认 = title) */
  label?: string
  description?: string
  size?: Size
  /** false:无 Esc、无遮罩点击、无关闭钮(忙态/必须做出选择时) */
  dismissible?: boolean
  /** 头部 × 关闭钮(页脚已有取消/关闭时可关掉,避免重名) */
  closeButton?: boolean
  onClose?: () => void
  initialFocus?: RefObject<HTMLElement | null>
  footer?: ReactNode
  children?: ReactNode
  className?: string
  'data-testid'?: string
}

/**
 * 对话框原语(视觉改版第一批):portal 到 body;`role=dialog aria-modal aria-labelledby`;
 * 焦点进面板、Tab 循环、Esc 关闭(仅 dismissible)、关闭后焦点还原;打开期间 <html> 带 `data-modal-open`。
 */
export default function Dialog({
  open,
  title,
  label,
  description,
  size = 'md',
  dismissible = true,
  closeButton = true,
  onClose,
  initialFocus,
  footer,
  children,
  className = '',
  'data-testid': testId,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  useFocusTrap(panelRef, open, initialFocus)

  useEffect(() => {
    if (!open) return
    pushModal()
    return () => popModal()
  }, [open])

  useEffect(() => {
    if (!open || !dismissible || !onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, dismissible, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-dialog flex items-center justify-center p-8">
      <div aria-hidden className="bl-fade absolute inset-0 bg-scrim" onClick={dismissible ? onClose : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? title}
        aria-labelledby={label ? undefined : titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        data-testid={testId}
        className={`bl-pop relative flex max-h-[calc(100vh-6rem)] max-w-[calc(100vw-4rem)] flex-col rounded-l bg-card shadow-sheet ring-1 ring-sep/60 outline-none ${WIDTH[size]} ${className}`}
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="font-serif text-title2 font-semibold text-label-1">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-callout leading-relaxed text-label-2">
                {description}
              </p>
            )}
          </div>
          {dismissible && closeButton && onClose && <IconButton icon="xmark" label="关闭" onClick={onClose} className="-mr-2 -mt-1" />}
        </header>
        {children ? <div className="min-h-0 overflow-y-auto px-6 py-4">{children}</div> : <div className="h-4" />}
        {footer && <footer className="flex justify-end gap-2 px-6 pb-5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
