import { useCallback, useEffect, useId, useState, type ReactElement } from 'react'
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
 * 位置(2026-09-21 修):按提示框实际尺寸算——上方放不下就翻到下方(标题栏带里的钮),左右夹在视口内 8px 之内。
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

  // 提示框尺寸经回调 ref 量取(尺寸不变就不再 setState,避免循环);没量到前先隐形渲染一帧
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setSize(cur => (cur && cur.w === w && cur.h === h ? cur : { w, h }))
  }, [])

  let pos: { left: number; top: number } | null = null
  if (visible && anchor) {
    const r = anchor.getBoundingClientRect()
    const w = size?.w ?? 0
    const h = size?.h ?? 0
    const gap = 6
    const margin = 8
    let top = placement === 'top' ? r.top - gap - h : r.bottom + gap
    if (placement === 'top' && top < margin) top = r.bottom + gap
    else if (placement === 'bottom' && top + h > window.innerHeight - margin) top = r.top - gap - h
    const left = Math.max(margin, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - margin - w))
    pos = { left, top }
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
            ref={measure}
            role="tooltip"
            className="bl-fade pointer-events-none fixed z-tooltip max-w-64 rounded-s bg-label-1 px-2 py-1 text-footnote text-on-ink shadow-popover"
            style={{ left: pos.left, top: pos.top, visibility: size ? 'visible' : 'hidden' }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
