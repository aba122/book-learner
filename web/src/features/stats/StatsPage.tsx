import { useCallback } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import ProgressRing from '../../components/ProgressRing'
import { useAsyncResource } from '../../lib/useAsyncResource'

export default function StatsPage() {
  const stats = useAsyncResource(useCallback(() => backend.stats(), []))

  if (stats.data === null) {
    return (
      <div className="mx-auto max-w-4xl px-10 py-12">
        <PageHeader title="统计" subtitle="进度、连续天数与薄弱点收敛" />
        {stats.error
          ? <AsyncError error={stats.error} onRetry={stats.reload} />
          : <p className="text-sm text-ink-3">正在统计…</p>}
      </div>
    )
  }

  const s = stats.data
  const weakTotal = s.openWeakPoints + s.fixedWeakPoints
  const fixedRatio = weakTotal ? s.fixedWeakPoints / weakTotal : 0

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader title="统计" subtitle="进度、连续天数与薄弱点收敛" />

      {stats.error && (
        <div className="mb-6">
          <AsyncError error={stats.error} onRetry={stats.reload} variant="compact" />
        </div>
      )}

      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <Card className="col-span-2 flex items-center gap-6 p-6 lg:row-span-2">
          <ProgressRing
            value={s.totalBlocks ? s.passedBlocks / s.totalBlocks : 0}
            size={120}
            stroke={9}
            color="var(--c-ok)"
            label={`${s.passedBlocks}/${s.totalBlocks}`}
          />
          <div>
            <h2 className="font-serif text-lg font-semibold text-ink-1">攻克进度</h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-3">
              已通过 {s.passedBlocks} 块,剩余 {s.totalBlocks - s.passedBlocks} 块。
              每一块的通过,都要经得起讲给别人听。
            </p>
          </div>
        </Card>

        <Card className="p-6">
          <div className="text-xs text-ink-3">连续学习</div>
          <div className="mt-1 font-serif text-4xl font-semibold text-ink-1">
            <span data-testid="stat-streak">{s.streakDays}</span>
            <span className="ml-1 text-base font-normal text-ink-3">天</span>
          </div>
        </Card>

        <Card className="p-6">
          <div className="text-xs text-ink-3">今日投入</div>
          <div className="mt-1 font-serif text-4xl font-semibold text-ink-1">
            <span data-testid="stat-minutes">{s.minutesToday}</span>
            <span className="ml-1 text-base font-normal text-ink-3">分钟</span>
          </div>
        </Card>

        <Card className="col-span-2 p-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs text-ink-3">薄弱点收敛</h2>
            <div className="text-xs text-ink-3">
              待回补 <span data-testid="stat-weak-open" className="font-semibold text-weak">{s.openWeakPoints}</span>
              <span className="mx-1.5 text-ink-4">/</span>
              已修复 <span data-testid="stat-weak-fixed" className="font-semibold text-ok">{s.fixedWeakPoints}</span>
            </div>
          </div>
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-paper-3">
            <div
              className="h-full bg-ok transition-[width] duration-500"
              style={{ width: `${Math.round(fixedRatio * 100)}%` }}
            />
            <div
              className="h-full bg-weak/70 transition-[width] duration-500"
              style={{ width: `${Math.round((1 - fixedRatio) * 100 * (weakTotal ? 1 : 0))}%` }}
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-4">
            薄弱点连续两次讲对才算修复;比起清零,更重要的是暴露得足够早。
          </p>
        </Card>
      </div>
    </div>
  )
}
