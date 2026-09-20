import type { InputHTMLAttributes } from 'react'
import { INPUT_CLASS, INPUT_SIZE } from '../lib/formClasses'

/** 文本输入(视觉改版第一批):见 lib/formClasses */
export default function Input({
  size = 'md',
  className = '',
  ...rest
}: { size?: 'sm' | 'md' } & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>) {
  return <input className={`${INPUT_CLASS} ${INPUT_SIZE[size]} ${className}`} {...rest} />
}
