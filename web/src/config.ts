import appDefaults from '../../shared/app-defaults.json'
import type { AppSettings, TaskKind } from './types'

export const APP_DEFAULTS: AppSettings = appDefaults
export const REVIEW_STAGES = [1, 3, 7, 14] as const
export const WEAK_RETEST_DAILY_LIMIT = 3
export const POMODORO_DEFAULT = {
  work: APP_DEFAULTS.pomodoroMinutes,
  break: APP_DEFAULTS.breakMinutes,
}
export const DAILY_CAP_DEFAULT = 4
export const TASK_EST_MINUTES: Record<TaskKind, number> = { new: 30, weak_retest: 10, review: 5 }
export const KIND_LABEL: Record<TaskKind, string> = { new: '新知识块', weak_retest: '薄弱点重考', review: '间隔复习' }
export const KIND_ORDER: TaskKind[] = ['weak_retest', 'review', 'new']
/** 阅读器字号档(epub.js themes.fontSize 百分比)与默认档下标 */
export const READER_FONT_STEPS = [90, 100, 112, 126, 142] as const
export const READER_FONT_DEFAULT_IDX = 1
/** 学生回复打字机渐显速度(毫秒/字) */
export const TYPEWRITER_CHAR_MS = 28
