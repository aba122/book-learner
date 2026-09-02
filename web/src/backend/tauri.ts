import { invoke } from '@tauri-apps/api/core'
import tauriWireContract from '../../../shared/tauri-wire-contract.json'
import type {
  AppSettings, BlockStatus, Book, BookStatus, BookType, ChatMessage,
  DailyTask, EvalResult, KnowledgeBlock, Scores, Stats, StudyPlan, TaskKind,
} from '../types'
import { BackendError } from './errors'
import type { Backend, MapEditBlock } from './types'

export type InvokeFn = typeof invoke

type WireObject = Record<string, unknown>
type ErrorCode = 'invalid_request' | 'invalid_response'

function actualType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function invalidShape(path: string, expected: string, value: unknown, code: ErrorCode = 'invalid_response'): never {
  throw new BackendError({
    code,
    message: code === 'invalid_response' ? '后端返回数据格式无效' : '请求参数无法安全传输',
    retryable: false,
    details: { path, expected, actualType: actualType(value) },
  })
}

const IPC_ERRORS = {
  invalid_request: { message: '请求参数无效', retryable: false },
  not_found: { message: '未找到请求的数据', retryable: false },
  conflict: { message: '数据状态冲突，请刷新后重试', retryable: false },
  db_unavailable: { message: '无法读取本地学习数据', retryable: true },
  io_failure: { message: '无法访问本地文件', retryable: true },
  not_implemented: { message: '此功能尚未在 Mac 版中实现', retryable: false },
  internal: { message: '应用内部错误', retryable: false },
} as const

function normalizeInvokeError(value: unknown): BackendError {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const wire = value as WireObject
    if (typeof wire.code === 'string' && Object.hasOwn(IPC_ERRORS, wire.code)
      && typeof wire.message === 'string' && typeof wire.retryable === 'boolean') {
      const code = wire.code as keyof typeof IPC_ERRORS
      const safe = IPC_ERRORS[code]
      const rawDetails = wire.details
      const capability = typeof rawDetails === 'object' && rawDetails !== null && !Array.isArray(rawDetails)
        ? (rawDetails as WireObject).capability
        : undefined
      const details = code === 'not_implemented' && typeof capability === 'string'
        && tauriWireContract.unsupportedCapabilities.includes(capability)
        ? { capability }
        : undefined
      return new BackendError({ code, ...safe, details })
    }
  }
  return new BackendError({ code: 'unknown', message: '原生后端调用失败', retryable: false })
}

function objectAt(value: unknown, path: string, code: ErrorCode = 'invalid_response'): WireObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidShape(path, 'object', value, code)
  }
  return value as WireObject
}

function arrayAt<T>(value: unknown, path: string, decode: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) return invalidShape(path, 'array', value)
  return value.map((item, index) => decode(item, `${path}[${index}]`))
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string') return invalidShape(path, 'string', value)
  return value
}

function safeIntegerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) return invalidShape(path, 'safe integer', value)
  return value as number
}

function unitAt(value: unknown, path: string): void {
  if (value !== null) invalidShape(path, 'null Rust unit response', value)
}

function enumAt<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return invalidShape(path, allowed.join(' | '), value)
  }
  return value as T
}

function optionalAt<T>(value: WireObject, key: string, path: string, decode: (item: unknown, path: string) => T): T | undefined {
  return Object.hasOwn(value, key) ? decode(value[key], `${path}.${key}`) : undefined
}

const BOOK_TYPES = ['textbook', 'methodology', 'humanities'] as const satisfies readonly BookType[]
const BOOK_STATUSES = ['active', 'paused', 'finished'] as const satisfies readonly BookStatus[]
const BLOCK_STATUSES = ['unlearned', 'learning', 'passed', 'weak', 'consolidated'] as const satisfies readonly BlockStatus[]
const TASK_KINDS = ['new', 'weak_retest', 'review'] as const satisfies readonly TaskKind[]
const TASK_STATUSES = ['pending', 'done', 'skipped'] as const

