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
export interface SessionView {
  sessionId: number; taskId: number; version: number; state: SessionState; blockId: number
  kind: SessionKind; transcript: TurnView[]; eval: EvalResult | null
}
export interface TurnResult { studentText: string; readyToEnd: boolean; version: number }
export interface EvaluationView { eval: EvalResult; version: number }
export interface VerdictOutcome { passed: boolean; blockStatus: BlockStatus; taskDone: boolean; outboxOps: number; version: number }
