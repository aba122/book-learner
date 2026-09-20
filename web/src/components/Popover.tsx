import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../lib/useFocusTrap'

interface Props {
  open: boolean
  onClose: () => void
  anchor: HTMLElement | null
  'aria-label': string
  placement?: 'bottom-start' | 'bottom-end'
  className?: string
  children: ReactNode
  'data-testid'?: string
}

/**
 * 浮层(视觉改版第二批,无第三方库):非模态锚定面板(`role=dialog aria-modal=false`),
 * Esc / 外点关闭,焦点进面板(Tab 循环)、关闭后回锚定钮。用于阅读设置、目录、番茄钟错误等小任务。
 */
export default function Popover({ open, onClose, anchor, 'aria-label': ariaLabel, placement = 'bottom-start', className = '', children, 'data-testid': testId }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useFocusTrap(panelRef, open)

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const r = anchor.getBoundingClientRect()
    const w = panelRef.current?.offsetWidth ?? 280
    let left = placement === 'bottom-end' ? r.right - w : r.left
    left = Math.min(Math.max(8, left), window.innerWidth - 8 - w)
    setPos({ left, top: r.bottom + 6 })
  }, [open, anchor, placement])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [open, onClose, anchor])

  if (!open || !anchor) return null
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel}
      tabIndex={-1}
      data-testid={testId}
      className={`bl-pop fixed z-popover max-h-[70vh] overflow-y-auto rounded-m bg-popover p-3 shadow-popover ring-1 ring-sep/60 outline-none ${className}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {children}
    </div>,
    document.body,
  )
}
