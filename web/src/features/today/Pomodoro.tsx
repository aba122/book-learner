import { useEffect, useState } from 'react'
import Button from '../../components/Button'
import Card from '../../components/Card'
import { POMODORO_DEFAULT } from '../../config'

type Phase = 'work' | 'break'

export default function Pomodoro({ taskTitle, onStop }: { taskTitle: string; onStop: () => void }) {
  const [st, setSt] = useState<{ phase: Phase; seconds: number }>({
    phase: 'work',
    seconds: POMODORO_DEFAULT.work * 60,
  })

  useEffect(() => {
    const id = setInterval(() => {
      setSt(cur => {
        if (cur.seconds > 0) return { ...cur, seconds: cur.seconds - 1 }
        if (cur.phase === 'work') return { phase: 'break', seconds: POMODORO_DEFAULT.break * 60 }
        return cur
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (st.phase === 'break' && st.seconds === 0) onStop()
  }, [st, onStop])

  const mm = Math.floor(st.seconds / 60)
  const ss = String(st.seconds % 60).padStart(2, '0')

  return (
    <Card className="fixed right-8 bottom-8 z-40 flex items-center gap-5 px-6 py-4 shadow-pop">
      <div>
        <div className="text-xs text-ink-3">
          {st.phase === 'work' ? '专注中' : '小憩片刻'} · {taskTitle}
        </div>
        <div className="font-serif text-3xl font-semibold text-ink-1 tabular-nums">
          {mm}:{ss}
        </div>
      </div>
      <Button onClick={onStop}>结束</Button>
    </Card>
  )
}
