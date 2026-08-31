export type BookType = 'textbook' | 'methodology' | 'humanities'
export type BookStatus = 'active' | 'paused' | 'finished'
export type BlockStatus = 'unlearned' | 'learning' | 'passed' | 'weak' | 'consolidated'
export type TaskKind = 'new' | 'weak_retest' | 'review'
export type Verdict = 'pass_suggested' | 'relearn_suggested'

export interface Book { id: number; title: string; author: string; type: BookType; slug: string; status: BookStatus }
export interface Scores { accuracy: number; completeness: number; clarity: number }
export interface KnowledgeBlock {
  id: number; bookId: number; moduleName: string; seq: number; title: string; slug: string
  prereqIds: number[]; status: BlockStatus; scores?: Scores; passedAt?: string
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
export interface ChatMessage { role: 'user' | 'student'; text: string }
export interface Stats { totalBlocks: number; passedBlocks: number; streakDays: number; openWeakPoints: number; fixedWeakPoints: number; minutesToday: number }
export interface AppSettings { obsidianVault: string; pomodoroMinutes: number; breakMinutes: number; remindTime: string }
