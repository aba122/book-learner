import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import ProgressRing from '../../components/ProgressRing'
import { localCalendarDate } from '../../lib/localDate'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useSession } from '../../store'
import type { DailyTask, KnowledgeBlock } from '../../types'
import Pomodoro from './Pomodoro'
import TaskCard from './TaskCard'

interface QueueBundle {
  tasks: DailyTask[]
  blocks: Map<number, KnowledgeBlock>
}

export default function TodayPage() {
  const navigate = useNavigate()
  const setCurrentTaskId = useSession(s => s.setCurrentTaskId)
  // 挂载时固定队列日期:跨午夜重试仍使用同一日期
  const [today] = useState(localCalendarDate)
  const [focusTask, setFocusTask] = useState<DailyTask | null>(null)

  // 队列与其 blocks hydration 为单一原子 pipeline:全部成功后才发布;失败保留旧快照
  const loadQueueBundle = useCallback(async (isCurrent: () => boolean): Promise<QueueBundle> => {
    const tasks = await backend.todayQueue(today)
    if (!isCurrent()) throw new StaleResult()
    const blocks = new Map<number, KnowledgeBlock>()
    for (const bookId of new Set(tasks.map(t => t.bookId))) {
      for (const b of await backend.listBlocks(bookId)) blocks.set(b.id, b)
      if (!isCurrent()) throw new StaleResult()
    }
    return { tasks, blocks }
  }, [today])
  const queue = useAsyncResource(loadQueueBundle)
  const stats = useAsyncResource(useCallback(() => backend.stats(), []))

  const completion = useBackendOperation(
    (taskId: number) => backend.completeTask(taskId),
    {
      onCommitted: async () => {
        void stats.reload() // 进度环/今日分钟需更新;stats 失败不得持有完成守卫
        if (!(await reloadQueue())) throw new Error('queue refresh failed')
      },
    },
  )

  // 队列刷新成功 → 释放"已提交待刷新"守卫,并清除 conflict 等错误(其文案要求"刷新后重试")
  const reloadQueue = async () => {
    const ok = await queue.reload()
    if (ok) {
      completion.releaseCommitted()
      completion.clearAllErrors()
    }
    return ok
  }

  const start = (task: DailyTask) => {
    setCurrentTaskId(task.id)
    if (task.kind === 'weak_retest') navigate(`/feynman/${task.id}`)
    else navigate(`/reader/${task.blockId}?task=${task.id}`)
  }

  const complete = (task: DailyTask) => {
    completion.clearError(task.id)
    void completion.run(task.id, task.id)
  }

  const tasks = queue.data?.tasks ?? null
  const blocks = queue.data?.blocks ?? new Map<number, KnowledgeBlock>()
  const doneCount = tasks?.filter(t => t.status === 'done').length ?? 0
  const allDone = tasks !== null && tasks.length > 0 && doneCount === tasks.length

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader
        title="今日学习"
        subtitle={`${today} · 薄弱重考 → 间隔复习 → 新块攻克`}
        actions={
          stats.data && (
            <div className="flex items-center gap-5">
              <div className="text-right text-xs leading-relaxed text-ink-3">
                <div>
                  连续 <span className="font-semibold text-ink-1">{stats.data.streakDays}</span> 天
                </div>
                <div>
                  今日 <span className="font-semibold text-ink-1">{stats.data.minutesToday}</span> 分钟
                </div>
              </div>
              <ProgressRing
                value={stats.data.totalBlocks ? stats.data.passedBlocks / stats.data.totalBlocks : 0}
                label={`${stats.data.passedBlocks}/${stats.data.totalBlocks}`}
                color="var(--c-ok)"
              />
            </div>
          )
        }
      />

      {stats.error && (
        <div className="mb-6">
          <AsyncError error={stats.error} onRetry={stats.reload} variant="compact" />
        </div>
      )}

      {queue.error && tasks !== null && (
        <div className="mb-6">
          <AsyncError error={queue.error} onRetry={reloadQueue} variant="compact" />
        </div>
      )}

      {allDone && (
        <Card className="mb-6 border-ok/40 bg-paper-2 p-5 text-sm text-ok">
          今日队列全部完成——把余下的时间还给生活,明天继续。
        </Card>
      )}

      {queue.error && tasks === null ? (
        <AsyncError error={queue.error} onRetry={reloadQueue} />
      ) : tasks === null ? (
        <p className="text-sm text-ink-3">正在取回今日队列…</p>
      ) : tasks.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="font-serif text-xl text-ink-1">今天没有排定的任务</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-3">
            学习是长跑,休整也是节奏的一部分。去书架挑一本书设定目标,明天的队列会在这里等你。
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {tasks.map(task => {
            const failure = completion.errors.get(task.id)
            const completionUnavailable = failure?.retryable === false
            return (
              <div key={task.id} data-testid={`task-row-${task.id}`} className="flex flex-col gap-2">
                <TaskCard
                  task={task}
                  block={blocks.get(task.blockId)}
                  onStart={start}
                  onComplete={complete}
                  onFocus={setFocusTask}
                  completing={completion.pending.has(task.id) && !completionUnavailable}
                  completionUnavailable={completionUnavailable}
                />
                {failure && (
                  <AsyncError
                    error={failure}
                    onRetry={() => complete(task)}
                    variant="compact"
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {focusTask && (
        <Pomodoro
          taskTitle={blocks.get(focusTask.blockId)?.title ?? `任务 #${focusTask.id}`}
          onStop={() => setFocusTask(null)}
        />
      )}
    </div>
  )
}
