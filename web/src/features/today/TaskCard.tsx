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

export default function TaskCard({
  task,
  block,
  onStart,
  onComplete,
  onFocus,
}: {
  task: DailyTask
  block?: KnowledgeBlock
  onStart: (task: DailyTask) => void
  onComplete: (task: DailyTask) => void
  onFocus: (task: DailyTask) => void
}) {
  const done = task.status === 'done'
  return (
    <Card
      data-testid="task-card"
      className={`flex items-stretch gap-4 overflow-hidden p-0 transition-opacity ${done ? 'opacity-55' : ''}`}
    >
      <div aria-hidden className={`w-1 shrink-0 ${BAR[task.kind]}`} />
      <div className="flex min-w-0 flex-1 items-center justify-between gap-4 py-4 pr-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Tag tone={TONE[task.kind]}>{KIND_LABEL[task.kind]}</Tag>
            <span className="text-xs text-ink-4">预计 {task.estMinutes} 分钟</span>
          </div>
          <h3 className="mt-1.5 truncate font-serif text-lg font-medium text-ink-1">
            {block?.title ?? `知识块 #${task.blockId}`}
          </h3>
          {block && <p className="mt-0.5 text-xs text-ink-3">{block.moduleName}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {done ? (
            <Tag tone="ok">已完成</Tag>
          ) : (
            <>
              <Button onClick={() => onFocus(task)}>专注</Button>
              {task.kind === 'new' && (
                <Button variant="primary" onClick={() => onStart(task)}>
                  开始
                </Button>
              )}
              {task.kind === 'weak_retest' && (
                <>
                  <Button onClick={() => onComplete(task)}>完成</Button>
                  <Button variant="primary" onClick={() => onStart(task)}>
                    开始重考
                  </Button>
                </>
              )}
              {task.kind === 'review' && (
                <>
                  <Button variant="primary" onClick={() => onComplete(task)}>
                    完成
                  </Button>
                  <Button onClick={() => onStart(task)}>回读原文</Button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
