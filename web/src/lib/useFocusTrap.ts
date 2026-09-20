import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => !el.hasAttribute('aria-hidden'))
}

/**
 * 焦点陷阱(视觉改版第一批):`active` 时把焦点移进容器(优先 `[data-autofocus]`,其次 `initialFocus`,
 * 否则容器本身——读屏先读到标题,再 Tab 进第一个控件),Tab/Shift+Tab 在容器内循环;失活时把焦点还给打开前的元素。
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  initialFocus?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const previous = document.activeElement as HTMLElement | null
    const first = container.querySelector<HTMLElement>('[data-autofocus]') ?? initialFocus?.current ?? container
    first.focus({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = focusables(container)
      if (items.length === 0) {
        e.preventDefault()
        container.focus()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const current = document.activeElement
      if (e.shiftKey && (current === firstItem || current === container)) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && current === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }
    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus({ preventScroll: true })
    }
  }, [containerRef, active, initialFocus])
}
