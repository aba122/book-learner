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
      className="bl-pop pointer-events-auto flex max-w-sm cursor-pointer items-center gap-3 rounded-m bg-label-1 px-3.5 py-2.5 text-on-ink shadow-popover"
      onClick={() => dismissToast(item.id)}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body font-medium">{item.message}</span>
        {item.description && <span className="text-footnote opacity-80">{item.description}</span>}
      </span>
      {item.action && (
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-s bg-on-ink/15 px-2 py-1 text-callout font-semibold text-on-ink hover:bg-on-ink/25"
          onClick={e => {
            e.stopPropagation()
            dismissToast(item.id)
            item.action?.onSelect()
          }}
        >
          {item.action.label}
        </button>
      )}
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
