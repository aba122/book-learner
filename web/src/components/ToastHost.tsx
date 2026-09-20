import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { dismissToast, getToasts, subscribeToasts, type ToastItem } from '../lib/toastStore'

function Toast({ item }: { item: ToastItem }) {
  useEffect(() => {
    const t = setTimeout(() => dismissToast(item.id), item.duration)
    return () => clearTimeout(t)
  }, [item.id, item.duration])
  return (
    <div
      role="status"
      className="bl-pop pointer-events-auto flex max-w-sm cursor-pointer flex-col gap-0.5 rounded-m bg-label-1 px-3.5 py-2.5 text-on-ink shadow-popover"
      onClick={() => dismissToast(item.id)}
    >
      <span className="text-body font-medium">{item.message}</span>
      {item.description && <span className="text-footnote opacity-80">{item.description}</span>}
    </div>
  )
}

/** 提示主机:挂在需要的页面里;无条目时不渲染任何 DOM */
export default function ToastHost() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  if (items.length === 0) return null
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-toast flex flex-col items-center gap-2">
      {items.map(item => (
        <Toast key={item.id} item={item} />
      ))}
    </div>,
    document.body,
  )
}
