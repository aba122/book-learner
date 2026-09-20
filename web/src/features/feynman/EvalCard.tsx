import type { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Dialog from '../../components/Dialog'
import Tag from '../../components/Tag'
import type { EvalResult } from '../../types'

function StarRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-h-[34px] items-center justify-between px-3">
      <span className="text-body text-label-1">{label}</span>
      <span data-testid="eval-stars" role="img" aria-label={`${value} 星`} className="text-callout tracking-wider text-review">
        {'★'.repeat(value)}
        <span className="text-label-4">{'☆'.repeat(Math.max(0, 5 - value))}</span>
      </span>
    </div>
  )
}

/**
 * 讲授评估卡(视觉改版第三批改用 Dialog,不可关:两个判定按钮就是出口):
 * 建议判定 + 总评 → 三项评分(内嵌列表)→ 暴露的薄弱点 → 给讲授者的建议 → 暂不通过 / 确认通过。
 */
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
    <Dialog
      open
      title="讲授评估"
      size="lg"
      dismissible={false}
      footer={
        <>
          <Button disabled={busy} onClick={() => onConfirm(false)}>暂不通过,再学一遍</Button>
          <Button variant="primary" disabled={busy || confirmDisabled} onClick={() => onConfirm(true)}>
            {confirmDisabled ? '确认暂不可用' : busy ? '保存中…' : '确认通过'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Tag tone={pass ? 'ok' : 'weak'} className="mt-0.5 shrink-0">{pass ? '建议通过' : '建议再学'}</Tag>
          <p className="text-body leading-relaxed text-label-1">{result.summary}</p>
        </div>

        <div className="divide-y divide-sep rounded-m bg-inset py-0.5">
          <StarRow label="准确度" value={result.scores.accuracy} />
          <StarRow label="完整度" value={result.scores.completeness} />
          <StarRow label="清晰度" value={result.scores.clarity} />
        </div>

        {result.weakPoints.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-footnote font-medium text-label-3">暴露的薄弱点</h3>
            <ul className="divide-y divide-sep rounded-m ring-1 ring-sep">
              {result.weakPoints.map(wp => (
                <li key={wp.title} className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-serif text-body font-medium text-label-1">{wp.title}</span>
                    {wp.fixedInSession ? (
                      <Tag tone="ok">已当场修复</Tag>
                    ) : (
                      <Tag tone="weak">待回补</Tag>
                    )}
                  </div>
                  <p className="mt-0.5 text-footnote leading-relaxed text-label-2">{wp.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-m border-l-2 border-review bg-review-soft/40 px-3 py-2.5">
          <h3 className="text-footnote font-medium text-label-3">给讲授者的建议</h3>
          <p className="mt-0.5 text-body leading-relaxed text-label-1">{result.observationNote}</p>
        </div>

        {error && <AsyncError error={error} onRetry={onRetry} variant="compact" />}
      </div>
    </Dialog>
  )
}
