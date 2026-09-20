import { useCallback, useId } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import ProgressRing from '../../components/ProgressRing'
import Skeleton from '../../components/Skeleton'
import Toolbar from '../../components/Toolbar'
import { useAsyncResource } from '../../lib/useAsyncResource'
import type { BackendError } from '../../backend/errors'
import type { BookProgress, Stats, StatsDetail } from '../../types'

const BOOK_STATUS_LABEL: Record<BookProgress['status'], string> = { active: '主攻中', paused: '已暂停', finished: '已学完' }
const mmdd = (date: string) => date.slice(5)

/** 读屏用数据表:图表 `role=img` 经 aria-describedby 指向它(视觉改版第三批) */
function SrTable({ id, caption, head, rows }: { id: string; caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table id={id} className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>{head.map(h => <th key={h} scope="col">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

/** 进度 / 投入 / 质量三区(M2 T7):独立加载,失败只影响本区并可重试 */
function StatsDetailSections() {
  const detail = useAsyncResource(useCallback(() => backend.statsDetail(), []))
  if (detail.data === null) {
    return (
      <section className="mt-6">
        {detail.error
          ? <AsyncError error={detail.error} onRetry={detail.reload} variant="compact" />
          : <div aria-busy="true" className="rounded-l border border-sep bg-card p-5"><Skeleton lines={4} /></div>}
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

function SectionTitle({ children, aside }: { children: string; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="font-serif text-title3 font-semibold text-label-1">{children}</h2>
      {aside && <div className="text-footnote text-label-3">{aside}</div>}
    </div>
  )
}

function ProgressSection({ detail }: { detail: StatsDetail }) {
  return (
    <Card className="p-5" data-testid="section-progress">
      <SectionTitle>进度</SectionTitle>
      {detail.books.length === 0 ? (
        <p className="mt-2 text-callout text-label-3">书架为空;导入一本书并生成知识地图后,这里会按书显示进度与预计完成日。</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {detail.books.map(b => {
            const ratio = b.total ? b.passed / b.total : 0
            return (
              <li key={b.id} data-testid="progress-book" className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-serif text-body font-medium text-label-1">{b.title}</span>
                  <span className="shrink-0 text-footnote text-label-3">{BOOK_STATUS_LABEL[b.status]}</span>
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-full bg-inset" role="progressbar" aria-label={`${b.title} 已通过`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
                  <div className="h-full rounded-full bg-ok" style={{ width: `${Math.round(ratio * 100)}%` }} />
                </div>
                <p className="text-footnote text-label-3">
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
  const effortTableId = useId()
  const streakTableId = useId()
  const maxMinutes = Math.max(1, ...detail.days.map(d => d.minutes))
  const totalMinutes = detail.days.reduce((sum, d) => sum + d.minutes, 0)
  const totalPomodoros = detail.days.reduce((sum, d) => sum + d.pomodoros, 0)
  const activeDays = detail.streakCalendar.filter(d => d.active).length
  return (
    <Card className="p-5" data-testid="section-effort">
      <SectionTitle
        aside={
          <>
            近 {detail.days.length} 天 <span data-testid="effort-minutes" className="font-medium text-label-1 tabular-nums">{totalMinutes}</span> 分钟 · <span data-testid="effort-pomodoros" className="font-medium text-label-1 tabular-nums">{totalPomodoros}</span> 个番茄
          </>
        }
      >
        投入
      </SectionTitle>
      {totalMinutes === 0 && totalPomodoros === 0 && (
        <p className="mt-2 text-footnote text-label-3">近 {detail.days.length} 天还没有学习投入;开一个番茄钟或完成一次讲授后这里会有柱状图。</p>
      )}
      <div className="mt-3 flex h-24 items-end gap-1" role="img" aria-label="近 14 天每日投入分钟" aria-describedby={effortTableId}>
        {detail.days.map(d => (
          <div
            key={d.date}
            data-testid="effort-bar"
            title={`${d.date}:${d.minutes} 分钟,${d.pomodoros} 个番茄`}
            className="flex-1 rounded-t-xs bg-new/70"
            style={{ height: `${Math.max(2, Math.round((d.minutes / maxMinutes) * 100))}%` }}
          />
        ))}
      </div>
      <SrTable id={effortTableId} caption="近 14 天每日投入数据表" head={['日期', '分钟', '番茄数']} rows={detail.days.map(d => [d.date, d.minutes, d.pomodoros])} />
      {detail.days.length > 0 && (
        <div className="mt-1 flex justify-between text-footnote text-label-3 tabular-nums">
          <span>{mmdd(detail.days[0].date)}</span>
          <span>{mmdd(detail.days[detail.days.length - 1].date)}</span>
        </div>
      )}
      <div className="mt-4 flex items-baseline justify-between">
        <h3 className="text-footnote font-medium text-label-3">打卡日历(近 {detail.streakCalendar.length} 天)</h3>
        <span className="text-footnote text-label-3">有学习记录 <span data-testid="streak-active-days" className="font-medium text-label-1 tabular-nums">{activeDays}</span> 天</span>
      </div>
      <div className="mt-2 grid grid-flow-col grid-rows-7 gap-1" role="img" aria-label="打卡日历" aria-describedby={streakTableId}>
        {detail.streakCalendar.map(d => (
          <span
            key={d.date}
            data-testid="streak-cell"
            data-active={d.active ? 'true' : 'false'}
            title={d.date}
            className={`size-3 rounded-[3px] ${d.active ? 'bg-ok' : 'bg-inset'}`}
          />
        ))}
      </div>
      <SrTable id={streakTableId} caption="打卡日历数据表" head={['日期', '有学习记录']} rows={detail.streakCalendar.map(d => [d.date, d.active ? '是' : '否'])} />
    </Card>
  )
}

function QualitySection({ detail }: { detail: StatsDetail }) {
  const weakTableId = useId()
  const opened = detail.weakTrend.reduce((sum, d) => sum + d.opened, 0)
  const fixed = detail.weakTrend.reduce((sum, d) => sum + d.fixed, 0)
  const maxWeak = Math.max(1, ...detail.weakTrend.flatMap(d => [d.opened, d.fixed]))
  const scores = detail.avgScores
  return (
    <Card className="p-5" data-testid="section-quality">
      <SectionTitle>质量</SectionTitle>
      <div className="mt-3 grid grid-cols-1 gap-6 @2xl:grid-cols-3">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-footnote font-medium text-label-3">薄弱点趋势(近 {detail.weakTrend.length} 天)</h3>
            <span className="text-footnote text-label-3">
              新增 <span data-testid="weak-opened" className="font-medium text-weak tabular-nums">{opened}</span> · 修复 <span data-testid="weak-fixed" className="font-medium text-ok tabular-nums">{fixed}</span>
            </span>
          </div>
          <div className="mt-2 flex h-16 items-end gap-1" role="img" aria-label="每日新增与修复薄弱点" aria-describedby={weakTableId}>
            {detail.weakTrend.map(d => (
              <div key={d.date} className="flex flex-1 items-end gap-px" title={`${d.date}:新增 ${d.opened},修复 ${d.fixed}`}>
                <div className="flex-1 rounded-t-xs bg-weak/70" style={{ height: `${Math.max(2, Math.round((d.opened / maxWeak) * 100))}%` }} />
                <div className="flex-1 rounded-t-xs bg-ok/70" style={{ height: `${Math.max(2, Math.round((d.fixed / maxWeak) * 100))}%` }} />
              </div>
            ))}
          </div>
          <SrTable id={weakTableId} caption="薄弱点趋势数据表" head={['日期', '新增', '修复']} rows={detail.weakTrend.map(d => [d.date, d.opened, d.fixed])} />
          <div aria-hidden className="mt-1.5 flex items-center gap-3 text-footnote text-label-3">
            <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-xs bg-weak/70" />新增</span>
            <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-xs bg-ok/70" />修复</span>
          </div>
        </div>
        <div>
          <h3 className="text-footnote font-medium text-label-3">评估均分{scores ? `(近 ${scores.samples} 次)` : ''}</h3>
          {scores ? (
            <ul className="mt-2 flex flex-col gap-2">
              {([['准确性', scores.accuracy], ['完整性', scores.completeness], ['清晰度', scores.clarity]] as const).map(([label, value]) => (
                <li key={label} className="flex items-center gap-3 text-footnote text-label-2">
                  <span className="w-12 shrink-0">{label}</span>
                  <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-inset">
                    <div className="h-full rounded-full bg-review" style={{ width: `${Math.round((value / 5) * 100)}%` }} />
                  </div>
                  <span data-testid="avg-score" className="w-8 text-right font-medium text-label-1 tabular-nums">{value.toFixed(1)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-callout text-label-3">尚无评估;完成一次费曼讲授后这里会有均分。</p>
          )}
        </div>
        <div className="flex items-center gap-4">
          {detail.reviewPassRate === null ? (
            <p className="text-callout text-label-3">近 30 天没有间隔复习记录。</p>
          ) : (
            <>
              <ProgressRing value={detail.reviewPassRate} size={64} stroke={6} color="var(--signal-review)" label={`${Math.round(detail.reviewPassRate * 100)}%`} />
              <div>
                <h3 className="text-footnote font-medium text-label-3">复习通过率(近 30 天)</h3>
                <p className="mt-1 text-callout text-label-2">
                  <span data-testid="review-pass-rate" className="font-medium text-label-1 tabular-nums">{Math.round(detail.reviewPassRate * 100)}%</span> 的间隔复习一次通过。
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

/** 大数瓦片:衬线 Large Title 数字 + 单位 */
function Tile({ label, value, unit, testId }: { label: string; value: number; unit: string; testId: string }) {
  return (
    <Card className="flex flex-col justify-between p-5">
      <div className="text-footnote text-label-3">{label}</div>
      <div className="mt-2 font-serif text-large-title font-semibold text-label-1 tabular-nums">
        <span data-testid={testId}>{value}</span>
        <span className="ml-1 text-callout font-normal text-label-3">{unit}</span>
      </div>
    </Card>
  )
}

/**
 * 统计页(视觉改版第三批):空工具栏带(只作拖动区);顶部瓦片按容器 2/4 列;
 * 手绘图表保留,每个 `role=img` 经 aria-describedby 指向读屏数据表。
 */
export default function StatsPage() {
  const stats = useAsyncResource(useCallback(() => backend.stats(), []))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="统计工具栏" />
      <div className="min-h-0 flex-1 overflow-y-auto @container">
        <div className="mx-auto w-full max-w-[56rem] px-8 pt-6 pb-16">
          <PageHeader title="统计" subtitle="进度、连续天数与薄弱点收敛" />
          {stats.data === null ? (
            stats.error
              ? <AsyncError error={stats.error} onRetry={stats.reload} />
              : (
                <div aria-busy="true" className="grid grid-cols-2 gap-4 @3xl:grid-cols-4">
                  {[0, 1, 2, 3].map(i => <div key={i} className={`rounded-l border border-sep bg-card p-5 ${i === 0 ? 'col-span-2' : ''}`}><Skeleton lines={2} /></div>)}
                </div>
              )
          ) : (
            <StatsBody stats={stats.data} error={stats.error} onRetry={stats.reload} />
          )}
        </div>
      </div>
    </div>
  )
}

function StatsBody({ stats: s, error, onRetry }: { stats: Stats; error: BackendError | null; onRetry: () => void }) {
  const weakTotal = s.openWeakPoints + s.fixedWeakPoints
  const fixedRatio = weakTotal ? s.fixedWeakPoints / weakTotal : 0
  return (
    <>
      {error && (
        <div className="mb-6">
          <AsyncError error={error} onRetry={onRetry} variant="compact" />
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 @3xl:grid-cols-4">
        <Card className="col-span-2 flex items-center gap-6 p-5 @3xl:row-span-2">
          <ProgressRing
            value={s.totalBlocks ? s.passedBlocks / s.totalBlocks : 0}
            size={96}
            stroke={8}
            color="var(--signal-ok)"
            label={`${s.passedBlocks}/${s.totalBlocks}`}
          />
          <div>
            <h2 className="font-serif text-title3 font-semibold text-label-1">攻克进度</h2>
            <p className="mt-1 text-callout leading-relaxed text-label-2">
              已通过 {s.passedBlocks} 块,剩余 {s.totalBlocks - s.passedBlocks} 块。
              每一块的通过,都要经得起讲给别人听。
            </p>
          </div>
        </Card>

        <Tile label="连续学习" value={s.streakDays} unit="天" testId="stat-streak" />
        <Tile label="今日投入" value={s.minutesToday} unit="分钟" testId="stat-minutes" />

        <Card className="col-span-2 p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-footnote text-label-3">薄弱点收敛</h2>
            <div className="text-footnote text-label-3">
              待回补 <span data-testid="stat-weak-open" className="font-semibold text-weak tabular-nums">{s.openWeakPoints}</span>
              <span className="mx-1.5 text-label-4">/</span>
              已修复 <span data-testid="stat-weak-fixed" className="font-semibold text-ok tabular-nums">{s.fixedWeakPoints}</span>
            </div>
          </div>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-inset">
            <div
              className="h-full bg-ok transition-[width] duration-[var(--dur-slow)]"
              style={{ width: `${Math.round(fixedRatio * 100)}%` }}
            />
            <div
              className="h-full bg-weak/70 transition-[width] duration-[var(--dur-slow)]"
              style={{ width: `${Math.round((1 - fixedRatio) * 100 * (weakTotal ? 1 : 0))}%` }}
            />
          </div>
          <p className="mt-2 text-footnote leading-relaxed text-label-3">
            薄弱点连续两次讲对才算修复;比起清零,更重要的是暴露得足够早。
          </p>
        </Card>
      </div>

      <StatsDetailSections />
    </>
  )
}
