import type { ReactNode } from 'react'

/**
 * 页标题(视觉改版第一批):衬线 Large Title(26/32)压在纸上是本产品的签名;
 * 副题 Callout 三级色。`actions` 槽保留到第二批把动作迁进工具栏带后删除。
 */
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
    <header className="mb-6 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-serif text-large-title font-semibold tracking-wide text-label-1">{title}</h1>
        {subtitle && <p className="mt-1.5 text-callout text-label-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
