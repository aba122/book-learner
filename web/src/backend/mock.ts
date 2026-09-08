import { APP_DEFAULTS, KIND_ORDER, OPENER_TURN_ID, TASK_EST_MINUTES } from '../config'
import { CLIENT_ID_RE } from '../lib/ids'
import { addCalendarDays, localCalendarDate } from '../lib/localDate'
import type {
  AnchorSegment, AppSettings, Book, BookType, DailyTask, EvalResult, EvaluationView, ExtraKind, ExtraOutcome, FinalReport, KnowledgeBlock, MapEditOp, MapProgress, PomodoroSnapshot, Profile, Replan, SessionKind, SessionState, SessionView, SpineChapter, Stats, StatsDetail, StudyPlan, TaskKind, TurnResult, TurnView, VerdictOutcome,
} from '../types'
import { BackendError } from './errors'
import type { Backend } from './types'

/** v2 会话:服务端权威 transcript、版本、幂等 id(镜像 core feynman_session + session_turn) */
interface MockSession {
  sessionId: number
  taskId: number
  blockId: number
  kind: SessionKind
  state: SessionState
  version: number
  transcript: TurnView[]
  scriptIdx: number
  eval: EvalResult | null
  clientRequestId: string
  turnResults: Map<string, TurnResult>
  evalRequestId: string | null
  verdictRequestId: string | null
  verdictOutcome: VerdictOutcome | null
  /** 通过后附加环节(M2 T5);普通会话为 null */
  extraKind: ExtraKind | null
  extraOutcome: ExtraOutcome | null
  /** 整书终评所属的书(M3 T1);普通会话为 null */
  bookId: number | null
  finalReport: FinalReport | null
}

const STUDENT_SCRIPT: { text: string; readyToEnd: boolean }[] = [
  { text: '老师,我大概听懂了,但为什么说需求弹性大的商品降价反而能增加总收入?能再讲一遍吗?', readyToEnd: false },
  { text: '那弹性具体怎么算?比如价格从 10 元涨到 11 元,销量从 100 件降到 90 件,这个需求价格弹性是多少?', readyToEnd: false },
  { text: '我有点混了——需求弹性和供给弹性有什么不一样?什么情况下供给会完全没有弹性?', readyToEnd: false },
  { text: '明白了!所以弹性衡量的是"反应的灵敏度",和曲线斜率不是一回事。我觉得我能自己复述出来了,你看还有什么要补充的吗?', readyToEnd: true },
]

