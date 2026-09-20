import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import EmptyState from '../../components/EmptyState'
import Icon from '../../components/icons/Icon'
import PageHeader from '../../components/PageHeader'
import ProgressRing from '../../components/ProgressRing'
import Skeleton from '../../components/Skeleton'
import Toolbar, { ToolbarSpacer } from '../../components/Toolbar'
import { REPLAN_DISMISSED_KEY } from '../../config'
import { localCalendarDate } from '../../lib/localDate'
import { readPref } from '../../lib/prefs'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useSession } from '../../store'
import type { Book, DailyTask, KnowledgeBlock, PomodoroSnapshot, Replan } from '../../types'
import Pomodoro from './Pomodoro'
import ReplanDialog from './ReplanDialog'
import TaskCard from './TaskCard'

interface QueueBundle {
  tasks: DailyTask[]
  blocks: Map<number, KnowledgeBlock>
  /** 主攻书与其落后检测结果(先于当日队列生成;无主攻书为 null) */
  activeBook: Book | null
  replan: Replan | null
}

/**
 * 今日学习(视觉改版第二批):工具栏带右侧放番茄钟胶囊;页头右侧是统计簇(数据,不是动作);
 * 一次性提示与自动均摊提示合在同一个 role=status 里;空态给「去书架」。
 */
