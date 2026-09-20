import type { InputHTMLAttributes, ReactNode } from 'react'
import Icon from './icons/Icon'

/** 复选框(视觉改版第一批):原生 input(可访问名与测试不变),自绘 16px 方框 + 勾 */
export default function Checkbox({
  label,
  className = '',
  ...rest
}: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-body text-label-1 has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50 ${className}`}>
      <span className="relative inline-flex size-4 shrink-0">
        <input
          type="checkbox"
          className="peer size-4 cursor-pointer appearance-none rounded-xs border border-sep-strong bg-card outline-none checked:border-accent checked:bg-accent focus-visible:ring-[3px] focus-visible:ring-accent/35"
          {...rest}
        />
        <Icon name="checkmark" size={12} strokeWidth={2} className="pointer-events-none absolute left-0.5 top-0.5 text-on-accent opacity-0 peer-checked:opacity-100" />
      </span>
      <span>{label}</span>
    </label>
  )
}
