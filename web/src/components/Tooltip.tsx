import { useEffect, useId, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

/** 触发元素要接上的属性(render-prop 传入;setAnchor 接到 ref={…}) */
export interface TooltipTriggerProps {
  setAnchor: (el: HTMLElement | null) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onFocus: () => void
  onBlur: () => void
  'aria-describedby'?: string
}

interface Props {
  content: string
  children: (trigger: TooltipTriggerProps) => ReactElement
  placement?: 'top' | 'bottom'
  /** 悬停延时(ms);聚焦即显 */
  delay?: number
}

/**
 * 提示(视觉改版第一批,无第三方库、无 ref):悬停 400ms / 聚焦即显;`role=tooltip` portal 到 body,
 * 可见时经 aria-describedby 关联;Esc、离开、失焦即隐。取代原生 title=。
 */
export default function Tooltip({ content, children, placement = 'top', delay = 400 }: Props) {
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [hovering, setHovering] = useState(false)
  const [hoverReady, setHoverReady] = useState(false)
  const [focused, setFocused] = useState(false)

  // 悬停延时:只在 hovering 期间挂一个定时器;离开时清掉
  useEffect(() => {
    if (!hovering) return
    const t = setTimeout(() => setHoverReady(true), delay)
    return () => clearTimeout(t)
  }, [hovering, delay])

  const visible = focused || (hovering && hoverReady)

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocused(false)
        setHoverReady(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible])

  let pos: { x: number; y: number } | null = null
  if (visible && anchor) {
    const r = anchor.getBoundingClientRect()
    pos = { x: r.left + r.width / 2, y: placement === 'top' ? r.top - 6 : r.bottom + 6 }
  }

  return (
    <>
      {children({
        setAnchor,
        onMouseEnter: () => setHovering(true),
        onMouseLeave: () => {
          setHovering(false)
          setHoverReady(false)
        },
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        'aria-describedby': visible ? id : undefined,
      })}
      {pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className={`bl-fade pointer-events-none fixed z-tooltip max-w-64 rounded-s bg-label-1 px-2 py-1 text-footnote text-on-ink shadow-popover ${placement === 'top' ? '-translate-x-1/2 -translate-y-full' : '-translate-x-1/2'}`}
            style={{ left: pos.x, top: pos.y }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
