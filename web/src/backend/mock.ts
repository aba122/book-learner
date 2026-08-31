import { KIND_ORDER, POMODORO_DEFAULT, TASK_EST_MINUTES } from '../config'
import type {
  AppSettings, Book, BookType, ChatMessage, DailyTask, EvalResult,
  KnowledgeBlock, Stats, StudyPlan, TaskKind,
} from '../types'
import type { Backend, MapEditBlock } from './types'

interface Session { blockId: number; scriptIdx: number }

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

export class MockBackend implements Backend {
  private books: Book[] = []
  private blocks: KnowledgeBlock[] = []
  private tasks: DailyTask[] = []
  private plans: StudyPlan[] = []
  private sessions = new Map<number, Session>()
  private nextSessionId = 1
  private nextBookId = 2
  private nextBlockId = 13
  private settings: AppSettings = {
    obsidianVault: '~/Obsidian/book-learner',
    pomodoroMinutes: POMODORO_DEFAULT.work,
    breakMinutes: POMODORO_DEFAULT.break,
    remindTime: '21:00',
  }

  constructor() {
    this.seed()
  }

  private seed() {
    this.books = [
      { id: 1, title: '微观经济学', author: '哈尔·范里安', type: 'textbook', slug: 'microeconomics', status: 'active' },
    ]
    const mk = (
      id: number, moduleName: string, seq: number, title: string, slug: string,
      prereqIds: number[], status: KnowledgeBlock['status'], scores?: KnowledgeBlock['scores'], passedAt?: string,
    ): KnowledgeBlock => ({ id, bookId: 1, moduleName, seq, title, slug, prereqIds, status, scores, passedAt })
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
    this.books.push({ id, title, author: '待识别', type, slug: `book-${id}`, status: 'paused' })
    return { bookId: id }
  }

  async generateMap(bookId: number, onProgress?: (msg: string) => void): Promise<KnowledgeBlock[]> {
    onProgress?.('正在解析 EPUB 目录…')
    onProgress?.('正在按章节拆分知识块…')
    onProgress?.('正在标注前置依赖…')
    if (!this.blocks.some(b => b.bookId === bookId)) {
      const book = this.books.find(b => b.id === bookId)
      const modules = ['基础概念', '进阶应用']
      for (let i = 0; i < 6; i++) {
        this.blocks.push({
          id: this.nextBlockId++, bookId, moduleName: modules[Math.floor(i / 3)], seq: i + 1,
          title: `${book?.title ?? '新书'}:知识块 ${i + 1}`, slug: `block-${bookId}-${i + 1}`,
          prereqIds: i % 3 === 0 ? [] : [this.nextBlockId - 2], status: 'unlearned',
        })
      }
    }
    return this.blocks.filter(b => b.bookId === bookId)
  }

  async confirmMap(bookId: number, blocks: MapEditBlock[]): Promise<void> {
    const existing = this.blocks.filter(b => b.bookId === bookId)
    const rebuilt = blocks
      .filter(e => !e.skipped)
      .map((e, i) => {
        const prev = existing.find(b => b.title === e.title)
        return prev
          ? { ...prev, moduleName: e.moduleName, seq: i + 1 }
          : {
              id: this.nextBlockId++, bookId, moduleName: e.moduleName, seq: i + 1,
              title: e.title, slug: `block-${bookId}-${this.nextBlockId - 1}`, prereqIds: [], status: 'unlearned' as const,
            }
      })
    this.blocks = this.blocks.filter(b => b.bookId !== bookId).concat(rebuilt)
  }

  async setActiveBook(bookId: number): Promise<void> {
    for (const b of this.books) {
      if (b.id === bookId) b.status = 'active'
      else if (b.status === 'active') b.status = 'paused'
    }
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

  async startSession(blockId: number, _kind: TaskKind): Promise<{ sessionId: number }> {
    const sessionId = this.nextSessionId++
    this.sessions.set(sessionId, { blockId, scriptIdx: 0 })
    return { sessionId }
  }

  async studentReply(sessionId: number, _transcript: ChatMessage[]): Promise<{ text: string; readyToEnd: boolean }> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`session ${sessionId} 不存在`)
    const reply = STUDENT_SCRIPT[Math.min(s.scriptIdx, STUDENT_SCRIPT.length - 1)]
    s.scriptIdx += 1
    return reply
  }

  async endSession(sessionId: number): Promise<EvalResult> {
    if (!this.sessions.has(sessionId)) throw new Error(`session ${sessionId} 不存在`)
    return EVAL_FIXTURE
  }

  async confirmVerdict(sessionId: number, pass: boolean): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`session ${sessionId} 不存在`)
    const block = this.blocks.find(b => b.id === s.blockId)
    if (!block) return
    if (pass) {
      block.status = 'passed'
      block.scores = EVAL_FIXTURE.scores
      block.passedAt = '2026-08-30'
    } else {
      block.status = 'learning'
    }
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

  async getSettings(): Promise<AppSettings> {
    return this.settings
  }

  async saveSettings(s: AppSettings): Promise<void> {
    this.settings = { ...s }
  }
}
