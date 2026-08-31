import type {
  AppSettings, Book, BookType, ChatMessage, DailyTask, EvalResult,
  KnowledgeBlock, Stats, StudyPlan, TaskKind,
} from '../types'

export interface MapEditBlock { title: string; moduleName: string; seq: number; skipped: boolean }

export interface Backend {
  // 书架与导入
  listBooks(): Promise<Book[]>
  importEpub(file: File, type: BookType): Promise<{ bookId: number }>
  generateMap(bookId: number, onProgress?: (msg: string) => void): Promise<KnowledgeBlock[]>
  confirmMap(bookId: number, blocks: MapEditBlock[]): Promise<void>
  setActiveBook(bookId: number): Promise<void>
  // 计划与队列
  setPlan(plan: StudyPlan): Promise<void>
  todayQueue(date: string): Promise<DailyTask[]>
  completeTask(taskId: number): Promise<void>
  // 知识块与阅读
  listBlocks(bookId: number): Promise<KnowledgeBlock[]>
  getBlock(blockId: number): Promise<KnowledgeBlock>
  blockSource(blockId: number): Promise<{ href: string; text: string }>
  epubUrl(bookId: number): Promise<string>
  // 费曼环节
  startSession(blockId: number, kind: TaskKind): Promise<{ sessionId: number }>
  studentReply(sessionId: number, transcript: ChatMessage[]): Promise<{ text: string; readyToEnd: boolean }>
  endSession(sessionId: number): Promise<EvalResult>
  confirmVerdict(sessionId: number, pass: boolean): Promise<void>
  // 统计与设置
  stats(): Promise<Stats>
  getSettings(): Promise<AppSettings>
  saveSettings(s: AppSettings): Promise<void>
}