const EVAL_FIXTURE: EvalResult = {
  verdict: 'pass_suggested',
  scores: { accuracy: 4, completeness: 4, clarity: 5 },
  summary: '对弹性的定义与总收入判别法讲解清晰,能主动用数字例子说明中点法计算,追问后的纠错也很到位。',
  weakPoints: [
    {
      title: '混淆弹性与斜率',
      detail: '首轮把弹性解释成"需求曲线的斜率",经学生追问后当场纠正为"百分比变化之比",并用数字例子验证。',
      fixedInSession: true,
    },
    {
      title: '交叉价格弹性未覆盖',
      detail: '整场讲授未提及替代品/互补品的交叉价格弹性,缺少判断商品之间关系的工具,建议回读原文补齐。',
      fixedInSession: false,
    },
  ],
  finalRestatement: '弹性衡量需求量对价格变化反应的灵敏程度,用百分比变化之比计算;弹性大于 1 时降价可增加总收入,反之则提价更有利。',
  observationNote: '学生追问两轮后你才引入具体数字;建议下次开头就用数字例子锚定概念,再引出公式。',
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SESSION_KIND: Record<TaskKind, SessionKind> = { new: 'learn', weak_retest: 'retest', review: 'review' }
/** 快问会话对开场回合的首条回复(镜像 core review_quiz_system:直接出题,不寒暄) */
const QUIZ_OPENER: Partial<Record<SessionKind, string>> = {
  review: '快问 1:用一句话说清本块的核心结论。快问 2:它成立的前提条件是什么?',
  retest: '请讲清你之前混淆的那个点:它和相邻概念的区别到底在哪里?',
}
const UNCONFIRMED: readonly SessionState[] = ['open', 'evaluating', 'evaluated']
/** 整书终评学生回合脚本(镜像 core final_exam_system 两阶段)与报告样例 */
const FINAL_SCRIPT: { text: string; readyToEnd: boolean }[] = [
  { text: '先说说这本书分几个模块、各讲什么,主线是什么?', readyToEnd: false },
  { text: '供给与需求和消费者选择这两块是怎么衔接的?为什么先讲前者?', readyToEnd: false },
  { text: '综合题 1:一家平台想同时调价和改产品线,请用弹性和成本曲线两块知识给出决策框架。', readyToEnd: false },
  { text: '综合题 2:如果政府设置价格上限,消费者剩余和长期供给会怎样变化?', readyToEnd: true },
]
const FINAL_REPORT_MD = '<!-- overall:4 strongest:供给与需求 weakest:生产与成本 -->\n## 总体掌握度\n对主线把握扎实。\n\n## 最强模块\n供给与需求\n\n## 最弱模块\n生产与成本\n\n## 薄弱点修复历程\n- 弹性 vs 斜率:第 1 天暴露,第 3 天修复\n\n## 建议重读章节\n- 短期成本曲线\n\n## 终评对话要点\n- 能用弹性解释定价决策'
/** 附加环节学生回合脚本(按已发生的学生回合数取;镜像 core extra_system 的轮次上限) */
const EXTRA_SCRIPT: Record<ExtraKind, { text: string; readyToEnd: boolean }[]> = {
  application: [
    { text: '题目:你所在平台准备把会员价上调 10%,已知会员对价格并不敏感。请用弹性判断总收入会怎样变化,并说明你会先核实哪个数据。', readyToEnd: false },
    { text: '思路正确:弹性小于 1 时提价会提高总收入。你补上了"先核实弹性估计的样本区间",这正是迁移时最容易漏的一步。', readyToEnd: true },
  ],
  methodology: [
    { text: '先说说:你当下的工作里,有哪个具体问题可以套这套框架?', readyToEnd: false },
    { text: '好。框架的每个要素分别对应到这个问题里的什么?', readyToEnd: false },
    { text: '现在请把它写成一段「我的版本」——结合你的情境改写后的个人方法论。', readyToEnd: false },
    { text: '收到,已经足够具体,可以整理归档了。', readyToEnd: true },
  ],
  discussion: [
    { text: '对立视角:有学者认为这一段叙事夸大了个别人物的作用,结构性因素才是主因。你怎么看?', readyToEnd: false },
    { text: '你的论证用到了本块的两处史实,结构性因素那一侧还可以再补一条证据。', readyToEnd: true },
  ],
}
const EXTRA_SUMMARY: Record<ExtraKind, string> = {
  application: '## 题目\n会员价上调 10% 对总收入的影响\n\n## 用户作答要点\n- 弹性小于 1,提价增加总收入\n- 先核实弹性估计的样本区间\n\n## 评语\n运用正确,补充了数据核实步骤。\n\n## 掌握判断\n已掌握迁移能力:能把弹性判断迁移到真实定价决策。',
  methodology: '## 我的版本\n(用户原话整理)\n\n## 适用情境\n平台定价实验设计\n\n## 来源块\n供需弹性',
  discussion: '## 争议\n人物作用 vs 结构性因素\n\n## 我的看法\n(用户原话整理)\n\n## 用到的史实\n两处\n\n## 来源块\n供需弹性',
}
const ANCHOR_PRECISIONS = ['exact', 'chapter_fallback'] as const

// 错误码与 tauri.ts IPC_ERRORS 一致(文案相同),页面对两种后端的失败态无差别
const conflict = () => new BackendError({ code: 'conflict', message: '数据状态冲突，请刷新后重试', retryable: false })
const notFound = () => new BackendError({ code: 'not_found', message: '未找到请求的数据', retryable: false })
const invalidRequest = () => new BackendError({ code: 'invalid_request', message: '请求参数无效', retryable: false })

function requireClientId(id: string): void {
  if (!CLIENT_ID_RE.test(id)) throw invalidRequest()
}
function requireDate(date: string): void {
  if (!DATE_RE.test(date)) throw invalidRequest()
}

export class MockBackend implements Backend {
  private books: Book[] = []
  private blocks: KnowledgeBlock[] = []
  private tasks: DailyTask[] = []
  private plans: StudyPlan[] = []
  private v2Sessions = new Map<number, MockSession>()
  private jobs = new Map<string, number>()
  private spines = new Map<number, SpineChapter[]>()
  private anchors = new Map<number, AnchorSegment[]>()
  private nextSessionId = 1
  private nextArtifactId = 1
  private nextBookId = 2
  private nextBlockId = 13
  private settings: AppSettings = { ...APP_DEFAULTS }
  private profile: Profile = {
    background: '经济学本科,读过曼昆《经济学原理》', mastered: '- 供需曲线与均衡', pitfalls: '- 容易把弹性和斜率混为一谈', context: '在做平台定价的研究,想把弹性分析用到实验设计上',
  }
  /** 番茄钟:镜像 core 状态机(endsAt 为 unix 秒),阶段切换用定时器推进并广播 */
  private pomodoro: PomodoroSnapshot = { phase: 'idle', taskId: null, date: null, endsAt: null, remainingSecs: 0, pausedPhase: null }
  private pomodoroTimer: ReturnType<typeof setTimeout> | null = null
  private pomodoroListeners = new Set<(s: PomodoroSnapshot) => void>()
  private pomodoroMinutes = 0

  constructor() {
    this.seed()
  }

  private seed() {
    this.books = [
      { id: 1, title: '微观经济学', author: '哈尔·范里安', type: 'textbook', slug: 'microeconomics', status: 'active', mapRevision: 1 },
    ]
    const mk = (
      id: number, moduleName: string, seq: number, title: string, slug: string,
      prereqIds: number[], status: KnowledgeBlock['status'], scores?: KnowledgeBlock['scores'], passedAt?: string,
    ): KnowledgeBlock => ({ id, bookId: 1, moduleName, seq, title, slug, prereqIds, status, scores, passedAt, skipped: false })
    this.blocks = [
      mk(1, '供给与需求', 1, '需求曲线与需求定律', 'demand-curve', [], 'passed', { accuracy: 5, completeness: 4, clarity: 5 }, '2026-08-28'),
      mk(2, '供给与需求', 2, '供给曲线与市场均衡', 'supply-equilibrium', [1], 'passed', { accuracy: 4, completeness: 4, clarity: 4 }, '2026-08-29'),
      mk(3, '供给与需求', 3, '供需弹性', 'elasticity', [2], 'weak'),
      mk(4, '供给与需求', 4, '价格管制与市场干预', 'price-control', [3], 'unlearned'),
      mk(5, '消费者选择', 5, '效用与边际效用', 'utility', [], 'unlearned'),
      mk(6, '消费者选择', 6, '无差异曲线', 'indifference-curve', [5], 'unlearned'),
      mk(7, '消费者选择', 7, '预算约束与最优选择', 'budget-constraint', [6], 'unlearned'),
      mk(8, '消费者选择', 8, '收入效应与替代效应', 'income-substitution', [7], 'unlearned'),
      mk(9, '生产与成本', 9, '生产函数', 'production-function', [], 'unlearned'),
      mk(10, '生产与成本', 10, '短期成本曲线', 'short-run-cost', [9], 'unlearned'),
      mk(11, '生产与成本', 11, '长期成本与规模经济', 'long-run-cost', [10], 'unlearned'),
      mk(12, '生产与成本', 12, '完全竞争市场的供给', 'perfect-competition', [11], 'unlearned'),
    ]
    const mkTask = (id: number, blockId: number, kind: TaskKind, seq: number, refId?: number): DailyTask => ({
      id, bookId: 1, blockId, kind, seq, status: 'pending', estMinutes: TASK_EST_MINUTES[kind], refId,
    })
    this.tasks = [
      mkTask(1, 3, 'weak_retest', 1, 1),
      mkTask(2, 1, 'review', 2, 1),
      mkTask(3, 4, 'new', 3),
      mkTask(4, 5, 'new', 4),
    ]
  }

  async listBooks(): Promise<Book[]> {
    return this.books
  }

  async importEpub(file: File, type: BookType): Promise<{ bookId: number }> {
    const id = this.nextBookId++
    const title = file.name.replace(/\.epub$/i, '') || '未命名书籍'
    this.books.push({ id, title, author: '待识别', type, slug: `book-${id}`, status: 'paused', mapRevision: 0 })
    return { bookId: id }
  }

  /** 与 core map::confirm_map 同语义:修订号不符 conflict;操作在工作副本上按序应用,全部合法才提交(原子) */
  async confirmMap(bookId: number, expectedRevision: number, ops: MapEditOp[]): Promise<{ revision: number }> {
    const book = this.books.find(b => b.id === bookId)
    if (!book) throw notFound()
    if (book.mapRevision !== expectedRevision) throw conflict()
    const working = this.blocks.filter(b => b.bookId === bookId).map(b => ({ ...b, prereqIds: [...b.prereqIds] }))
    const anchorsWorking = new Map<number, AnchorSegment[]>()
    const inBook = (id: number) => {
      const b = working.find(k => k.id === id)
      if (!b) throw notFound()
      return b
    }
    for (const op of ops) {
      switch (op.op) {
        case 'rename': {
          const title = op.title.trim()
          if (!title) throw invalidRequest()
          inBook(op.blockId).title = title
          break
        }
        case 'renameModule': {
          const to = op.to.trim()
          if (!to) throw invalidRequest()
          const targets = working.filter(b => b.moduleName === op.from)
          if (targets.length === 0) throw notFound()
          for (const b of targets) b.moduleName = to
          break
        }
        case 'reorder': {
          const want = new Set(op.blockIds)
          if (op.blockIds.length !== working.length || want.size !== working.length || !working.every(b => want.has(b.id))) {
            throw invalidRequest()
          }
          op.blockIds.forEach((id, i) => { inBook(id).seq = i + 1 })
          break
        }
        case 'setSkipped':
          inBook(op.blockId).skipped = op.skipped
          break
        case 'merge': {
          if (op.from.length === 0 || op.from.includes(op.into)) throw invalidRequest()
          inBook(op.into)
          const merged = anchorsWorking.get(op.into) ?? (this.anchors.get(op.into) ?? []).map(s => ({ ...s }))
          for (const f of op.from) {
            inBook(f).skipped = true
            for (const seg of this.anchors.get(f) ?? []) merged.push({ ...seg })
          }
          anchorsWorking.set(op.into, merged)
          for (const b of working) {
            const next: number[] = []
            for (const p of b.prereqIds) {
              const mapped = op.from.includes(p) ? op.into : p
              if (mapped !== b.id && !next.includes(mapped)) next.push(mapped)
            }
            b.prereqIds = next
          }
          break
        }
        case 'split':
          throw invalidRequest()
        default:
          throw invalidRequest()
      }
    }
    this.blocks = this.blocks.filter(b => b.bookId !== bookId).concat(working.sort((a, z) => a.seq - z.seq))
    for (const [id, segs] of anchorsWorking) this.anchors.set(id, segs)
    book.mapRevision += 1
    return { revision: book.mapRevision }
  }

  async finishBook(bookId: number): Promise<void> {
    const book = this.books.find(b => b.id === bookId)
    if (!book) throw notFound()
    book.status = 'finished'
  }

  async setActiveBook(bookId: number): Promise<void> {
    // 与原生 library::set_active_book 一致:无学习计划的书不能成为主攻书(F4);已学完的书不能再主攻(T8)
    if (!this.plans.some(p => p.bookId === bookId)) throw conflict()
    if (this.books.find(b => b.id === bookId)?.status === 'finished') throw conflict()
    for (const b of this.books) {
      if (b.id === bookId) b.status = 'active'
      else if (b.status === 'active') b.status = 'paused'
    }
  }

  async getPlan(bookId: number): Promise<StudyPlan | null> {
    return this.plans.find(p => p.bookId === bookId) ?? null
  }

  /** 镜像 core check_behind_report:Mock 数据只有今天的任务,永不落后 → on_track,但数字真实 */
  async checkBehind(bookId: number, date: string): Promise<Replan> {
    requireDate(date)
    if (!this.books.some(b => b.id === bookId)) throw notFound()
    const plan = this.plans.find(p => p.bookId === bookId) ?? null
    const remainingBlocks = this.blocks.filter(b => b.bookId === bookId && !b.skipped && (b.status === 'unlearned' || b.status === 'learning')).length
    const remainingDays = plan ? Math.max(1, Math.floor((Date.parse(plan.deadline) - Date.parse(date)) / 86400000) + 1) : 0
    return { status: 'on_track', dailyCap: plan?.dailyCap ?? 0, remainingBlocks, remainingDays, deadline: plan?.deadline ?? '' }
  }

  async setPlan(plan: StudyPlan): Promise<void> {
    this.plans = this.plans.filter(p => p.bookId !== plan.bookId).concat(plan)
  }

  async todayQueue(_date: string): Promise<DailyTask[]> {
    return [...this.tasks].sort((a, z) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(z.kind) || a.seq - z.seq)
  }

  async completeTask(taskId: number): Promise<void> {
    const t = this.tasks.find(x => x.id === taskId)
    if (t) t.status = 'done'
  }

  async listBlocks(bookId: number): Promise<KnowledgeBlock[]> {
    return this.blocks.filter(b => b.bookId === bookId)
  }

  async getBlock(blockId: number): Promise<KnowledgeBlock> {
    const b = this.blocks.find(x => x.id === blockId)
    if (!b) throw new Error(`block ${blockId} 不存在`)
    return b
  }

  async blockSource(blockId: number): Promise<{ href: string; text: string }> {
    const b = await this.getBlock(blockId)
    const segments = (this.anchors.get(blockId) ?? []).filter(s => s.text.trim() !== '')
    if (segments.length > 0) {
      return { href: segments[0].spineHref, text: segments.map(s => s.text).join('\n\n') }
    }
    const chapterIdx = ['供给与需求', '消费者选择', '生产与成本'].indexOf(b.moduleName)
    const href = `chap${chapterIdx >= 0 ? chapterIdx + 1 : 1}.xhtml`
    return {
      href,
      text:
        `【${b.moduleName}·${b.title}】市场由买者与卖者的相互作用构成:买者的意愿决定需求,卖者的意愿决定供给。` +
        `当价格变动时,买卖双方各自调整数量,市场借由价格信号完成资源配置。理解本节的关键在于:` +
        `把"量的变动"与"曲线的移动"区分开——前者是沿曲线滑动,由自身价格引起;后者是整条曲线的位移,` +
        `由收入、偏好、相关商品价格等外生因素引起。请结合教材中的图形与数字例子,复述其经济学含义。`,
    }
  }

  async epubUrl(_bookId: number): Promise<string> {
    return '/fixtures/sample.epub'
  }

  async stats(): Promise<Stats> {
    const active = this.books.find(b => b.status === 'active')
    const blocks = active ? this.blocks.filter(b => b.bookId === active.id) : this.blocks
    return {
      totalBlocks: blocks.length,
      passedBlocks: blocks.filter(b => b.status === 'passed' || b.status === 'consolidated').length,
      streakDays: 3,
      openWeakPoints: blocks.filter(b => b.status === 'weak').length,
      fixedWeakPoints: 1,
      minutesToday: this.tasks.filter(t => t.status === 'done').reduce((sum, t) => sum + t.estMinutes, 0),
    }
  }

  private pomodoroSnapshot(): PomodoroSnapshot {
    const now = Math.floor(Date.now() / 1000)
    const remaining = this.pomodoro.endsAt === null ? this.pomodoro.remainingSecs : Math.max(0, this.pomodoro.endsAt - now)
    return { ...this.pomodoro, remainingSecs: remaining }
  }
  private pomodoroBroadcast(): void {
    const snap = this.pomodoroSnapshot()
    for (const l of this.pomodoroListeners) l(snap)
  }
  private pomodoroArm(): void {
    if (this.pomodoroTimer) clearTimeout(this.pomodoroTimer)
    this.pomodoroTimer = null
    if (this.pomodoro.endsAt === null) return
    const ms = Math.max(0, this.pomodoro.endsAt * 1000 - Date.now())
    this.pomodoroTimer = setTimeout(() => {
      if (this.pomodoro.phase === 'work') {
        this.pomodoroMinutes += this.settings.pomodoroMinutes
        this.pomodoro = { ...this.pomodoro, phase: 'break', endsAt: Math.floor(Date.now() / 1000) + this.settings.breakMinutes * 60 }
        this.pomodoroArm()
      } else if (this.pomodoro.phase === 'break') {
        this.pomodoro = { phase: 'idle', taskId: null, date: null, endsAt: null, remainingSecs: 0, pausedPhase: null }
      }
      this.pomodoroBroadcast()
    }, ms)
  }

  async pomodoroStart(taskId: number, date: string): Promise<PomodoroSnapshot> {
    requireDate(date)
    if (this.pomodoro.phase !== 'idle') throw conflict()
    if (!this.tasks.some(t => t.id === taskId)) throw notFound()
    this.pomodoro = {
      phase: 'work', taskId, date, endsAt: Math.floor(Date.now() / 1000) + this.settings.pomodoroMinutes * 60,
      remainingSecs: this.settings.pomodoroMinutes * 60, pausedPhase: null,
    }
    this.pomodoroArm()
    return this.pomodoroSnapshot()
  }
  async pomodoroPause(): Promise<PomodoroSnapshot> {
    if (this.pomodoro.phase !== 'work' && this.pomodoro.phase !== 'break') throw conflict()
    const remaining = this.pomodoroSnapshot().remainingSecs
    this.pomodoro = { ...this.pomodoro, phase: 'paused', pausedPhase: this.pomodoro.phase, endsAt: null, remainingSecs: remaining }
    this.pomodoroArm()
    return this.pomodoroSnapshot()
  }
  async pomodoroResume(): Promise<PomodoroSnapshot> {
    if (this.pomodoro.phase !== 'paused' || !this.pomodoro.pausedPhase) throw conflict()
    this.pomodoro = { ...this.pomodoro, phase: this.pomodoro.pausedPhase, pausedPhase: null, endsAt: Math.floor(Date.now() / 1000) + this.pomodoro.remainingSecs }
    this.pomodoroArm()
    return this.pomodoroSnapshot()
  }
  async pomodoroStop(): Promise<PomodoroSnapshot> {
    if (this.pomodoro.phase === 'idle') throw conflict()
    this.pomodoro = { phase: 'idle', taskId: null, date: null, endsAt: null, remainingSecs: 0, pausedPhase: null }
    this.pomodoroArm()
    return this.pomodoroSnapshot()
  }
  async pomodoroState(): Promise<PomodoroSnapshot> {
    return this.pomodoroSnapshot()
  }
  async subscribePomodoro(handler: (snapshot: PomodoroSnapshot) => void): Promise<() => void> {
    this.pomodoroListeners.add(handler)
    return () => { this.pomodoroListeners.delete(handler) }
  }

  async profileGet(): Promise<Profile> {
    return { ...this.profile }
  }
  async profileSave(profile: Profile): Promise<void> {
    this.profile = { ...profile }
  }

  /** 统计详情(M2 T7):进度按当前书/块推导,投入与质量为确定性样例(旧 → 新) */
  async statsDetail(): Promise<StatsDetail> {
    const today = localCalendarDate()
    const back = (n: number, days: number) => addCalendarDays(today, -(n - 1 - days))
    const minutes = [0, 25, 50, 0, 30, 45, 25, 0, 0, 50, 25, 30, 0, 40]
    const pomodoros = [0, 1, 2, 0, 1, 2, 1, 0, 0, 2, 1, 1, 0, 2]
    const opened = [0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 1, 0, 0, 1]
    const fixed = [0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0]
    const scored = this.blocks.filter(b => b.scores)
    const avg = (pick: (s: NonNullable<KnowledgeBlock['scores']>) => number) =>
      scored.reduce((sum, b) => sum + pick(b.scores!), 0) / scored.length
    return {
      books: this.books.map(book => {
        const blocks = this.blocks.filter(b => b.bookId === book.id && !b.skipped)
        const passed = blocks.filter(b => b.status === 'passed' || b.status === 'consolidated').length
        const remaining = blocks.length - passed
        return {
          id: book.id, title: book.title, status: book.status, total: blocks.length, passed,
          consolidated: blocks.filter(b => b.status === 'consolidated').length,
          deadline: this.plans.find(p => p.bookId === book.id)?.deadline ?? null,
          projectedFinish: remaining > 0 && passed > 0 ? addCalendarDays(today, remaining * 2) : null,
        }
      }),
      days: minutes.map((m, i) => ({ date: back(14, i), minutes: m, pomodoros: pomodoros[i] })),
      streakCalendar: Array.from({ length: 56 }, (_, i) => ({
        date: back(56, i), active: i >= 42 ? minutes[i - 42] > 0 : i % 3 !== 0,
      })),
      weakTrend: opened.map((o, i) => ({ date: back(14, i), opened: o, fixed: fixed[i] })),
      avgScores: scored.length
        ? { accuracy: avg(s => s.accuracy), completeness: avg(s => s.completeness), clarity: avg(s => s.clarity), samples: scored.length }
        : null,
      reviewPassRate: 0.75,
    }
  }

  async getSettings(): Promise<AppSettings> {
    return this.settings
  }

  async saveSettings(s: AppSettings): Promise<void> {
    this.settings = { ...s }
  }

  // ---- 契约 v2:地图 ----

  async storeSpine(bookId: number, chapters: SpineChapter[]): Promise<void> {
    if (!this.books.some(b => b.id === bookId)) throw notFound()
    this.spines.set(bookId, chapters.map(c => ({ ...c })))
  }

  async runMapJob(bookId: number, jobId: string, onProgress?: (p: MapProgress) => void): Promise<KnowledgeBlock[]> {
    requireClientId(jobId)
    const book = this.books.find(b => b.id === bookId)
    if (!book) throw notFound()
    const owner = this.jobs.get(jobId)
    if (owner !== undefined && owner !== bookId) throw conflict()
    const existing = this.blocks.filter(b => b.bookId === bookId)
    if (existing.length > 0) return existing // 已有地图(或同 jobId 重放):幂等,不发进度
    this.jobs.set(jobId, bookId)
    const chapters = this.spines.get(bookId)
      ?? Array.from({ length: 3 }, (_, i) => ({ idx: i, href: `chapter-${i + 1}.xhtml`, title: `第 ${i + 1} 章`, text: '' }))
    const created: KnowledgeBlock[] = []
    chapters.forEach((chapter, i) => {
      onProgress?.({ stage: 'chapter', index: i, total: chapters.length, title: chapter.title })
      const id = this.nextBlockId++
      created.push({
        id, bookId, moduleName: i < Math.ceil(chapters.length / 2) ? '基础概念' : '进阶应用', seq: i + 1,
        title: chapter.title, slug: `block-${bookId}-${i + 1}`,
        prereqIds: i === 0 ? [] : [created[i - 1].id], status: 'unlearned', skipped: false,
      })
      this.anchors.set(id, [{
        spineHref: chapter.href, cfiStart: '', cfiEnd: '', precision: 'chapter_fallback', hint: chapter.title, text: chapter.text,
      }])
    })
    onProgress?.({ stage: 'merging' })
    this.blocks.push(...created)
    book.mapRevision = 1
    onProgress?.({ stage: 'done', blocks: created.length })
    return created
  }

  async setAnchorSegments(blockId: number, segments: AnchorSegment[]): Promise<void> {
    if (!this.blocks.some(b => b.id === blockId)) throw notFound()
    if (segments.some(s => !ANCHOR_PRECISIONS.includes(s.precision))) throw invalidRequest()
    this.anchors.set(blockId, segments.map(s => ({ ...s })))
  }

  async listAnchors(blockId: number): Promise<AnchorSegment[]> {
    if (!this.blocks.some(b => b.id === blockId)) throw notFound()
    return (this.anchors.get(blockId) ?? []).map(s => ({ ...s }))
  }

  // ---- 契约 v2:会话 ----

  private toView(s: MockSession): SessionView {
    return {
      sessionId: s.sessionId, taskId: s.taskId, version: s.version, state: s.state, blockId: s.blockId,
      kind: s.kind, extraKind: s.extraKind, bookId: s.bookId, transcript: s.transcript.map(t => ({ ...t })), eval: s.eval,
    }
  }

  private requireSession(sessionId: number): MockSession {
    const s = this.v2Sessions.get(sessionId)
    if (!s) throw notFound()
    return s
  }

  async startOrResumeSession(taskId: number, clientRequestId: string, date: string): Promise<SessionView> {
    requireClientId(clientRequestId)
    requireDate(date)
    for (const s of this.v2Sessions.values()) {
      if (s.clientRequestId === clientRequestId) return this.toView(s)
    }
    const task = this.tasks.find(t => t.id === taskId)
    if (!task) throw notFound()
    if (task.status !== 'pending') throw conflict()
    for (const s of this.v2Sessions.values()) {
      if (s.taskId === taskId && UNCONFIRMED.includes(s.state)) return this.toView(s)
    }
    const session: MockSession = {
      sessionId: this.nextSessionId++, taskId, blockId: task.blockId, kind: SESSION_KIND[task.kind],
      state: 'open', version: 0, transcript: [], scriptIdx: 0, eval: null, clientRequestId,
      turnResults: new Map(), evalRequestId: null, verdictRequestId: null, verdictOutcome: null,
      extraKind: null, extraOutcome: null, bookId: null, finalReport: null,
    }
    this.v2Sessions.set(session.sessionId, session)
    return this.toView(session)
  }

  async finalExamEligible(bookId: number): Promise<boolean> {
    if (!this.books.some(b => b.id === bookId)) throw notFound()
    const blocks = this.blocks.filter(b => b.bookId === bookId && !b.skipped)
    return blocks.length > 0 && blocks.every(b => b.status === 'passed' || b.status === 'consolidated')
  }

  async finalExamStart(bookId: number, clientRequestId: string): Promise<SessionView> {
    requireClientId(clientRequestId)
    for (const s of this.v2Sessions.values()) {
      if (s.clientRequestId === clientRequestId) return this.toView(s)
    }
    for (const s of this.v2Sessions.values()) {
      if (s.kind === 'final_exam' && s.bookId === bookId && s.state !== 'abandoned') return this.toView(s)
    }
    if (!(await this.finalExamEligible(bookId))) throw conflict()
    const placeholder = this.blocks.filter(b => b.bookId === bookId && !b.skipped).sort((a, z) => a.seq - z.seq)[0]
    const session: MockSession = {
      sessionId: this.nextSessionId++, taskId: 0, blockId: placeholder.id, kind: 'final_exam',
      state: 'open', version: 0, transcript: [], scriptIdx: 0, eval: null, clientRequestId,
      turnResults: new Map(), evalRequestId: null, verdictRequestId: null, verdictOutcome: null,
      extraKind: null, extraOutcome: null, bookId, finalReport: null,
    }
    this.v2Sessions.set(session.sessionId, session)
    return this.toView(session)
  }

  async finalExamFinish(sessionId: number, expectedVersion: number, requestId: string): Promise<FinalReport> {
    requireClientId(requestId)
    const s = this.requireSession(sessionId)
    if (s.kind !== 'final_exam' || s.bookId === null) throw invalidRequest()
    if (s.finalReport) {
      if (s.verdictRequestId === requestId) return { ...s.finalReport }
      throw conflict()
    }
    if (s.state !== 'open') throw conflict()
    if (s.version !== expectedVersion) throw conflict()
    const answers = s.transcript.filter(t => t.role === 'user' && t.status === 'done' && t.clientTurnId !== OPENER_TURN_ID)
    if (answers.length < 2) throw conflict()
    const book = this.books.find(b => b.id === s.bookId)
    if (book) { book.status = 'finished' }
    this.plans = this.plans.map(p => (p.bookId === s.bookId ? { ...p } : p))
    s.state = 'confirmed'
    s.version += 1
    s.verdictRequestId = requestId
    s.finalReport = {
      artifactId: this.nextArtifactId++, version: s.version,
      contentMd: FINAL_REPORT_MD, overall: 4, strongestModule: '供给与需求', weakestModule: '生产与成本',
    }
    return { ...s.finalReport }
  }

  async extraStart(blockId: number, kind: ExtraKind, clientRequestId: string): Promise<SessionView> {
    requireClientId(clientRequestId)
    for (const s of this.v2Sessions.values()) {
      if (s.clientRequestId === clientRequestId) return this.toView(s)
    }
    const block = this.blocks.find(b => b.id === blockId)
    if (!block) throw notFound()
    for (const s of this.v2Sessions.values()) {
      if (s.blockId === blockId && s.extraKind === kind) return this.toView(s)
    }
    if (block.status !== 'passed' && block.status !== 'consolidated') throw conflict()
    const session: MockSession = {
      sessionId: this.nextSessionId++, taskId: 0, blockId, kind: 'learn',
      state: 'open', version: 0, transcript: [], scriptIdx: 0, eval: null, clientRequestId,
      turnResults: new Map(), evalRequestId: null, verdictRequestId: null, verdictOutcome: null,
      extraKind: kind, extraOutcome: null, bookId: null, finalReport: null,
    }
    this.v2Sessions.set(session.sessionId, session)
    return this.toView(session)
  }

  async extraFinish(sessionId: number, expectedVersion: number, requestId: string): Promise<ExtraOutcome> {
    requireClientId(requestId)
    const s = this.requireSession(sessionId)
    if (!s.extraKind) throw invalidRequest()
    if (s.extraOutcome) {
      if (s.verdictRequestId === requestId) return { ...s.extraOutcome }
      throw conflict()
    }
    if (s.state !== 'open') throw conflict()
    if (s.version !== expectedVersion) throw conflict()
    const answers = s.transcript.filter(t => t.role === 'user' && t.status === 'done' && t.clientTurnId !== OPENER_TURN_ID)
    if (answers.length === 0) throw conflict()
    s.state = 'confirmed'
    s.version += 1
    s.verdictRequestId = requestId
    s.extraOutcome = { kind: s.extraKind, artifactId: this.nextArtifactId++, version: s.version, contentMd: EXTRA_SUMMARY[s.extraKind] }
    return { ...s.extraOutcome }
  }

  async submitTurn(sessionId: number, expectedVersion: number, clientTurnId: string, text: string): Promise<TurnResult> {
    requireClientId(clientTurnId)
    const s = this.requireSession(sessionId)
    const trimmed = text.trim()
    if (!trimmed) throw invalidRequest()
    const replay = s.turnResults.get(clientTurnId)
    if (replay) return { ...replay }
    if (s.state !== 'open') throw conflict()
    if (s.version !== expectedVersion) throw conflict()
    const opener = clientTurnId === OPENER_TURN_ID ? QUIZ_OPENER[s.kind] : undefined
    const extraScript = s.extraKind ? EXTRA_SCRIPT[s.extraKind] : s.kind === 'final_exam' ? FINAL_SCRIPT : null
    const studentTurns = s.transcript.filter(t => t.role === 'student').length
    const reply = extraScript
      ? extraScript[Math.min(studentTurns, extraScript.length - 1)]
      : opener !== undefined
        ? { text: opener, readyToEnd: false }
        : STUDENT_SCRIPT[Math.min(s.scriptIdx, STUDENT_SCRIPT.length - 1)]
    if (opener === undefined && !extraScript) s.scriptIdx += 1
    s.transcript.push({ role: 'user', text: trimmed, status: 'done', clientTurnId, readyToEnd: false })
    s.transcript.push({ role: 'student', text: reply.text, status: 'done', clientTurnId: null, readyToEnd: reply.readyToEnd })
    s.version += 1
    const result: TurnResult = { studentText: reply.text, readyToEnd: reply.readyToEnd, version: s.version }
    s.turnResults.set(clientTurnId, result)
    return { ...result }
  }

  async requestEvaluation(sessionId: number, requestId: string): Promise<EvaluationView> {
    requireClientId(requestId)
    const s = this.requireSession(sessionId)
    if (s.state === 'evaluated' || s.state === 'confirmed') {
      if (s.evalRequestId === requestId && s.eval) return { eval: s.eval, version: s.version }
      throw conflict()
    }
    if (s.state !== 'open' && s.state !== 'evaluating') throw conflict()
    if (!s.transcript.some(t => t.role === 'user' && t.status === 'done')) throw conflict()
    s.eval = EVAL_FIXTURE
    s.evalRequestId = requestId
    s.state = 'evaluated'
    s.version += 1
    return { eval: s.eval, version: s.version }
  }

  async confirmSessionVerdict(
    sessionId: number, expectedVersion: number, requestId: string, pass: boolean, date: string,
  ): Promise<VerdictOutcome> {
    requireClientId(requestId)
    requireDate(date)
    const s = this.requireSession(sessionId)
    if (s.verdictRequestId === requestId && s.verdictOutcome) return { ...s.verdictOutcome }
    if (s.state !== 'evaluated') throw conflict()
    if (s.version !== expectedVersion) throw conflict()
    const block = this.blocks.find(b => b.id === s.blockId)
    const task = this.tasks.find(t => t.id === s.taskId)
    if (!block || !task || !s.eval) throw notFound()
    let taskDone = false
    if (task.kind === 'new') {
      if (pass) {
        block.status = 'passed'
        block.scores = s.eval.scores
        block.passedAt = date
        task.status = 'done'
        taskDone = true
      } else {
        block.status = 'learning'
      }
    } else {
      // weak_retest / review:块状态不变,只完成本次尝试
      task.status = 'done'
      taskDone = true
    }
    s.state = 'confirmed'
    s.version += 1
    const outcome: VerdictOutcome = {
      passed: pass, blockStatus: block.status, taskDone, outboxOps: task.kind === 'new' ? 4 : 3, version: s.version,
    }
    s.verdictRequestId = requestId
    s.verdictOutcome = outcome
    return { ...outcome }
  }

  async abandonSession(sessionId: number, expectedVersion: number): Promise<void> {
    const s = this.requireSession(sessionId)
    if (!UNCONFIRMED.includes(s.state)) throw conflict()
    if (s.version !== expectedVersion) throw conflict()
    s.state = 'abandoned'
    s.version += 1
  }
}
