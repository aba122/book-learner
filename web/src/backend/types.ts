import type {
  AnchorSegment, AppSettings, Book, BookType, ChatMessage, DailyTask, EvalResult, EvaluationView,
  KnowledgeBlock, MapProgress, SessionView, SpineChapter, Stats, StudyPlan, TaskKind, TurnResult, VerdictOutcome,
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
  // 费曼环节(v1,B7 删除)
  startSession(blockId: number, kind: TaskKind): Promise<{ sessionId: number }>
  studentReply(sessionId: number, transcript: ChatMessage[]): Promise<{ text: string; readyToEnd: boolean }>
  endSession(sessionId: number): Promise<EvalResult>
  confirmVerdict(sessionId: number, pass: boolean): Promise<void>
  // 统计与设置
  stats(): Promise<Stats>
  getSettings(): Promise<AppSettings>
  saveSettings(s: AppSettings): Promise<void>

  // ---- 契约 v2(Plan B;与 core 用例同名)----
  /** 写入已抽取的 spine 文本(替换旧缓存);EPUB 抽取在 JS 侧完成 */
  storeSpine(bookId: number, chapters: SpineChapter[]): Promise<void>
  /** 两阶段地图作业 + 草图落库;同 jobId 幂等;已有地图直接返回 */
  runMapJob(bookId: number, jobId: string, onProgress?: (p: MapProgress) => void): Promise<KnowledgeBlock[]>
  setAnchorSegments(blockId: number, segments: AnchorSegment[]): Promise<void>
  listAnchors(blockId: number): Promise<AnchorSegment[]>
  /** 该任务唯一未确认会话(存在则 resume);clientRequestId 幂等;date = 页面固定的本地日历日 */
  startOrResumeSession(taskId: number, clientRequestId: string, date: string): Promise<SessionView>
  /** 同 clientTurnId 重放/续跑;expectedVersion 不符 → conflict */
  submitTurn(sessionId: number, expectedVersion: number, clientTurnId: string, text: string): Promise<TurnResult>
  /** 同 requestId 重放;评估后 version +1 */
  requestEvaluation(sessionId: number, requestId: string): Promise<EvaluationView>
  /** 原子判定(会话/块/薄弱点/复习/任务/投影);用户 pass 覆盖 AI 建议;同 requestId 重放 */
  confirmSessionVerdict(sessionId: number, expectedVersion: number, requestId: string, pass: boolean, date: string): Promise<VerdictOutcome>
  abandonSession(sessionId: number, expectedVersion: number): Promise<void>
}
