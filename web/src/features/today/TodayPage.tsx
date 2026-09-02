import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { normalizeBackendError, type BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import ProgressRing from '../../components/ProgressRing'
import { localCalendarDate } from '../../lib/localDate'
import { useSession } from '../../store'
import type { DailyTask, KnowledgeBlock, Stats } from '../../types'
import Pomodoro from './Pomodoro'
import TaskCard from './TaskCard'

export default function TodayPage() {
  const navigate = useNavigate()
  const setCurrentTaskId = useSession(s => s.setCurrentTaskId)
  const [today] = useState(localCalendarDate)
  const [tasks, setTasks] = useState<DailyTask[] | null>(null)
  const [blocks, setBlocks] = useState<Map<number, KnowledgeBlock>>(new Map())
  const [stats, setStats] = useState<Stats | null>(null)
  const [focusTask, setFocusTask] = useState<DailyTask | null>(null)
  const [queueError, setQueueError] = useState<BackendError | null>(null)
  const [statsError, setStatsError] = useState<BackendError | null>(null)
  const [operationFailures, setOperationFailures] = useState<Map<number, BackendError>>(new Map())
  const completionGuards = useRef(new Set<number>())
  const committedCompletionGuards = useRef(new Set<number>())
  const queueGeneration = useRef(0)
  const statsGeneration = useRef(0)
  const operationGenerations = useRef(new Map<number, number>())
  const mounted = useRef(false)
  const [blockedTaskIds, setBlockedTaskIds] = useState<Set<number>>(new Set())

  const releaseCompletionGuard = useCallback((taskId: number) => {
    completionGuards.current.delete(taskId)
    committedCompletionGuards.current.delete(taskId)
    setBlockedTaskIds(new Set(completionGuards.current))
  }, [])

  const releaseCommittedCompletionGuards = useCallback(() => {
    for (const taskId of committedCompletionGuards.current) {
      completionGuards.current.delete(taskId)
    }
    committedCompletionGuards.current.clear()
    setBlockedTaskIds(new Set(completionGuards.current))
  }, [])

  const loadQueue = useCallback(async () => {
    if (!mounted.current) return false
    const generation = ++queueGeneration.current
    setQueueError(null)
    try {
      const queue = await backend.todayQueue(today)
      if (!mounted.current || generation !== queueGeneration.current) return false
      const map = new Map<number, KnowledgeBlock>()
      for (const bookId of new Set(queue.map(t => t.bookId))) {
        for (const b of await backend.listBlocks(bookId)) map.set(b.id, b)
        if (!mounted.current || generation !== queueGeneration.current) return false
      }
      if (!mounted.current || generation !== queueGeneration.current) return false
      setTasks(queue)
      setBlocks(map)
      releaseCommittedCompletionGuards()
      return true
    } catch (error) {
      if (!mounted.current || generation !== queueGeneration.current) return false
      setQueueError(normalizeBackendError(error))
      return false
    }
  }, [releaseCommittedCompletionGuards, today])

  const loadStats = useCallback(async () => {
    if (!mounted.current) return
    const generation = ++statsGeneration.current
    setStatsError(null)
    try {
      const nextStats = await backend.stats()
      if (!mounted.current || generation !== statsGeneration.current) return
      setStats(nextStats)
    } catch (error) {
      if (!mounted.current || generation !== statsGeneration.current) return
      setStatsError(normalizeBackendError(error))
    }
  }, [])

  useEffect(() => {
    const operationGenerationMap = operationGenerations.current
    const completionGuardSet = completionGuards.current
    const committedCompletionGuardSet = committedCompletionGuards.current
    mounted.current = true
    loadQueue()
    loadStats()
    return () => {
      mounted.current = false
      queueGeneration.current += 1
      statsGeneration.current += 1
      operationGenerationMap.clear()
      completionGuardSet.clear()
      committedCompletionGuardSet.clear()
    }
  }, [loadQueue, loadStats])

  const start = (task: DailyTask) => {
    setCurrentTaskId(task.id)
    if (task.kind === 'weak_retest') navigate(`/feynman/${task.id}`)
    else navigate(`/reader/${task.blockId}?task=${task.id}`)
  }

  const completeTask = async (taskId: number) => {
    if (completionGuards.current.has(taskId)) return
    const generation = (operationGenerations.current.get(taskId) ?? 0) + 1
    operationGenerations.current.set(taskId, generation)
    completionGuards.current.add(taskId)
    setBlockedTaskIds(new Set(completionGuards.current))
    setOperationFailures(current => {
      const next = new Map(current)
      next.delete(taskId)
      return next
    })
    try {
      await backend.completeTask(taskId)
      if (!mounted.current || operationGenerations.current.get(taskId) !== generation) return
      committedCompletionGuards.current.add(taskId)
      await loadQueue()
    } catch (error) {
      if (!mounted.current || operationGenerations.current.get(taskId) !== generation) return
      const failure = normalizeBackendError(error)
      setOperationFailures(current => new Map(current).set(taskId, failure))
      if (failure.retryable) releaseCompletionGuard(taskId)
    }
  }

  const complete = (task: DailyTask) => completeTask(task.id)

  const doneCount = tasks?.filter(t => t.status === 'done').length ?? 0
  const allDone = tasks !== null && tasks.length > 0 && doneCount === tasks.length

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader
        title="今日学习"
        subtitle={`${today} · 薄弱重考 → 间隔复习 → 新块攻克`}
        actions={
          stats && (
            <div className="flex items-center gap-5">
              <div className="text-right text-xs leading-relaxed text-ink-3">
                <div>
                  连续 <span className="font-semibold text-ink-1">{stats.streakDays}</span> 天
                </div>
                <div>
                  今日 <span className="font-semibold text-ink-1">{stats.minutesToday}</span> 分钟
                </div>
              </div>
              <ProgressRing
                value={stats.totalBlocks ? stats.passedBlocks / stats.totalBlocks : 0}
                label={`${stats.passedBlocks}/${stats.totalBlocks}`}
                color="var(--c-ok)"
              />
            </div>
          )
        }
      />

      {statsError && (
        <div className="mb-6">
          <AsyncError error={statsError} onRetry={loadStats} variant="compact" />
        </div>
      )}

      {queueError && tasks !== null && (
        <div className="mb-6">
          <AsyncError error={queueError} onRetry={loadQueue} variant="compact" />
        </div>
      )}

      {allDone && (
        <Card className="mb-6 border-ok/40 bg-paper-2 p-5 text-sm text-ok">
          今日队列全部完成——把余下的时间还给生活,明天继续。
        </Card>
      )}

      {queueError && tasks === null ? (
        <AsyncError error={queueError} onRetry={loadQueue} />
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
            const operationFailure = operationFailures.get(task.id)
            const completionUnavailable = operationFailure?.retryable === false
            return (
              <div key={task.id} data-testid={`task-row-${task.id}`} className="flex flex-col gap-2">
                <TaskCard
                  task={task}
                  block={blocks.get(task.blockId)}
                  onStart={start}
                  onComplete={complete}
                  onFocus={setFocusTask}
                  completing={blockedTaskIds.has(task.id) && !completionUnavailable}
                  completionUnavailable={completionUnavailable}
                />
                {operationFailure && (
                  <AsyncError
                    error={operationFailure}
                    onRetry={() => completeTask(task.id)}
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
