import type {
  AnchorSegment, AppSettings, Book, BookType, DailyTask, EvaluationView, ExtraKind, ExtraOutcome, FinalReport, KnowledgeBlock, MapEditOp, MapProgress, PomodoroSnapshot, Profile, Replan, SessionView, SpineChapter, Stats, StatsDetail, StudyPlan, TurnResult, VerdictOutcome,
} from '../types'

export interface Backend {
  // 书架与导入
  listBooks(): Promise<Book[]>
  importEpub(file: File, type: BookType): Promise<{ bookId: number }>
  /** 稳定 block id 操作集 + 乐观修订号(不符 → conflict);成功返回新修订号(ADR-0003) */
  confirmMap(bookId: number, expectedRevision: number, ops: MapEditOp[]): Promise<{ revision: number }>
  setActiveBook(bookId: number): Promise<void>
  /** 标记学完:计划冻结、到期复习照常;之后不能再设为主攻(M2 T8) */
  finishBook(bookId: number): Promise<void>
  // 计划与队列
  setPlan(plan: StudyPlan): Promise<void>
  /** 落后检测(有副作用:core 可能改写每日新块数),须在 todayQueue 之前调用(M2 T4) */
  checkBehind(bookId: number, date: string): Promise<Replan>
  getPlan(bookId: number): Promise<StudyPlan | null>
  todayQueue(date: string): Promise<DailyTask[]>
  completeTask(taskId: number): Promise<void>
  // 知识块与阅读
  listBlocks(bookId: number): Promise<KnowledgeBlock[]>
  getBlock(blockId: number): Promise<KnowledgeBlock>
  blockSource(blockId: number): Promise<{ href: string; text: string }>
  epubUrl(bookId: number): Promise<string>
  // 统计与设置
  stats(): Promise<Stats>
  /** 番茄钟(M2 T3):状态机在后端;阶段变化经 subscribePomodoro 推送快照 */
  pomodoroStart(taskId: number, date: string): Promise<PomodoroSnapshot>
  pomodoroPause(): Promise<PomodoroSnapshot>
  pomodoroResume(): Promise<PomodoroSnapshot>
  pomodoroStop(): Promise<PomodoroSnapshot>
  pomodoroState(): Promise<PomodoroSnapshot>
  subscribePomodoro(handler: (snapshot: PomodoroSnapshot) => void): Promise<() => void>
  /** 学习者画像(M2 T6):写入经记忆库 outbox git commit */
  profileGet(): Promise<Profile>
  profileSave(profile: Profile): Promise<void>
  /** 通过后附加环节(M2 T5):仅已通过的块;同块同类一次;回合复用 submitTurn;finish 产出整理稿并归档 */
  extraStart(blockId: number, kind: ExtraKind, clientRequestId: string): Promise<SessionView>
  extraFinish(sessionId: number, expectedVersion: number, requestId: string): Promise<ExtraOutcome>
  /** 统计详情三区(M2 T7);"今天"同 stats() 由前端本地日历日决定 */
  statsDetail(): Promise<StatsDetail>
  /** 整书终评(M3 T1):全部未跳过块通过后可开始;回合复用 submitTurn;finish 产出学习报告并把书标为已学完 */
  finalExamEligible(bookId: number): Promise<boolean>
  finalExamStart(bookId: number, clientRequestId: string): Promise<SessionView>
  finalExamFinish(sessionId: number, expectedVersion: number, requestId: string): Promise<FinalReport>
  getSettings(): Promise<AppSettings>
  saveSettings(s: AppSettings): Promise<void>

  // ---- 契约 v2(Plan B;与 core 用例同名;v1 的会话与地图生成方法已删除)----
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
