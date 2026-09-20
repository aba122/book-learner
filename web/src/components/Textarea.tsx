import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { INPUT_CLASS } from '../lib/formClasses'

/** 多行输入(视觉改版第一批):同 Input 外观;没给 rows 时最小高 80px;转发 ref(问书输入要聚焦) */
const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className = '', rows, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={`${INPUT_CLASS} w-full resize-y px-2.5 py-1.5 text-body leading-relaxed ${rows ? '' : 'min-h-20'} ${className}`} {...rest} />
})

export default Textarea
