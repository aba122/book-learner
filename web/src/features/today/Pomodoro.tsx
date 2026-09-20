import { useCallback, useEffect, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Icon from '../../components/icons/Icon'
import IconButton from '../../components/IconButton'
import Popover from '../../components/Popover'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { PomodoroSnapshot } from '../../types'

/**
 * 番茄钟胶囊(M2 T3;视觉改版第二批从右下浮动卡搬进工具栏带):状态机在后端,本组件只按快照渲染。
 * 倒计时用 endsAt − Date.now() 本地计算(每秒重绘),阶段切换经 subscribePomodoro 推送;
 * 暂停/继续/结束经 useBackendOperation,失败在胶囊尾部给出警示钮 → Popover 里重试。
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

  // 控制失败:胶囊尾部出现警示钮并自动展开浮层;关掉后记住"已看过这个错误",再点警示钮可重开
  const [errorAnchor, setErrorAnchor] = useState<HTMLElement | null>(null)
  const [seenFailure, setSeenFailure] = useState<unknown>(null)
  const errorOpen = failure !== undefined && seenFailure !== failure

  const remaining = snapshot.endsAt === null
    ? snapshot.remainingSecs
    : Math.max(0, snapshot.endsAt - Math.floor(now / 1000))
  const mm = Math.floor(remaining / 60)
  const ss = String(remaining % 60).padStart(2, '0')
  const label = snapshot.phase === 'work' ? '专注中' : snapshot.phase === 'break' ? '小憩片刻' : '已暂停'

  return (
    <div
      data-testid="pomodoro"
      className="flex h-7 max-w-full items-center gap-1.5 rounded-full bg-inset pr-1 pl-2.5 ring-1 ring-sep/60"
    >
      <Icon name="timer" size={14} className={snapshot.phase === 'work' ? 'text-accent' : 'text-label-3'} />
      <span className="text-body font-semibold text-label-1 tabular-nums">{mm}:{ss}</span>
      <span className="min-w-0 truncate text-subhead text-label-3">
        {label}
        <span className="hidden @lg:inline"> · {taskTitle}</span>
      </span>
      <span aria-hidden className="mx-0.5 h-3.5 w-px bg-sep" />
      {snapshot.phase === 'paused' ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run('resume')}>继续</Button>
      ) : (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run('pause')}>暂停</Button>
      )}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => run('stop')}>结束</Button>
      {failure && (
        <>
          <IconButton ref={setErrorAnchor} icon="exclamation-triangle" label="番茄钟操作失败" size="sm" className="text-weak" onClick={() => setSeenFailure(null)} />
          <Popover open={errorOpen} onClose={() => setSeenFailure(failure)} anchor={errorAnchor} aria-label="番茄钟操作失败" placement="bottom-end" className="w-80">
            <AsyncError error={failure} onRetry={() => void control.retry('control')} variant="compact" />
          </Popover>
        </>
      )}
    </div>
  )
}
