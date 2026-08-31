import type { HTMLAttributes } from 'react'

export type TagTone = 'weak' | 'review' | 'new' | 'ok' | 'neutral'

const TONE: Record<TagTone, string> = {
  weak: 'bg-weak-soft text-weak',
  review: 'bg-review-soft text-review',
  new: 'bg-new-soft text-new',
  ok: 'bg-paper-3 text-ok',
  neutral: 'bg-paper-3 text-ink-3',
}

export default function Tag({
  tone = 'neutral',
  className = '',
  ...rest
}: { tone?: TagTone } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[tone]} ${className}`}
      {...rest}
    />
  )
}
