import type { ReactNode } from 'react'

export default function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <header className="mb-8 flex items-end justify-between gap-4 border-b border-line pb-5">
      <div>
        <h1 className="font-serif text-[1.75rem] leading-tight font-semibold tracking-wide text-ink-1">
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 text-sm text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
