import type { ReactNode } from 'react'
import Card from '../../components/Card'
import { sectionDomId, type SettingsSectionId } from './settingsSections'

/**
 * 设置分区(视觉改版第三批,macOS 系统设置式):衬线小标题 + 说明 → 分组内嵌列表(Card p-0,行之间分隔线,行 44px)。
 * `aside` 放分区级动作(如画像的保存)。
 */
export default function SettingsSection({
  id,
  title,
  description,
  aside,
  children,
  'data-testid': testId,
}: {
  id: SettingsSectionId
  title: string
  description?: string
  aside?: ReactNode
  children: ReactNode
  'data-testid'?: string
}) {
  const headingId = `${sectionDomId(id)}-title`
  return (
    <section id={sectionDomId(id)} aria-labelledby={headingId} data-testid={testId} className="scroll-mt-4">
      <div className="mb-2 flex items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <h2 id={headingId} className="font-serif text-title3 font-semibold text-label-1">
            {title}
          </h2>
          {description && <p className="mt-0.5 max-w-[64ch] text-footnote leading-relaxed text-label-3">{description}</p>}
        </div>
        {aside && <div className="flex shrink-0 items-center gap-3">{aside}</div>}
      </div>
      <Card className="divide-y divide-sep p-0">{children}</Card>
    </section>
  )
}

/** 分组列表里的一行:标签左、内容右(不经 Field 的自定义行) */
export function SettingsRow({ label, children, className = '' }: { label: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`flex min-h-11 items-center justify-between gap-6 px-4 py-2 ${className}`}>
      <div className="min-w-0 text-body text-label-1">{label}</div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}
