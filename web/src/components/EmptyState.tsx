import type { ReactNode } from 'react'
import Icon from './icons/Icon'
import type { IconName } from './icons/paths'

/**
 * 空态(视觉改版第一批):图标(或个别情绪化 emoji)+ 衬线小标题 + 一句正文(≤36ch)+ 可选动作。
 * 标题文案保持测试钉住的原文。
 */
export default function EmptyState({
  icon,
  emoji,
  title,
  body,
  action,
  compact = false,
  className = '',
}: {
  icon?: IconName
  emoji?: string
  title: string
  body?: string
  action?: ReactNode
  compact?: boolean
  className?: string
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'gap-2 p-4' : 'gap-3 p-10'} ${className}`}>
      {emoji ? (
        <span aria-hidden className={compact ? 'text-2xl' : 'text-4xl'}>{emoji}</span>
      ) : icon ? (
        <Icon name={icon} size={compact ? 22 : 28} className="text-label-3" />
      ) : null}
      <h3 className={`font-serif font-semibold text-label-1 ${compact ? 'text-body' : 'text-title3'}`}>{title}</h3>
      {body && <p className={`max-w-[36ch] leading-relaxed text-label-3 ${compact ? 'text-footnote' : 'text-callout'}`}>{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
