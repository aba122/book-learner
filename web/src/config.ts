import appDefaults from '../../shared/app-defaults.json'
import type { AppSettings, BookType, ExtraKind, SessionKind, TaskKind } from './types'

export const APP_DEFAULTS: Readonly<AppSettings> = Object.freeze({ ...appDefaults })
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
/** 阅读器行高档位与默认档;排版偏好键(每台设备,localStorage;M3 T4) */
export const READER_LINE_HEIGHTS = [1.5, 1.8, 2.1] as const
export const READER_LINE_HEIGHT_DEFAULT_IDX = 1
export const READER_PREFS_KEY = 'bookLearner.readerPrefs'
/** 夜读/日读模式持久化键(每台设备,localStorage;BL-003) */
export const THEME_KEY = 'bookLearner.theme'
/** 阅读位置写回节流(毫秒):relocated 很密,只记最后一次 */
export const READER_POSITION_DEBOUNCE_MS = 800
/** 选区轮询间隔(毫秒):WKWebView 里 sandbox(无 allow-scripts)的 iframe 不派发 selectionchange,epub.js 的 selected 永不触发(BL-006) */
export const READER_SELECTION_POLL_MS = 300
/** 卷页翻页(BL-010):纸角抓起→沿折线卷过去→纸背落下的时长(毫秒)。滑入(PR #40)与整页 3D 硬翻(PR #41)用户都不认 */
export const READER_PAGE_CURL_MS = 640
/** 页角抬升幅度(页高的比例),决定折线倾斜程度 */
export const READER_PAGE_CURL_LIFT = 0.55
/** 当前页快照(克隆正文 iframe)最多等这么久再开始卷,免得大章排版慢时卡住 */
export const READER_PAGE_SNAPSHOT_MAX_MS = 250
/** 学生回复打字机渐显速度(毫秒/字) */
export const TYPEWRITER_CHAR_MS = 28
/** 快问会话(review/retest,M2 T1):core 回合协议要求用户先开口,前端以固定 id 自动提交开场回合(幂等,重进不重复) */
export const OPENER_TURN_ID = 'opener'
export const OPENER_TEXT: Partial<Record<SessionKind, string>> = {
  review: '请开始快问',
  retest: '请针对我的薄弱点提问',
  final_exam: '请开始终评',
}
export const SESSION_HINT: Partial<Record<SessionKind, string>> = {
  review: '间隔复习 · 快问,约 5 分钟',
  retest: '薄弱点重考 · 优先讲清曾经混淆之处',
  final_exam: '整书终评 · 先讲全书框架,再答 2–3 道综合题',
}
/** 整书终评(M3 T1):结束请求 id 为常量,重进后同 id 重放同一报告;至少作答次数与 core MIN_USER_TURNS_TO_FINISH − 1 一致 */
export const FINAL_EXAM_REQUEST_ID = 'final-report'
export const FINAL_EXAM_MIN_ANSWERS = 2
/** 落后重排弹窗"本日不再提醒"的偏好键(值为日历日,M2 T4) */
export const REPLAN_DISMISSED_KEY = 'bookLearner.replanDismissed'
/** 通过后附加环节(M2 T5):按书类型选种类;opener 为前端固定开场回合文案(core 回合协议要求用户先开口) */
export const EXTRA_KIND_FOR_BOOK: Record<BookType, ExtraKind> = {
  textbook: 'application', methodology: 'methodology', humanities: 'discussion',
}
export const EXTRA_STAGE: Record<ExtraKind, { title: string; intro: string; opener: string; archiveFile: string }> = {
  application: {
    title: '迁移应用题',
    intro: '把刚讲清的知识用到一个贴近你工作/研究的新情境里:AI 出 1 道题,你作答,它评阅并给出掌握判断。',
    opener: '请出题',
    archiveFile: '_applications.md',
  },
  methodology: {
    title: '情境化方法论',
    intro: '把这套框架套到你当下的一个具体问题上,三轮引导后写出「我的版本」,整理稿归档为个人方法论。',
    opener: '请引导',
    archiveFile: '_methodology.md',
  },
  discussion: {
    title: '观点讨论',
    intro: 'AI 提出一个与本块叙事相关的对立视角或争议,你写下自己的看法;整理稿归档为思考笔记。',
    opener: '请提出对立视角',
    archiveFile: '_notes.md',
  },
}
/** 语音输入(M3 T3):录音上限(秒)与壳层转写采样率;输入设备偏好键(deviceId) */
export const VOICE_MAX_SECONDS = 120
export const VOICE_SAMPLE_RATE = 16_000
export const VOICE_DEVICE_KEY = 'bookLearner.voiceDevice'
