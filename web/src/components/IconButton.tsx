import { forwardRef, type ButtonHTMLAttributes, type Ref } from 'react'
import Icon from './icons/Icon'
import type { IconName } from './icons/paths'
import Tooltip from './Tooltip'

type Variant = 'plain' | 'primary'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  icon: IconName
  label: string
  size?: 'sm' | 'md'
  variant?: Variant
  /** 开关态(aria-pressed) */
  active?: boolean
  /** 展开态(aria-expanded;打开浮层/抽屉的钮),外观同 active */
  expanded?: boolean
  tooltip?: boolean
}

function assignRef<T>(ref: Ref<T> | undefined, el: T | null) {
  if (typeof ref === 'function') ref(el)
  else if (ref) (ref as { current: T | null }).current = el
}

/**
 * 图标按钮(视觉改版第一批):28×28 命中区(HIG 桌面默认控件尺寸),`aria-label` + sr-only 文字
 * (调试自动化桥按 innerText 点按钮),自带 Tooltip;`active` 走 aria-pressed、`expanded` 走 aria-expanded
 * (二者外观同:fill-selected + accent)。转发 ref,可作 Popover/Menu 的锚定元素。
 */
const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { icon, label, size = 'md', variant = 'plain', active, expanded, tooltip = true, className = '', ...rest },
  ref,
) {
  const on = active || expanded
  const cls = `inline-flex shrink-0 cursor-pointer items-center justify-center rounded-s transition-colors duration-[var(--dur-fast)] disabled:cursor-not-allowed disabled:opacity-40 ${size === 'sm' ? 'size-6' : 'size-7'} ${
    variant === 'primary'
      ? 'bg-accent text-on-accent hover:opacity-90'
      : on
        ? 'bg-fill-selected text-accent'
        : 'text-label-2 hover:bg-fill-hover hover:text-label-1 active:bg-fill-active'
  } ${className}`
  const inner = (
    <>
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
      <span className="sr-only">{label}</span>
    </>
  )
  if (!tooltip) {
    return (
      <button type="button" ref={ref} aria-label={label} aria-pressed={active} aria-expanded={expanded} className={cls} {...rest}>
        {inner}
      </button>
    )
  }
  return (
    <Tooltip content={label}>
      {t => (
        <button
          type="button"
          ref={el => {
            t.setAnchor(el)
            assignRef(ref, el)
          }}
          aria-label={label}
          aria-pressed={active}
          aria-expanded={expanded}
          aria-describedby={t['aria-describedby']}
          onMouseEnter={t.onMouseEnter}
          onMouseLeave={t.onMouseLeave}
          onFocus={t.onFocus}
          onBlur={t.onBlur}
          className={cls}
          {...rest}
        >
          {inner}
        </button>
      )}
    </Tooltip>
  )
})

export default IconButton
