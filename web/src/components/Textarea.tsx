import type { TextareaHTMLAttributes } from 'react'
import { INPUT_CLASS } from '../lib/formClasses'

/** 多行输入(视觉改版第一批):同 Input 外观,可纵向拉伸 */
export default function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${INPUT_CLASS} min-h-20 w-full resize-y px-2.5 py-1.5 text-body leading-relaxed ${className}`} {...rest} />
}
