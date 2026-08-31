import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink-1 text-paper-2 hover:opacity-85',
  ghost: 'border border-line text-ink-2 hover:bg-paper-3',
  danger: 'bg-weak text-paper-2 hover:opacity-85',
}

export default function Button({
  variant = 'ghost',
  className = '',
  ...rest
}: { variant?: Variant } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-m px-4 py-2 text-sm transition-[background-color,opacity,color] duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT[variant]} ${className}`}
      {...rest}
    />
  )
}
