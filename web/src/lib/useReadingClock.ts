import { useEffect } from 'react'
import { backend } from '../backend'
import { READING_CLOCK_FLUSH_SECS, READING_CLOCK_IDLE_SECS } from '../config'
import { localCalendarDate } from './localDate'

/**
 * 阅读计时(BL-025):挂在阅读器上。每秒判定一次"页面可见 且 最近 READING_CLOCK_IDLE_SECS 内有操作"才计 1 秒;
 * 累计到 READING_CLOCK_FLUSH_SECS 落一笔,页面隐藏 / 卸载 / 换书时把零头补上。落库失败静默(下次再记)。
 * 操作 = 指针 / 键盘 / 滚轮(正文上的指针层与全局 ←/→ 都在 window 上);不依赖 epub.js 事件。
 */
export function useReadingClock(bookId: number | null, active: boolean): void {
  useEffect(() => {
    if (bookId === null || !active) return
    let acc = 0
    let lastActivity = Date.now()
    const mark = () => {
      lastActivity = Date.now()
    }
    const flush = () => {
      if (acc <= 0) return
      const seconds = acc
      acc = 0
      backend.readingTimeAdd(bookId, localCalendarDate(), seconds).catch(() => {
        /* 记不上就算了,不打断阅读 */
      })
    }
    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastActivity > READING_CLOCK_IDLE_SECS * 1000) return
      acc += 1
      if (acc >= READING_CLOCK_FLUSH_SECS) flush()
    }, 1000)
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') flush()
      else mark()
    }
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.addEventListener(type, mark, { passive: true, capture: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      clearInterval(tick)
      for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.removeEventListener(type, mark, { capture: true })
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [bookId, active])
}
