import Button from '../../components/Button'
import Card from '../../components/Card'
import Tag, { type TagTone } from '../../components/Tag'
import { KIND_LABEL } from '../../config'
import type { DailyTask, KnowledgeBlock, TaskKind } from '../../types'

const BAR: Record<TaskKind, string> = {
  weak_retest: 'bg-weak',
  review: 'bg-review',
  new: 'bg-new',
}
const TONE: Record<TaskKind, TagTone> = {
  weak_retest: 'weak',
  review: 'review',
  new: 'new',
}

/**
 * 任务卡(视觉改版第二批):4px 左色条是全 app 的签名(三任务色只标数据);序号说明队列是有序的
 * (薄弱重考 → 复习 → 新块);按钮 sm,每卡一个 primary;窄容器下按钮组换到第二行。
 */
export default function TaskCard({
  task,
  block,
  index,
  onStart,
  onComplete,
  onFocus,
  onRead,
  completing = false,
  completionUnavailable = false,
}: {
  task: DailyTask
  block?: KnowledgeBlock
  /** 队列序号(0 起);给了才显示 */
  index?: number
  onStart: (task: DailyTask) => void
  onComplete: (task: DailyTask) => void
  onFocus: (task: DailyTask) => void
  /** 回读原文(review 卡):进入阅读器而非开始会话 */
  onRead?: (task: DailyTask) => void
  completing?: boolean
  completionUnavailable?: boolean
}) {
  const done = task.status === 'done'
  const completeLabel = completionUnavailable ? '讲完自动完成' : completing ? '处理中…' : '完成'
  const completeTitle = completionUnavailable ? '这项任务在讲授并确认判定后自动完成' : undefined
  return (
    <Card
      data-testid="task-card"
      className={`flex items-stretch overflow-hidden p-0 transition-opacity duration-[var(--dur-base)] ${done ? 'opacity-55' : ''}`}
    >
      <div aria-hidden className={`w-1 shrink-0 ${BAR[task.kind]}`} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-3 py-3.5 pr-4 pl-4">
        {index !== undefined && (
          <span className="w-6 shrink-0 self-start pt-0.5 font-serif text-subhead text-label-3 tabular-nums">
            {String(index + 1).padStart(2, '0')}
          </span>
        )}
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Tag tone={TONE[task.kind]}>{KIND_LABEL[task.kind]}</Tag>
            <span className="text-footnote text-label-2">预计 {task.estMinutes} 分钟</span>
          </div>
          <h3 className="mt-1.5 truncate font-serif text-title3 font-medium text-label-1">
            {block?.title ?? `知识块 #${task.blockId}`}
          </h3>
          {block && <p className="mt-0.5 truncate text-footnote text-label-3">{block.moduleName}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {done ? (
            <Tag tone="ok">已完成</Tag>
          ) : (
            <>
              <Button size="sm" onClick={() => onFocus(task)}>专注</Button>
              {task.kind === 'new' && (
                <Button size="sm" variant="primary" onClick={() => onStart(task)}>
                  开始
                </Button>
              )}
              {task.kind === 'weak_retest' && (
                <>
                  <Button size="sm" disabled={completing || completionUnavailable} title={completeTitle} onClick={() => onComplete(task)}>
                    {completeLabel}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => onStart(task)}>
                    开始重考
                  </Button>
                </>
              )}
              {task.kind === 'review' && (
                <>
                  <Button size="sm" disabled={completing || completionUnavailable} title={completeTitle} onClick={() => onComplete(task)}>
                    {completeLabel}
                  </Button>
                  <Button size="sm" onClick={() => (onRead ?? onStart)(task)}>回读原文</Button>
                  <Button size="sm" variant="primary" onClick={() => onStart(task)}>
                    开始复习
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
