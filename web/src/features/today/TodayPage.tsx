import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
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
  const [tasks, setTasks] = useState<DailyTask[] | null>(null)
  const [blocks, setBlocks] = useState<Map<number, KnowledgeBlock>>(new Map())
  const [stats, setStats] = useState<Stats | null>(null)
  const [focusTask, setFocusTask] = useState<DailyTask | null>(null)

  const reload = useCallback(async () => {
    const queue = await backend.todayQueue(localCalendarDate())
    setTasks(queue)
    const map = new Map<number, KnowledgeBlock>()
    for (const bookId of new Set(queue.map(t => t.bookId))) {
      for (const b of await backend.listBlocks(bookId)) map.set(b.id, b)
    }
    setBlocks(map)
    setStats(await backend.stats())
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const start = (task: DailyTask) => {
    setCurrentTaskId(task.id)
    if (task.kind === 'weak_retest') navigate(`/feynman/${task.id}`)
    else navigate(`/reader/${task.blockId}?task=${task.id}`)
  }

  const complete = async (task: DailyTask) => {
    await backend.completeTask(task.id)
    await reload()
  }

  const doneCount = tasks?.filter(t => t.status === 'done').length ?? 0
  const allDone = tasks !== null && tasks.length > 0 && doneCount === tasks.length

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader
        title="今日学习"
        subtitle={`${localCalendarDate()} · 薄弱重考 → 间隔复习 → 新块攻克`}
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

      {allDone && (
        <Card className="mb-6 border-ok/40 bg-paper-2 p-5 text-sm text-ok">
          今日队列全部完成——把余下的时间还给生活,明天继续。
        </Card>
      )}

      {tasks === null ? (
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
          {tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              block={blocks.get(task.blockId)}
              onStart={start}
              onComplete={complete}
              onFocus={setFocusTask}
            />
          ))}
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
