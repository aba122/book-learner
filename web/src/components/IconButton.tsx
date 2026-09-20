import type { ButtonHTMLAttributes } from 'react'
import Icon from './icons/Icon'
import type { IconName } from './icons/paths'
import Tooltip from './Tooltip'

type Variant = 'plain' | 'primary'

/**
 * 图标按钮(视觉改版第一批):28×28 命中区(HIG 桌面默认控件尺寸),`aria-label` + sr-only 文字
 * (调试自动化桥按 innerText 点按钮),自带 Tooltip;`active` 走 aria-pressed(选中态 fill-selected + accent)。
 */
export default function IconButton({
  icon,
  label,
  size = 'md',
  variant = 'plain',
  active,
  tooltip = true,
  className = '',
  ...rest
}: {
  icon: IconName
  label: string
  size?: 'sm' | 'md'
  variant?: Variant
  active?: boolean
  tooltip?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'>) {
  const cls = `inline-flex shrink-0 cursor-pointer items-center justify-center rounded-s transition-colors duration-[var(--dur-fast)] disabled:cursor-not-allowed disabled:opacity-40 ${size === 'sm' ? 'size-6' : 'size-7'} ${
    variant === 'primary'
      ? 'bg-accent text-on-accent hover:opacity-90'
      : 'text-label-2 hover:bg-fill-hover hover:text-label-1 active:bg-fill-active aria-pressed:bg-fill-selected aria-pressed:text-accent'
  } ${className}`
  const inner = (
    <>
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
      <span className="sr-only">{label}</span>
    </>
  )
  if (!tooltip) {
    return (
      <button type="button" aria-label={label} aria-pressed={active} className={cls} {...rest}>
        {inner}
      </button>
    )
  }
  return (
    <Tooltip content={label}>
      {t => (
        <button
          type="button"
          ref={t.setAnchor}
          aria-label={label}
          aria-pressed={active}
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
}