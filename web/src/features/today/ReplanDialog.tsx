import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import { APP_DEFAULTS, DAILY_CAP_DEFAULT, REPLAN_DISMISSED_KEY } from '../../config'
import { addCalendarDays } from '../../lib/localDate'
import { writePref } from '../../lib/prefs'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { Book, MapEditOp, Replan } from '../../types'

type Choice = 'extend' | 'trim'

/**
 * 落后重排确认(PRODUCT_SPEC §6):均摊结果超过每日上限时,由用户决定顺延截止日或缩减地图;
 * 截止日永不被静默修改。"本日不再提醒"只记偏好,不改任何计划。
 */
export default function ReplanDialog({
  book,
  replan,
  today,
  onResolved,
  onDismiss,
}: {
  book: Book
  replan: Replan
  today: string
  onResolved: () => Promise<unknown>
  onDismiss: () => void
}) {
  const cap = replan.dailyCap > 0 ? replan.dailyCap : DAILY_CAP_DEFAULT
  const extendDays = Math.max(1, Math.ceil(replan.remainingBlocks / cap))
  const newDeadline = addCalendarDays(today, extendDays - 1)
  const excess = Math.max(1, replan.remainingBlocks - cap * Math.max(1, replan.remainingDays))

  const decide = useBackendOperation(
    async (choice: Choice) => {
      if (choice === 'extend') {
        const plan = await backend.getPlan(book.id)
        await backend.setPlan({
          bookId: book.id,
          deadline: newDeadline,
          dailyNewBlocks: plan?.dailyNewBlocks ?? Math.min(cap, replan.requiredDaily ?? 1),
          dailyCap: plan?.dailyCap ?? cap,
          remindTime: plan?.remindTime ?? APP_DEFAULTS.remindTime,
        })
      } else {
        const blocks = await backend.listBlocks(book.id)
        const ops: MapEditOp[] = blocks
          .filter(b => !b.skipped && (b.status === 'unlearned' || b.status === 'learning'))
          .sort((a, z) => z.seq - a.seq)
          .slice(0, excess)
          .map(b => ({ op: 'setSkipped', blockId: b.id, skipped: true }))
        await backend.confirmMap(book.id, book.mapRevision, ops)
      }
    },
    { onCommitted: async () => { await onResolved() } },
  )
  const busy = decide.pending.size > 0
  const failure = decide.errors.get('decide')

  const dismiss = () => {
    if (busy) return
    writePref(REPLAN_DISMISSED_KEY, today)
    onDismiss()
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="进度落后,需要你决定" className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-ink-1/25" onClick={dismiss} />
      <Card className="relative w-130 max-w-[92vw] p-7 shadow-pop">
        <h2 className="font-serif text-xl font-semibold text-ink-1">进度落后,需要你决定</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-3">
          《{book.title}》已连续两天没完成新块配额。剩余 {replan.remainingBlocks} 块要在 {Math.max(1, replan.remainingDays)} 天内学完,
          均摊后每日需 {replan.requiredDaily ?? Math.ceil(replan.remainingBlocks / Math.max(1, replan.remainingDays))} 块,超过每日上限 {cap} 块。
          截止日不会被静默修改——请选一种处理方式。
        </p>
        <div className="mt-5 flex flex-col gap-3">
          <button
            disabled={busy}
            onClick={() => { decide.clearError('decide'); void decide.run('decide', 'extend') }}
            className="cursor-pointer rounded-m border border-line bg-paper-1 px-5 py-4 text-left transition-colors hover:border-new hover:bg-paper-3/40 disabled:opacity-60"
          >
            <span className="font-serif text-base font-medium text-ink-1">顺延截止日期到 {newDeadline}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">按每日 {cap} 块的上限重新均摊,地图不变。</span>
          </button>
          <button
            disabled={busy}
            onClick={() => { decide.clearError('decide'); void decide.run('decide', 'trim') }}
            className="cursor-pointer rounded-m border border-line bg-paper-1 px-5 py-4 text-left transition-colors hover:border-new hover:bg-paper-3/40 disabled:opacity-60"
          >
            <span className="font-serif text-base font-medium text-ink-1">缩减地图:跳过 {excess} 个靠后的未学块</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">标记为跳过而非删除,随时可在地图页恢复;截止日不变。</span>
          </button>
        </div>
        {failure && (
          <div className="mt-4">
            <AsyncError error={failure} onRetry={() => void decide.retry('decide')} variant="compact" />
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <Button disabled={busy} onClick={dismiss}>本日不再提醒</Button>
        </div>
      </Card>
    </div>
  )
}
