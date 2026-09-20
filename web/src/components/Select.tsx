import type { SelectHTMLAttributes } from 'react'
import { INPUT_CLASS, INPUT_SIZE } from '../lib/formClasses'
import Icon from './icons/Icon'

/** 下拉(视觉改版第一批):原生 <select>(测试与桥都按 option 查),外观同 Input,右侧自绘箭头 */
export default function Select({
  size = 'md',
  className = '',
  ...rest
}: { size?: 'sm' | 'md' } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <select className={`${INPUT_CLASS} ${INPUT_SIZE[size]} w-full cursor-pointer appearance-none pr-7 shadow-card`} {...rest} />
      <Icon name="chevron-down" size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-label-3" />
    </span>
  )
}
