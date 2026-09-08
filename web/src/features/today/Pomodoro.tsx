import { useCallback, useEffect, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { PomodoroSnapshot } from '../../types'

/**
 * 番茄钟面板(M2 T3):状态机在后端,本组件只按快照渲染。倒计时用 endsAt − Date.now() 本地计算
 * (每秒重绘),阶段切换经 subscribePomodoro 推送;暂停/继续/结束经 useBackendOperation。
 */
export default function Pomodoro({
  snapshot,
  taskTitle,
  onSnapshot,
}: {
  snapshot: PomodoroSnapshot
  taskTitle: string
  onSnapshot: (snapshot: PomodoroSnapshot) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (snapshot.endsAt === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [snapshot.endsAt])

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let cancelled = false
    void backend.subscribePomodoro(next => onSnapshot(next)).then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [onSnapshot])

  const control = useBackendOperation(
    async (action: 'pause' | 'resume' | 'stop') => {
      const next = action === 'pause'
        ? await backend.pomodoroPause()
        : action === 'resume'
          ? await backend.pomodoroResume()
          : await backend.pomodoroStop()
      onSnapshot(next)
    },
  )
  const busy = control.pending.size > 0
  const failure = control.errors.get('control')
  const run = useCallback((action: 'pause' | 'resume' | 'stop') => {
    control.clearError('control')
    void control.run('control', action)
  }, [control])

  const remaining = snapshot.endsAt === null
    ? snapshot.remainingSecs
    : Math.max(0, snapshot.endsAt - Math.floor(now / 1000))
  const mm = Math.floor(remaining / 60)
  const ss = String(remaining % 60).padStart(2, '0')
  const label = snapshot.phase === 'work' ? '专注中' : snapshot.phase === 'break' ? '小憩片刻' : '已暂停'

  return (
    <Card className="fixed right-8 bottom-8 z-40 flex items-center gap-5 px-6 py-4 shadow-pop" data-testid="pomodoro">
      <div>
        <div className="text-xs text-ink-3">
          {label} · {taskTitle}
        </div>
        <div className="font-serif text-3xl font-semibold text-ink-1 tabular-nums">
          {mm}:{ss}
        </div>
        {failure && <AsyncError error={failure} onRetry={() => void control.retry('control')} variant="compact" />}
      </div>
      {snapshot.phase === 'paused' ? (
        <Button disabled={busy} onClick={() => run('resume')}>继续</Button>
      ) : (
        <Button disabled={busy} onClick={() => run('pause')}>暂停</Button>
      )}
      <Button disabled={busy} onClick={() => run('stop')}>结束</Button>
    </Card>
  )
}