function decodeBook(value: unknown, path: string): Book {
  const wire = objectAt(value, path)
  return {
    id: safeIntegerAt(wire.id, `${path}.id`),
    title: stringAt(wire.title, `${path}.title`),
    author: stringAt(wire.author, `${path}.author`),
    type: enumAt(wire.type, `${path}.type`, BOOK_TYPES),
    slug: stringAt(wire.slug, `${path}.slug`),
    status: enumAt(wire.status, `${path}.status`, BOOK_STATUSES),
  }
}

function decodeScores(value: unknown, path: string): Scores {
  const wire = objectAt(value, path)
  const score = (key: keyof Scores) => {
    const decoded = safeIntegerAt(wire[key], `${path}.${key}`)
    if (decoded < 1 || decoded > 5) return invalidShape(`${path}.${key}`, 'integer from 1 through 5', wire[key])
    return decoded
  }
  return { accuracy: score('accuracy'), completeness: score('completeness'), clarity: score('clarity') }
}

function decodeBlock(value: unknown, path: string): KnowledgeBlock {
  const wire = objectAt(value, path)
  const scores = optionalAt(wire, 'scores', path, decodeScores)
  const passedAt = optionalAt(wire, 'passedAt', path, stringAt)
  return {
    id: safeIntegerAt(wire.id, `${path}.id`),
    bookId: safeIntegerAt(wire.bookId, `${path}.bookId`),
    moduleName: stringAt(wire.moduleName, `${path}.moduleName`),
    seq: safeIntegerAt(wire.seq, `${path}.seq`),
    title: stringAt(wire.title, `${path}.title`),
    slug: stringAt(wire.slug, `${path}.slug`),
    prereqIds: arrayAt(wire.prereqIds, `${path}.prereqIds`, safeIntegerAt),
    status: enumAt(wire.status, `${path}.status`, BLOCK_STATUSES),
    ...(scores === undefined ? {} : { scores }),
    ...(passedAt === undefined ? {} : { passedAt }),
  }
}

function decodeTask(value: unknown, path: string): DailyTask {
  const wire = objectAt(value, path)
  const refId = optionalAt(wire, 'refId', path, safeIntegerAt)
  return {
    id: safeIntegerAt(wire.id, `${path}.id`),
    bookId: safeIntegerAt(wire.bookId, `${path}.bookId`),
    blockId: safeIntegerAt(wire.blockId, `${path}.blockId`),
    kind: enumAt(wire.kind, `${path}.kind`, TASK_KINDS),
    seq: safeIntegerAt(wire.seq, `${path}.seq`),
    status: enumAt(wire.status, `${path}.status`, TASK_STATUSES),
    estMinutes: safeIntegerAt(wire.estMinutes, `${path}.estMinutes`),
    ...(refId === undefined ? {} : { refId }),
  }
}

function decodeSettings(value: unknown): AppSettings {
  const wire = objectAt(value, 'settings')
  return {
    obsidianVault: stringAt(wire.obsidianVault, 'settings.obsidianVault'),
    pomodoroMinutes: safeIntegerAt(wire.pomodoroMinutes, 'settings.pomodoroMinutes'),
    breakMinutes: safeIntegerAt(wire.breakMinutes, 'settings.breakMinutes'),
    remindTime: stringAt(wire.remindTime, 'settings.remindTime'),
  }
}

function outboundInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value)) invalidShape(path, 'safe integer', value, 'invalid_request')
}

function outboundString(value: unknown, path: string): void {
  if (typeof value !== 'string') invalidShape(path, 'string', value, 'invalid_request')
}

function validatePlan(plan: StudyPlan): void {
  const value = objectAt(plan, 'request', 'invalid_request')
  outboundInteger(value.bookId, 'request.bookId')
  outboundString(value.deadline, 'request.deadline')
  outboundInteger(value.dailyNewBlocks, 'request.dailyNewBlocks')
  outboundInteger(value.dailyCap, 'request.dailyCap')
  outboundString(value.remindTime, 'request.remindTime')
}

