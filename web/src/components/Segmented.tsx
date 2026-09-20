import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import Icon from './icons/Icon'
import type { IconName } from './icons/paths'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** 可访问名(label 不是纯文字或需要更长说明时) */
  ariaLabel?: string
  icon?: IconName
  /** tabs 语义时指向对应面板 id */
  controls?: string
}

interface Props<T extends string> {
  value: T
  onChange: (next: T) => void
  options: SegmentedOption<T>[]
  /** radio → role=radiogroup/radio + aria-checked;tabs → tablist/tab + aria-selected */
  semantics?: 'radio' | 'tabs'
  'aria-label': string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 分段控件(视觉改版第一批):槽 + 凸起白段(macOS),不再用任务色实心填色;←/→ 在段间移动(roving tabindex)。
 */
export default function Segmented<T extends string>({
  value,
  onChange,
  options,
  semantics = 'radio',
  'aria-label': ariaLabel,
  size = 'md',
  className = '',
}: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex(o => o.value === value)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % options.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + options.length) % options.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = options.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(options[next].value)
    refs.current[next]?.focus()
  }
  const tabs = semantics === 'tabs'
  return (
    <div
      role={tabs ? 'tablist' : 'radiogroup'}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`inline-flex gap-0.5 rounded-m bg-inset p-0.5 ${className}`}
    >
      {options.map((o, i) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            ref={el => {
              refs.current[i] = el
            }}
            type="button"
            role={tabs ? 'tab' : 'radio'}
            aria-selected={tabs ? selected : undefined}
            aria-checked={tabs ? undefined : selected}
            aria-controls={tabs ? o.controls : undefined}
            aria-label={o.ariaLabel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-s font-medium whitespace-nowrap transition-colors duration-[var(--dur-fast)] ${size === 'sm' ? 'h-5 px-2 text-footnote' : 'h-6 px-2.5 text-callout'} ${selected ? 'bg-card text-label-1 shadow-card' : 'text-label-2 hover:text-label-1'}`}
          >
            {o.icon && <Icon name={o.icon} size={size === 'sm' ? 12 : 14} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
