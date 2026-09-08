import { useCallback } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import ProgressRing from '../../components/ProgressRing'
import { useAsyncResource } from '../../lib/useAsyncResource'
import type { BookProgress, StatsDetail } from '../../types'

const BOOK_STATUS_LABEL: Record<BookProgress['status'], string> = { active: '主攻中', paused: '已暂停', finished: '已学完' }
const mmdd = (date: string) => date.slice(5)

/** 进度 / 投入 / 质量三区(M2 T7):独立加载,失败只影响本区并可重试 */
function StatsDetailSections() {
  const detail = useAsyncResource(useCallback(() => backend.statsDetail(), []))
  if (detail.data === null) {
    return (
      <section className="mt-6">
        {detail.error
          ? <AsyncError error={detail.error} onRetry={detail.reload} variant="compact" />
          : <p className="text-sm text-ink-3">正在汇总详情…</p>}
      </section>
    )
  }
  return (
    <div className="mt-6 flex flex-col gap-5">
      {detail.error && <AsyncError error={detail.error} onRetry={detail.reload} variant="compact" />}
      <ProgressSection detail={detail.data} />
      <EffortSection detail={detail.data} />
      <QualitySection detail={detail.data} />
    </div>
  )
}

function ProgressSection({ detail }: { detail: StatsDetail }) {
  return (
    <Card className="p-6" data-testid="section-progress">
      <h2 className="font-serif text-base font-semibold text-ink-1">进度</h2>
      {detail.books.length === 0 ? (
        <p className="mt-2 text-sm text-ink-3">书架为空;导入一本书并生成知识地图后,这里会按书显示进度与预计完成日。</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {detail.books.map(b => {
            const ratio = b.total ? b.passed / b.total : 0
            return (
              <li key={b.id} data-testid="progress-book" className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-ink-1">{b.title}</span>
                  <span className="shrink-0 text-xs text-ink-3">{BOOK_STATUS_LABEL[b.status]}</span>
                </div>
                <div className="flex h-2 overflow-hidden rounded-full bg-paper-3">
                  <div className="h-full bg-ok" style={{ width: `${Math.round(ratio * 100)}%` }} />
                </div>
                <p className="text-xs text-ink-3">
                  已通过 {b.passed}/{b.total} · 已巩固 {b.consolidated} · 截止 {b.deadline ?? '未设'} · 预计完成 {b.projectedFinish ?? '—'}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function EffortSection({ detail }: { detail: StatsDetail }) {
  const maxMinutes = Math.max(1, ...detail.days.map(d => d.minutes))
  const totalMinutes = detail.days.reduce((sum, d) => sum + d.minutes, 0)
  const totalPomodoros = detail.days.reduce((sum, d) => sum + d.pomodoros, 0)
  const activeDays = detail.streakCalendar.filter(d => d.active).length
  return (
    <Card className="p-6" data-testid="section-effort">
      <div className="flex items-baseline justify-between">
        <h2 className="font-serif text-base font-semibold text-ink-1">投入</h2>
        <span className="text-xs text-ink-3">
          近 {detail.days.length} 天 <span data-testid="effort-minutes">{totalMinutes}</span> 分钟 · <span data-testid="effort-pomodoros">{totalPomodoros}</span> 个番茄
        </span>
      </div>
      {totalMinutes === 0 && totalPomodoros === 0 && (
        <p className="mt-2 text-xs text-ink-3">近 {detail.days.length} 天还没有学习投入;开一个番茄钟或完成一次讲授后这里会有柱状图。</p>
      )}
      <div className="mt-3 flex h-24 items-end gap-1" role="img" aria-label="近 14 天每日投入分钟">
        {detail.days.map(d => (
          <div
            key={d.date}
            data-testid="effort-bar"
            title={`${d.date}:${d.minutes} 分钟,${d.pomodoros} 个番茄`}
            className="flex-1 rounded-t-s bg-new/70"
            style={{ height: `${Math.max(2, Math.round((d.minutes / maxMinutes) * 100))}%` }}
          />
        ))}
      </div>
      {detail.days.length > 0 && (
        <div className="mt-1 flex justify-between text-[10px] text-ink-4">
          <span>{mmdd(detail.days[0].date)}</span>
          <span>{mmdd(detail.days[detail.days.length - 1].date)}</span>
        </div>
      )}
      <div className="mt-4 flex items-baseline justify-between">
        <h3 className="text-xs text-ink-3">打卡日历(近 {detail.streakCalendar.length} 天)</h3>
        <span className="text-xs text-ink-3">有学习记录 <span data-testid="streak-active-days">{activeDays}</span> 天</span>
      </div>
      <div className="mt-2 grid grid-flow-col grid-rows-7 gap-1" role="img" aria-label="打卡日历">
        {detail.streakCalendar.map(d => (
          <span
            key={d.date}
            data-testid="streak-cell"
            data-active={d.active ? 'true' : 'false'}
            title={d.date}
            className={`h-3 w-3 rounded-[3px] ${d.active ? 'bg-ok' : 'bg-paper-3'}`}
          />
        ))}
      </div>
    </Card>
  )
}

function QualitySection({ detail }: { detail: StatsDetail }) {
  const opened = detail.weakTrend.reduce((sum, d) => sum + d.opened, 0)
  const fixed = detail.weakTrend.reduce((sum, d) => sum + d.fixed, 0)
  const maxWeak = Math.max(1, ...detail.weakTrend.flatMap(d => [d.opened, d.fixed]))
  const scores = detail.avgScores
  return (
    <Card className="p-6" data-testid="section-quality">
      <h2 className="font-serif text-base font-semibold text-ink-1">质量</h2>
      <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div>
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs text-ink-3">薄弱点趋势(近 {detail.weakTrend.length} 天)</h3>
            <span className="text-xs text-ink-3">
              新增 <span data-testid="weak-opened" className="text-weak">{opened}</span> · 修复 <span data-testid="weak-fixed" className="text-ok">{fixed}</span>
            </span>
          </div>
          <div className="mt-2 flex h-16 items-end gap-1" role="img" aria-label="每日新增与修复薄弱点">
            {detail.weakTrend.map(d => (
              <div key={d.date} className="flex flex-1 items-end gap-px" title={`${d.date}:新增 ${d.opened},修复 ${d.fixed}`}>
                <div className="flex-1 rounded-t-s bg-weak/70" style={{ height: `${Math.max(2, Math.round((d.opened / maxWeak) * 100))}%` }} />
                <div className="flex-1 rounded-t-s bg-ok/70" style={{ height: `${Math.max(2, Math.round((d.fixed / maxWeak) * 100))}%` }} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-xs text-ink-3">评估均分{scores ? `(近 ${scores.samples} 次)` : ''}</h3>
          {scores ? (
            <ul className="mt-2 flex flex-col gap-2">
              {([['准确性', scores.accuracy], ['完整性', scores.completeness], ['清晰度', scores.clarity]] as const).map(([label, value]) => (
                <li key={label} className="flex items-center gap-3 text-xs text-ink-2">
                  <span className="w-12 shrink-0">{label}</span>
                  <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-paper-3">
                    <div className="h-full bg-review" style={{ width: `${Math.round((value / 5) * 100)}%` }} />
                  </div>
                  <span data-testid="avg-score" className="w-8 text-right font-medium text-ink-1">{value.toFixed(1)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-3">尚无评估;完成一次费曼讲授后这里会有均分。</p>
          )}
        </div>
        <div className="flex items-center gap-4">
          {detail.reviewPassRate === null ? (
            <p className="text-sm text-ink-3">近 30 天没有间隔复习记录。</p>
          ) : (
            <>
              <ProgressRing value={detail.reviewPassRate} size={72} stroke={7} color="var(--c-review)" label={`${Math.round(detail.reviewPassRate * 100)}%`} />
              <div>
                <h3 className="text-xs text-ink-3">复习通过率(近 30 天)</h3>
                <p className="mt-1 text-sm text-ink-2">
                  <span data-testid="review-pass-rate">{Math.round(detail.reviewPassRate * 100)}%</span> 的间隔复习一次通过。
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

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

      <StatsDetailSections />
    </div>
  )
}
