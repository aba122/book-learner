import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-label-1 text-on-ink hover:opacity-90 active:opacity-80',
  secondary: 'border border-sep bg-card text-label-1 hover:bg-fill-hover active:bg-fill-active',
  ghost: 'text-label-2 hover:bg-fill-hover hover:text-label-1 active:bg-fill-active',
  danger: 'bg-weak text-on-ink hover:opacity-90 active:opacity-80',
}
const SIZE: Record<Size, string> = {
  md: 'h-7 px-3 text-body',
  sm: 'h-6 px-2.5 text-callout',
}

/**
 * 按钮(视觉改版第一批):高 28px(sm 24px,命中区仍 ≥ 28 靠外围间距),圆角 6;
 * 每屏一个 primary,其余 secondary(带边框)/ ghost(无边框);danger 只在确认框里用。
 */
export default function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: { variant?: Variant; size?: Size } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-s font-medium whitespace-nowrap transition-[background-color,opacity,color] duration-[var(--dur-fast)] disabled:cursor-not-allowed disabled:opacity-40 ${SIZE[size]} ${VARIANT[variant]} ${className}`}
      {...rest}
    />
  )
}
