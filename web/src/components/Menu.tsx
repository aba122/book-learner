import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import Icon from './icons/Icon'
import type { IconName } from './icons/paths'

export type MenuAnchor = HTMLElement | { x: number; y: number }

export type MenuEntry =
  | { separator: true }
  | {
      separator?: false
      label: string
      /** 可访问名(默认用 label) */
      ariaLabel?: string
      icon?: IconName
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }

interface Props {
  open: boolean
  onClose: () => void
  /** 锚定元素(按钮)或屏幕坐标(右键) */
  anchor: MenuAnchor | null
  items: MenuEntry[]
  'aria-label': string
}

const ITEM_H = 28
const isSeparator = (e: MenuEntry): e is { separator: true } => e.separator === true

/**
 * 菜单(视觉改版第二批,无第三方库):portal 到 body,`role=menu` + 28px `menuitem` 行;
 * 打开即聚焦第一项,↑↓ Home End 移动、Enter/Space 选中、Esc 关闭、外点关闭;关闭后焦点回锚定按钮。
 * 受控:由调用方持有 open/anchor(按钮点击与右键同一个菜单)。
 */
export default function Menu({ open, onClose, anchor, items, 'aria-label': ariaLabel }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [active, setActive] = useState(0)
  const enabledIdx = items.map((it, i) => (!isSeparator(it) && !it.disabled ? i : -1)).filter(i => i >= 0)

  // 位置:锚定元素下方左对齐,或右键坐标;贴边时向内收
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const panel = panelRef.current
    const w = panel?.offsetWidth ?? 200
    const h = panel?.offsetHeight ?? items.length * ITEM_H
    let left: number
    let top: number
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect()
      left = r.left
      top = r.bottom + 4
      if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w)
    } else {
      left = anchor.x
      top = anchor.y
      if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w)
    }
    if (top + h > window.innerHeight - 8) top = Math.max(8, top - h - 8)
    setPos({ left, top })
  }, [open, anchor, items.length])

  // 打开:聚焦第一项;关闭:焦点回锚定按钮
  useEffect(() => {
    if (!open) return
    const first = enabledIdx[0] ?? 0
    setActive(first)
    const t = setTimeout(() => panelRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]')[first]?.focus(), 0)
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown, true)
      if (anchor instanceof HTMLElement && document.contains(anchor)) anchor.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enabledIdx 由 items 派生,只在 open 变化时重算
  }, [open])

  if (!open || !anchor) return null

  const focusItem = (i: number) => {
    setActive(i)
    panelRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]')[i]?.focus()
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const k = enabledIdx.indexOf(active)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusItem(enabledIdx[(k + 1) % enabledIdx.length])
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusItem(enabledIdx[(k - 1 + enabledIdx.length) % enabledIdx.length])
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusItem(enabledIdx[0])
    } else if (e.key === 'End') {
      e.preventDefault()
      focusItem(enabledIdx[enabledIdx.length - 1])
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      onClose()
    }
  }

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="bl-pop fixed z-popover min-w-44 rounded-m bg-popover p-1 shadow-popover ring-1 ring-sep/60"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {items.map((it, i) =>
        isSeparator(it) ? (
          <div key={i} role="separator" className="my-1 h-px bg-sep" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            aria-label={it.ariaLabel}
            disabled={it.disabled}
            tabIndex={i === active ? 0 : -1}
            onMouseEnter={() => !it.disabled && setActive(i)}
            onClick={() => {
              if (it.disabled) return
              onClose()
              it.onSelect()
            }}
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-s px-2 text-left text-body outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
              it.danger ? 'text-weak hover:bg-weak-soft focus-visible:bg-weak-soft' : 'text-label-1 hover:bg-fill-hover focus-visible:bg-fill-hover'
            }`}
          >
            {it.icon && <Icon name={it.icon} size={14} className={it.danger ? 'text-weak' : 'text-label-3'} />}
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