function validateSettings(settings: AppSettings): void {
  const value = objectAt(settings, 'settings', 'invalid_request')
  outboundString(value.obsidianVault, 'settings.obsidianVault')
  outboundInteger(value.pomodoroMinutes, 'settings.pomodoroMinutes')
  outboundInteger(value.breakMinutes, 'settings.breakMinutes')
  outboundString(value.remindTime, 'settings.remindTime')
}

export class TauriBackend implements Backend {
  private readonly invokeFn: InvokeFn

  constructor(invokeFn: InvokeFn = invoke) {
    this.invokeFn = invokeFn
  }

  private async call(command: string, payload: WireObject): Promise<unknown> {
    try {
      return await this.invokeFn<unknown>(command, payload)
    } catch (error) {
      throw normalizeInvokeError(error)
    }
  }

  private async decode<T>(command: string, payload: WireObject, decoder: (value: unknown) => T): Promise<T> {
    return decoder(await this.call(command, payload))
  }

  private async unsupported<T>(capability: string): Promise<T> {
    await this.call('unsupported_capability', { capability })
    return invalidShape('unsupported_capability', 'rejected invocation', undefined)
  }

  async listBooks(): Promise<Book[]> {
    return this.decode('library_list_books', {}, value => arrayAt(value, 'books', decodeBook))
  }

  async setActiveBook(bookId: number): Promise<void> {
    outboundInteger(bookId, 'bookId')
    await this.decode('library_set_active_book', { bookId }, value => unitAt(value, 'library_set_active_book'))
  }

  async listBlocks(bookId: number): Promise<KnowledgeBlock[]> {
    outboundInteger(bookId, 'bookId')
    return this.decode('map_list_blocks', { bookId }, value => arrayAt(value, 'blocks', decodeBlock))
  }

  async getBlock(blockId: number): Promise<KnowledgeBlock> {
    outboundInteger(blockId, 'blockId')
    return this.decode('map_get_block', { blockId }, value => decodeBlock(value, 'block'))
  }

  async setPlan(plan: StudyPlan): Promise<void> {
    validatePlan(plan)
    await this.decode('planning_set_plan', { request: plan }, value => unitAt(value, 'planning_set_plan'))
  }

  async todayQueue(date: string): Promise<DailyTask[]> {
    outboundString(date, 'date')
    return this.decode('planning_today_queue', { date }, value => arrayAt(value, 'tasks', decodeTask))
  }

  async getSettings(): Promise<AppSettings> {
    return this.decode('settings_get', {}, decodeSettings)
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    validateSettings(settings)
    await this.decode('settings_save', { settings }, value => unitAt(value, 'settings_save'))
  }

  importEpub(_file: File, _type: BookType): Promise<{ bookId: number }> { return this.unsupported('importEpub') }
  generateMap(_bookId: number, _onProgress?: (msg: string) => void): Promise<KnowledgeBlock[]> { return this.unsupported('generateMap') }
  confirmMap(_bookId: number, _blocks: MapEditBlock[]): Promise<void> { return this.unsupported('confirmMap') }
  completeTask(_taskId: number): Promise<void> { return this.unsupported('completeTask') }
  blockSource(_blockId: number): Promise<{ href: string; text: string }> { return this.unsupported('blockSource') }
  epubUrl(_bookId: number): Promise<string> { return this.unsupported('epubUrl') }
  startSession(_blockId: number, _kind: TaskKind): Promise<{ sessionId: number }> { return this.unsupported('startSession') }
  studentReply(_sessionId: number, _transcript: ChatMessage[]): Promise<{ text: string; readyToEnd: boolean }> { return this.unsupported('studentReply') }
  endSession(_sessionId: number): Promise<EvalResult> { return this.unsupported('endSession') }
  confirmVerdict(_sessionId: number, _pass: boolean): Promise<void> { return this.unsupported('confirmVerdict') }
  stats(): Promise<Stats> { return this.unsupported('stats') }
}