export default function TodayPage() {
  const navigate = useNavigate()
  const setCurrentTaskId = useSession(s => s.setCurrentTaskId)
  // 挂载时固定队列日期:跨午夜重试仍使用同一日期
  const [today] = useState(localCalendarDate)
  // 番茄钟快照:挂载时向后端取当前状态(可能已在运行),之后由面板订阅推送更新
  const [pomodoro, setPomodoro] = useState<PomodoroSnapshot | null>(null)
  const pomodoroState = useAsyncResource(useCallback(() => backend.pomodoroState(), []))
  const focusOp = useBackendOperation(async (task: DailyTask) => {
    setPomodoro(await backend.pomodoroStart(task.id, today))
  })
  const [replanDismissed, setReplanDismissed] = useState(() => readPref(REPLAN_DISMISSED_KEY) === today)
  // 一次性跨页提示:挂载时取走并清空 store(zustand set 非 React setState)
  const [notice] = useState(() => useSession.getState().pendingNotice)
  useEffect(() => {
    if (notice) useSession.getState().setPendingNotice(null)
  }, [notice])

  // 队列与其 blocks hydration 为单一原子 pipeline:全部成功后才发布;失败保留旧快照
  const loadQueueBundle = useCallback(async (isCurrent: () => boolean): Promise<QueueBundle> => {
    // 落后检测必须先于当日队列生成:core 在"均摊 ≤ 上限"时会改写每日新块数(M2 T4)
    const books = await backend.listBooks()
    if (!isCurrent()) throw new StaleResult()
    const activeBook = books.find(b => b.status === 'active') ?? null
    let replan: Replan | null = null
    if (activeBook) {
      replan = await backend.checkBehind(activeBook.id, today)
      if (!isCurrent()) throw new StaleResult()
    }
    const tasks = await backend.todayQueue(today)
    if (!isCurrent()) throw new StaleResult()
    const blocks = new Map<number, KnowledgeBlock>()
    for (const bookId of new Set(tasks.map(t => t.bookId))) {
      for (const b of await backend.listBlocks(bookId)) blocks.set(b.id, b)
      if (!isCurrent()) throw new StaleResult()
    }
    return { tasks, blocks, activeBook, replan }
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

  // 重考/复习直达快问会话(M2 T1);新块先进阅读器再讲授
  const start = (task: DailyTask) => {
    setCurrentTaskId(task.id)
    if (task.kind === 'weak_retest' || task.kind === 'review') navigate(`/feynman/${task.id}`)
    else navigate(`/reader/${task.blockId}?task=${task.id}`)
  }
  const read = (task: DailyTask) => {
    setCurrentTaskId(task.id)
    navigate(`/reader/${task.blockId}?task=${task.id}`)
  }

  const complete = (task: DailyTask) => {
    completion.clearError(task.id)
    void completion.run(task.id, task.id)
  }

  const tasks = queue.data?.tasks ?? null
  const blocks = queue.data?.blocks ?? new Map<number, KnowledgeBlock>()
  const activeBook = queue.data?.activeBook ?? null
  const replan = queue.data?.replan ?? null
  const doneCount = tasks?.filter(t => t.status === 'done').length ?? 0
  const allDone = tasks !== null && tasks.length > 0 && doneCount === tasks.length

  // 一次只存在一个 role=status(跨页提示 + 自动均摊提示合并成一条)
  const notices = [
    notice,
    replan?.status === 'auto_adjusted'
      ? `进度落后,已按剩余天数均摊:今日起每日 ${replan.newDaily} 个新块(截止 ${replan.deadline} 不变)。`
      : null,
  ].filter((n): n is string => typeof n === 'string' && n.length > 0)

  const pomodoroSnapshot = pomodoro ?? pomodoroState.data
  const pomodoroTask = pomodoroSnapshot?.taskId == null ? undefined : tasks?.find(t => t.id === pomodoroSnapshot.taskId)
  const pomodoroTitle = pomodoroTask ? (blocks.get(pomodoroTask.blockId)?.title ?? `任务 #${pomodoroTask.id}`) : '专注'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="今日工具栏">
        <ToolbarSpacer />
        {pomodoroSnapshot && pomodoroSnapshot.phase !== 'idle' && (
          <Pomodoro snapshot={pomodoroSnapshot} taskTitle={pomodoroTitle} onSnapshot={setPomodoro} />
        )}
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-y-auto @container">
        <div className="mx-auto w-full max-w-[56rem] px-8 pt-6 pb-16">
          <PageHeader
            title="今日学习"
            subtitle={`${today} · 薄弱重考 → 间隔复习 → 新块攻克`}
            actions={
              stats.data && (
                <div className="flex items-center gap-4">
                  <div className="text-right text-footnote leading-relaxed text-label-3">
                    <div>
                      连续 <span className="font-semibold text-label-1 tabular-nums">{stats.data.streakDays}</span> 天
                    </div>
                    <div>
                      今日 <span className="font-semibold text-label-1 tabular-nums">{stats.data.minutesToday}</span> 分钟
                    </div>
                  </div>
                  <ProgressRing
                    size={56}
                    stroke={4}
                    value={stats.data.totalBlocks ? stats.data.passedBlocks / stats.data.totalBlocks : 0}
                    label={`${stats.data.passedBlocks}/${stats.data.totalBlocks}`}
                    color="var(--signal-ok)"
                  />
                </div>
              )
            }
          />

          {notices.length > 0 && (
            <div role="status" className="mb-6 flex items-start gap-2.5 rounded-m border border-review/40 bg-review-soft/50 px-4 py-3 text-callout leading-relaxed text-label-1">
              <Icon name="info-circle" size={16} className="mt-px shrink-0 text-review" />
              <div className="min-w-0">
                {notices.map((n, i) => <p key={i}>{n}</p>)}
              </div>
            </div>
          )}

          {stats.error && (
            <div className="mb-6">
              <AsyncError error={stats.error} onRetry={stats.reload} variant="compact" />
            </div>
          )}
          {pomodoroState.error && pomodoro === null && (
            <div className="mb-6">
              <AsyncError error={pomodoroState.error} onRetry={pomodoroState.reload} variant="compact" />
            </div>
          )}
          {focusOp.errors.get('focus') && (
            <div className="mb-6">
              <AsyncError error={focusOp.errors.get('focus')!} onRetry={() => void focusOp.retry('focus')} variant="compact" />
            </div>
          )}

          {queue.error && tasks !== null && (
            <div className="mb-6">
              <AsyncError error={queue.error} onRetry={reloadQueue} variant="compact" />
            </div>
          )}

          {allDone && (
            <div className="mb-6 flex items-start gap-2.5 rounded-m border border-ok/40 bg-ok-soft/50 px-4 py-3 text-callout leading-relaxed text-label-1">
              <Icon name="checkmark-seal" size={16} className="mt-px shrink-0 text-ok" />
              <p>今日队列全部完成——把余下的时间还给生活,明天继续。</p>
            </div>
          )}

          {queue.error && tasks === null ? (
            <AsyncError error={queue.error} onRetry={reloadQueue} />
          ) : tasks === null ? (
            <div aria-busy="true" className="flex flex-col gap-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="rounded-l border border-sep bg-card px-5 py-4">
                  <Skeleton lines={2} />
                </div>
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              icon="sun"
              title="今天没有排定的任务"
              body="学习是长跑,休整也是节奏的一部分。去书架挑一本书设定目标,明天的队列会在这里等你。"
              action={
                <Button size="sm" onClick={() => navigate('/library')}>
                  去书架
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              {tasks.map((task, i) => {
                const failure = completion.errors.get(task.id)
                const completionUnavailable = failure?.retryable === false
                return (
                  <div key={task.id} data-testid={`task-row-${task.id}`} className="flex flex-col gap-2">
                    <TaskCard
                      task={task}
                      block={blocks.get(task.blockId)}
                      index={i}
                      onStart={start}
                      onComplete={complete}
                      onFocus={task => { focusOp.clearError('focus'); void focusOp.run('focus', task) }}
                      onRead={read}
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

          {activeBook && replan?.status === 'needs_decision' && !replanDismissed && (
            <ReplanDialog
              book={activeBook}
              replan={replan}
              today={today}
              onResolved={reloadQueue}
              onDismiss={() => setReplanDismissed(true)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
