import type { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import Tag from '../../components/Tag'
import type { EvalResult } from '../../types'

function StarRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-ink-2">{label}</span>
      <span data-testid="eval-stars" aria-label={`${value} 星`} className="text-review">
        {'★'.repeat(value)}
        <span className="text-ink-4">{'☆'.repeat(Math.max(0, 5 - value))}</span>
      </span>
    </div>
  )
}

export default function EvalCard({
  result,
  onConfirm,
  error = null,
  onRetry,
  busy = false,
  confirmDisabled = false,
}: {
  result: EvalResult
  onConfirm: (pass: boolean) => void
  /** 确认判定的后端错误:在卡内显示,不导航 */
  error?: BackendError | null
  onRetry?: () => void
  busy?: boolean
  /** 不可重试错误:禁用"确认通过",避免重复提交 */
  confirmDisabled?: boolean
}) {
  const pass = result.verdict === 'pass_suggested'
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="讲授评估"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-ink-1/30" />
      <Card className="relative flex max-h-[88vh] w-130 max-w-[94vw] flex-col gap-4 overflow-y-auto p-7 shadow-pop">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-xl font-semibold text-ink-1">讲授评估</h2>
          <Tag tone={pass ? 'ok' : 'weak'}>{pass ? '建议通过' : '建议再学'}</Tag>
        </div>

        <p className="text-sm leading-relaxed text-ink-2">{result.summary}</p>

        <div className="flex flex-col gap-2 rounded-m bg-paper-3/50 px-4 py-3">
          <StarRow label="准确度" value={result.scores.accuracy} />
          <StarRow label="完整度" value={result.scores.completeness} />
          <StarRow label="清晰度" value={result.scores.clarity} />
        </div>

        {result.weakPoints.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-3">暴露的薄弱点</h3>
            <ul className="flex flex-col gap-2">
              {result.weakPoints.map(wp => (
                <li key={wp.title} className="rounded-m border border-line px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-serif text-sm font-medium text-ink-1">{wp.title}</span>
                    {wp.fixedInSession ? (
                      <Tag tone="ok">已当场修复</Tag>
                    ) : (
                      <Tag tone="weak">待回补</Tag>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-3">{wp.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-m border-l-2 border-review bg-review-soft/40 px-4 py-3">
          <h3 className="text-xs font-medium tracking-wide text-ink-3">给讲授者的建议</h3>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">{result.observationNote}</p>
        </div>

        {error && <AsyncError error={error} onRetry={onRetry} variant="compact" />}

        <div className="mt-1 flex justify-end gap-2">
          <Button disabled={busy} onClick={() => onConfirm(false)}>暂不通过,再学一遍</Button>
          <Button variant="primary" disabled={busy || confirmDisabled} onClick={() => onConfirm(true)}>
            {confirmDisabled ? '确认暂不可用' : busy ? '保存中…' : '确认通过'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
