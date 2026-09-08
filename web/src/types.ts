export type BookType = 'textbook' | 'methodology' | 'humanities'
export type BookStatus = 'active' | 'paused' | 'finished'
export type BlockStatus = 'unlearned' | 'learning' | 'passed' | 'weak' | 'consolidated'
export type TaskKind = 'new' | 'weak_retest' | 'review'
export type Verdict = 'pass_suggested' | 'relearn_suggested'

export interface Book {
  id: number; title: string; author: string; type: BookType; slug: string; status: BookStatus
  /** 地图乐观并发修订号(core book.map_revision;草图落库置 1,每次 confirmMap +1) */
  mapRevision: number
}
export interface Scores { accuracy: number; completeness: number; clarity: number }
export interface KnowledgeBlock {
  id: number; bookId: number; moduleName: string; seq: number; title: string; slug: string
  prereqIds: number[]; status: BlockStatus; scores?: Scores; passedAt?: string
  /** 地图编辑"跳过"标记(不物理删除) */
  skipped: boolean
}
export interface DailyTask {
  id: number; bookId: number; blockId: number; kind: TaskKind; seq: number
  status: 'pending' | 'done' | 'skipped'; estMinutes: number; refId?: number
}
export interface EvalWeakPoint { title: string; detail: string; fixedInSession: boolean }
export interface EvalResult {
  verdict: Verdict; scores: Scores; summary: string
  weakPoints: EvalWeakPoint[]; finalRestatement: string; observationNote: string
}
export interface StudyPlan { bookId: number; deadline: string; dailyNewBlocks: number; dailyCap: number; remindTime: string }
/** 落后检测报告(core sched::ReplanReport,M2 T4):auto_adjusted 已由 core 改写每日新块数;needs_decision 由用户决定顺延或缩减 */
export type ReplanStatus = 'on_track' | 'auto_adjusted' | 'needs_decision'
export interface Replan {
  status: ReplanStatus; newDaily?: number; requiredDaily?: number
  dailyCap: number; remainingBlocks: number; remainingDays: number; deadline: string
}
export interface ChatMessage { role: 'user' | 'student'; text: string }
export interface Stats { totalBlocks: number; passedBlocks: number; streakDays: number; openWeakPoints: number; fixedWeakPoints: number; minutesToday: number }
/** 统计详情三区(core stats::detail,M2 T7);日期数组旧 → 新;可空字段为"暂无数据" */
export interface BookProgress {
  id: number; title: string; status: BookStatus; total: number; passed: number; consolidated: number
  deadline: string | null; projectedFinish: string | null
}
export interface DayEffort { date: string; minutes: number; pomodoros: number }
export interface StreakDay { date: string; active: boolean }
export interface WeakTrendDay { date: string; opened: number; fixed: number }
export interface AvgScores { accuracy: number; completeness: number; clarity: number; samples: number }
export interface StatsDetail {
  books: BookProgress[]; days: DayEffort[]; streakCalendar: StreakDay[]; weakTrend: WeakTrendDay[]
  avgScores: AvgScores | null; reviewPassRate: number | null
}
export interface AppSettings { obsidianVault: string; pomodoroMinutes: number; breakMinutes: number; remindTime: string; eveningRemindTime: string }

// ---- 契约 v2(Plan B,与 core 用例同名;camelCase 镜像 core 结构)----
export interface SpineChapter { idx: number; href: string; title: string; text: string }
export type AnchorPrecision = 'exact' | 'chapter_fallback'
export interface AnchorSegment {
  spineHref: string; cfiStart: string; cfiEnd: string; precision: AnchorPrecision
  /** 原文小节标题(阅读器据此解析 CFI) */
  hint: string
  /** 段纯文本(exact 段回填;空则用整章文本) */
  text: string
}
export type MapProgress =
  | { stage: 'chapter'; index: number; total: number; title: string }
  | { stage: 'merging' }
  | { stage: 'done'; blocks: number }
export type MapEditOp =
  | { op: 'rename'; blockId: number; title: string }
  | { op: 'renameModule'; from: string; to: string }
  | { op: 'reorder'; blockIds: number[] }
  | { op: 'setSkipped'; blockId: number; skipped: boolean }
  | { op: 'merge'; into: number; from: number[] }
  | { op: 'split'; blockId: number }
export type SessionState = 'open' | 'evaluating' | 'evaluated' | 'confirmed' | 'abandoned'
export type SessionKind = 'learn' | 'retest' | 'review' | 'final_exam'
export interface TurnView {
  role: 'user' | 'student'; text: string; status: 'pending' | 'done' | 'failed'
  clientTurnId: string | null; readyToEnd: boolean
}
/** 通过后附加环节种类(M2 T5):教材 → 迁移应用题;方法论 → 情境化「我的版本」;人文 → 观点讨论 */
export type ExtraKind = 'application' | 'methodology' | 'discussion'
export interface SessionView {
  sessionId: number; taskId: number; version: number; state: SessionState; blockId: number
  kind: SessionKind; extraKind: ExtraKind | null
  /** 整书终评所属的书(M3 T1);普通会话为 null(终评会话的 blockId 为占位块) */
  bookId: number | null
  transcript: TurnView[]; eval: EvalResult | null
}
/** 整书终评报告(core final_exam::FinalReport):contentMd 首行为元注释,已写 artifact 并归档 _report.md */
export interface FinalReport {
  artifactId: number; version: number; contentMd: string; overall: number; strongestModule: string; weakestModule: string
}
/** 附加环节结束产出:整理稿已写 artifact 并经投影归档到记忆库 */
export interface ExtraOutcome { kind: ExtraKind; artifactId: number; version: number; contentMd: string }
export interface TurnResult { studentText: string; readyToEnd: boolean; version: number }
export interface EvaluationView { eval: EvalResult; version: number }
export interface VerdictOutcome { passed: boolean; blockStatus: BlockStatus; taskDone: boolean; outboxOps: number; version: number }
/** 番茄钟快照(core pomodoro::Snapshot,M2 T3):endsAt 为 unix 秒;暂停/空闲为 null。倒计时由前端按 endsAt 本地渲染 */
export type PomodoroPhase = 'idle' | 'work' | 'break' | 'paused'
export interface PomodoroSnapshot {
  phase: PomodoroPhase; taskId: number | null; date: string | null; endsAt: number | null
  remainingSecs: number; pausedPhase: 'work' | 'break' | null
}
/** 学习者画像四小节(memory/profile.md,M2 T6);误区模式由 AI 观察积累,只读展示 */
export interface Profile { background: string; mastered: string; pitfalls: string; context: string }
/** Obsidian 导出(M3 T2):预览为目标目录(已展开 ~)与相对文件清单;写入结果为增量计数 */
export interface ExportPreview { target: string; targetExists: boolean; dir: string; files: string[] }
export interface ExportReport { dir: string; written: number; unchanged: number }

