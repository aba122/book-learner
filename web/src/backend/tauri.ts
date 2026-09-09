import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import tauriWireContract from '../../../shared/tauri-wire-contract.json'
import { CLIENT_ID_RE, newClientId } from '../lib/ids'
import { localCalendarDate } from '../lib/localDate'
import type {
  AnchorPrecision, AnchorSegment, AppInfo, AppSettings, AvgScores, BackupList, BlockStatus, Book, BookProgress, BookStatus, BookType, ClientLogLevel, CodexBin, DailyTask, DayEffort, EvalResult, EvaluationView, ExportPreview, ExportReport, ExtraKind, ExtraOutcome, FinalReport, GitRemote, ImportState, KnowledgeBlock, MapEditOp, MapProgress, NewReaderMark, PomodoroPhase, PomodoroSnapshot, Profile, PushResult, ReaderMark, ReaderMarkKind, Replan, ReplanStatus, Scores, SessionKind, SessionState, SessionView, SnapshotInfo, SpineChapter, Stats, StatsDetail, StreakDay, StudyPlan, TaskKind, Transcript, TurnResult, TurnView, Verdict, VerdictOutcome, VoiceModel, WeakTrendDay,
} from '../types'
import { BackendError } from './errors'
import type { Backend } from './types'

export type InvokeFn = typeof invoke
export type UnlistenFn = () => void
/** Tauri event 订阅(默认动态加载 @tauri-apps/api/event;测试注入假函数) */
export type ListenFn = (event: string, handler: (event: { payload: unknown }) => void) => Promise<UnlistenFn>
export interface WireContract {
  commands: { method: string; command: string; payloadKeys: string[] }[]
  unsupportedCapabilities: string[]
}
export interface TauriBackendOptions {
  /** 门控契约:列在 unsupportedCapabilities 的方法一律走 unsupported_capability(Mac 接线后移除条目即生效) */
  contract?: WireContract
  listen?: ListenFn
  /** 受管 EPUB 路径 → asset 协议 URL(默认 @tauri-apps/api 的 convertFileSrc;测试注入) */
  convertFileSrc?: (path: string) => string
  /** 导入分块大小(默认 4 MiB;原生单块上限 8 MiB) */
  chunkBytes?: number
}
/** runMapJob 进度事件名与 payload:{ jobId, progress: MapProgress } */
export const MAP_JOB_PROGRESS_EVENT = 'map_job_progress'
/** 番茄钟阶段变化事件,payload 为 PomodoroSnapshot(M2 T3) */
export const POMODORO_CHANGED_EVENT = 'pomodoro_changed'
/** 原生导入(ADR-0004 选项 B):分块为原始请求体,元数据走头部;与 src-tauri commands 常量一致 */
export const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024
export const IMPORT_OP_ID_HEADER = 'x-op-id'
export const IMPORT_CHUNK_INDEX_HEADER = 'x-chunk-index'
/** 语音转写请求头(与 commands/mod.rs 一致):语言码;提示词经 encodeURIComponent(头部只能是 ASCII) */
export const VOICE_LANG_HEADER = 'x-bl-lang'
export const VOICE_HINT_HEADER = 'x-bl-hint'

const defaultListen: ListenFn = async (event, handler) => {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<unknown>(event, e => handler({ payload: e.payload }))
}

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
    message: code === 'invalid_response' ? '应用内核返回了无法识别的数据' : '请求内容无法安全传输',
    retryable: false,
    details: { path, expected, actualType: actualType(value) },
  })
}

const IPC_ERRORS = {
  invalid_request: { message: '请求内容无效', retryable: false },
  not_found: { message: '未找到请求的数据', retryable: false },
  conflict: { message: '数据已被更新,请刷新后重试', retryable: false },
  db_unavailable: { message: '无法读取本地学习数据', retryable: true },
  io_failure: { message: '无法访问本地文件', retryable: true },
  ai_unavailable: { message: 'AI 暂时没有回应,请重试', retryable: true },
  not_implemented: { message: '此功能暂未提供', retryable: false },
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
  // 非契约拒绝(如 Tauri 参数反序列化失败的纯字符串、DTO 漂移):显式归类为 transport_error,
  // details 只含脱敏摘要(类型/长度/键名,绝不带原文),并输出到控制台便于诊断(F8)。
  const details = redactedShape(value)
  console.error('[ipc] transport_error', details)
  return new BackendError({ code: 'transport_error', message: '与应用内核通信失败,请重试', retryable: false, details })
}

const REDACTED_KEY_LIMIT = 10

function redactedShape(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { actualType: 'string', length: value.length }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const shape: Record<string, unknown> = { actualType: 'object' }
    if (value instanceof Error) shape.errorName = value.name
    shape.keys = Object.keys(value).slice(0, REDACTED_KEY_LIMIT)
    return shape
  }
  return { actualType: actualType(value) }
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

function finiteNumberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalidShape(path, 'finite number', value)
  return value
}

function nullableAt<T>(value: unknown, path: string, decode: (v: unknown, p: string) => T): T | null {
  return value === null ? null : decode(value, path)
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return invalidShape(path, 'boolean', value)
  return value
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
const SESSION_STATES = ['open', 'evaluating', 'evaluated', 'confirmed', 'abandoned'] as const satisfies readonly SessionState[]
const SESSION_KINDS = ['learn', 'retest', 'review', 'final_exam'] as const satisfies readonly SessionKind[]
const EXTRA_KINDS = ['application', 'methodology', 'discussion'] as const satisfies readonly ExtraKind[]
const TURN_ROLES = ['user', 'student'] as const
const TURN_STATUSES = ['pending', 'done', 'failed'] as const
const VERDICTS = ['pass_suggested', 'relearn_suggested'] as const satisfies readonly Verdict[]
const ANCHOR_PRECISIONS = ['exact', 'chapter_fallback'] as const satisfies readonly AnchorPrecision[]
const MAP_OPS = ['rename', 'renameModule', 'reorder', 'setSkipped', 'merge', 'split'] as const
const TASK_KINDS = ['new', 'weak_retest', 'review'] as const satisfies readonly TaskKind[]
const TASK_STATUSES = ['pending', 'done', 'skipped'] as const

const IMPORT_STATES = ['ready', 'staged', 'extracted', 'mapped'] as const satisfies readonly ImportState[]
function decodeBook(value: unknown, path: string): Book {
  const wire = objectAt(value, path)
  return {
    id: safeIntegerAt(wire.id, `${path}.id`),
    title: stringAt(wire.title, `${path}.title`),
    author: stringAt(wire.author, `${path}.author`),
    type: enumAt(wire.type, `${path}.type`, BOOK_TYPES),
    slug: stringAt(wire.slug, `${path}.slug`),
    status: enumAt(wire.status, `${path}.status`, BOOK_STATUSES),
    mapRevision: safeIntegerAt(wire.mapRevision, `${path}.mapRevision`),
    importState: enumAt(wire.importState, `${path}.importState`, IMPORT_STATES),
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
    skipped: booleanAt(wire.skipped, `${path}.skipped`),
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
    eveningRemindTime: stringAt(wire.eveningRemindTime, 'settings.eveningRemindTime'),
  }
}

function outboundInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value)) invalidShape(path, 'safe integer', value, 'invalid_request')
}

function outboundBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') invalidShape(path, 'boolean', value, 'invalid_request')
}

/** 客户端 id:与 core validate_client_id 同规则(≤64,仅 [A-Za-z0-9._-]) */
function outboundClientId(value: unknown, path: string): void {
  if (typeof value !== 'string' || !CLIENT_ID_RE.test(value)) invalidShape(path, 'client id', value, 'invalid_request')
}

function outboundChapters(value: unknown): void {
  if (!Array.isArray(value)) invalidShape('chapters', 'array', value, 'invalid_request')
  ;(value as unknown[]).forEach((item, index) => {
    const wire = objectAt(item, `chapters[${index}]`, 'invalid_request')
    outboundInteger(wire.idx, `chapters[${index}].idx`)
    outboundString(wire.href, `chapters[${index}].href`)
    outboundString(wire.title, `chapters[${index}].title`)
    outboundString(wire.text, `chapters[${index}].text`)
  })
}

function outboundOps(value: unknown): void {
  if (!Array.isArray(value)) invalidShape('ops', 'array', value, 'invalid_request')
  ;(value as unknown[]).forEach((item, index) => {
    const path = `ops[${index}]`
    const wire = objectAt(item, path, 'invalid_request')
    switch (wire.op) {
      case 'rename':
        outboundInteger(wire.blockId, `${path}.blockId`)
        outboundString(wire.title, `${path}.title`)
        break
      case 'renameModule':
        outboundString(wire.from, `${path}.from`)
        outboundString(wire.to, `${path}.to`)
        break
      case 'reorder':
        if (!Array.isArray(wire.blockIds)) invalidShape(`${path}.blockIds`, 'array', wire.blockIds, 'invalid_request')
        ;(wire.blockIds as unknown[]).forEach((id, i) => outboundInteger(id, `${path}.blockIds[${i}]`))
        break
      case 'setSkipped':
        outboundInteger(wire.blockId, `${path}.blockId`)
        outboundBoolean(wire.skipped, `${path}.skipped`)
        break
      case 'merge':
        outboundInteger(wire.into, `${path}.into`)
        if (!Array.isArray(wire.from)) invalidShape(`${path}.from`, 'array', wire.from, 'invalid_request')
        ;(wire.from as unknown[]).forEach((id, i) => outboundInteger(id, `${path}.from[${i}]`))
        break
      case 'split':
        outboundInteger(wire.blockId, `${path}.blockId`)
        break
      default:
        invalidShape(`${path}.op`, MAP_OPS.join(' | '), wire.op, 'invalid_request')
    }
  })
}

function decodeRevision(value: unknown): { revision: number } {
  const wire = objectAt(value, 'map_confirm')
  return { revision: safeIntegerAt(wire.revision, 'map_confirm.revision') }
}

function outboundSegments(value: unknown): void {
  if (!Array.isArray(value)) invalidShape('segments', 'array', value, 'invalid_request')
  ;(value as unknown[]).forEach((item, index) => {
    const path = `segments[${index}]`
    const wire = objectAt(item, path, 'invalid_request')
    for (const key of ['spineHref', 'cfiStart', 'cfiEnd', 'hint', 'text'] as const) outboundString(wire[key], `${path}.${key}`)
    if (!ANCHOR_PRECISIONS.includes(wire.precision as AnchorPrecision)) {
      invalidShape(`${path}.precision`, ANCHOR_PRECISIONS.join(' | '), wire.precision, 'invalid_request')
    }
  })
}

// ---- 契约 v2 解码器(camelCase 镜像 core 结构)----

function decodeAnchorSegment(value: unknown, path: string): AnchorSegment {
  const wire = objectAt(value, path)
  return {
    spineHref: stringAt(wire.spineHref, `${path}.spineHref`),
    cfiStart: stringAt(wire.cfiStart, `${path}.cfiStart`),
    cfiEnd: stringAt(wire.cfiEnd, `${path}.cfiEnd`),
    precision: enumAt(wire.precision, `${path}.precision`, ANCHOR_PRECISIONS),
    hint: stringAt(wire.hint, `${path}.hint`),
    text: stringAt(wire.text, `${path}.text`),
  }
}

function decodeEval(value: unknown, path: string): EvalResult {
  const wire = objectAt(value, path)
  return {
    verdict: enumAt(wire.verdict, `${path}.verdict`, VERDICTS),
    scores: decodeScores(wire.scores, `${path}.scores`),
    summary: stringAt(wire.summary, `${path}.summary`),
    weakPoints: arrayAt(wire.weakPoints, `${path}.weakPoints`, (item, itemPath) => {
      const wp = objectAt(item, itemPath)
      return {
        title: stringAt(wp.title, `${itemPath}.title`),
        detail: stringAt(wp.detail, `${itemPath}.detail`),
        fixedInSession: booleanAt(wp.fixedInSession, `${itemPath}.fixedInSession`),
      }
    }),
    finalRestatement: stringAt(wire.finalRestatement, `${path}.finalRestatement`),
    observationNote: stringAt(wire.observationNote, `${path}.observationNote`),
  }
}

function decodeTurnView(value: unknown, path: string): TurnView {
  const wire = objectAt(value, path)
  const clientTurnId = wire.clientTurnId === null ? null : stringAt(wire.clientTurnId, `${path}.clientTurnId`)
  return {
    role: enumAt(wire.role, `${path}.role`, TURN_ROLES),
    text: stringAt(wire.text, `${path}.text`),
    status: enumAt(wire.status, `${path}.status`, TURN_STATUSES),
    clientTurnId,
    readyToEnd: booleanAt(wire.readyToEnd, `${path}.readyToEnd`),
  }
}

function decodeSessionView(value: unknown): SessionView {
  const path = 'session'
  const wire = objectAt(value, path)
  return {
    sessionId: safeIntegerAt(wire.sessionId, `${path}.sessionId`),
    taskId: safeIntegerAt(wire.taskId, `${path}.taskId`),
    version: safeIntegerAt(wire.version, `${path}.version`),
    state: enumAt(wire.state, `${path}.state`, SESSION_STATES),
    blockId: safeIntegerAt(wire.blockId, `${path}.blockId`),
    kind: enumAt(wire.kind, `${path}.kind`, SESSION_KINDS),
    extraKind: wire.extraKind === null ? null : enumAt(wire.extraKind, `${path}.extraKind`, EXTRA_KINDS),
    bookId: nullableAt(wire.bookId, `${path}.bookId`, safeIntegerAt),
    transcript: arrayAt(wire.transcript, `${path}.transcript`, decodeTurnView),
    eval: wire.eval === null ? null : decodeEval(wire.eval, `${path}.eval`),
  }
}

function decodeExtraOutcome(value: unknown): ExtraOutcome {
  const wire = objectAt(value, 'extra')
  return {
    kind: enumAt(wire.kind, 'extra.kind', EXTRA_KINDS),
    artifactId: safeIntegerAt(wire.artifactId, 'extra.artifactId'),
    version: safeIntegerAt(wire.version, 'extra.version'),
    contentMd: stringAt(wire.contentMd, 'extra.contentMd'),
  }
}

function decodeExportPreview(value: unknown): ExportPreview {
  const wire = objectAt(value, 'exportPreview')
  return {
    target: stringAt(wire.target, 'exportPreview.target'),
    targetExists: booleanAt(wire.targetExists, 'exportPreview.targetExists'),
    dir: stringAt(wire.dir, 'exportPreview.dir'),
    files: arrayAt(wire.files, 'exportPreview.files', (item, path) => stringAt(item, path)),
  }
}

function decodeExportReport(value: unknown): ExportReport {
  const wire = objectAt(value, 'exportReport')
  return {
    dir: stringAt(wire.dir, 'exportReport.dir'),
    written: safeIntegerAt(wire.written, 'exportReport.written'),
    unchanged: safeIntegerAt(wire.unchanged, 'exportReport.unchanged'),
  }
}

function decodeSnapshot(value: unknown, path = 'snapshot'): SnapshotInfo {
  const wire = objectAt(value, path)
  return {
    name: stringAt(wire.name, `${path}.name`),
    date: stringAt(wire.date, `${path}.date`),
    bytes: safeIntegerAt(wire.bytes, `${path}.bytes`),
  }
}

function decodeBackupList(value: unknown): BackupList {
  const wire = objectAt(value, 'backupList')
  return {
    snapshots: arrayAt(wire.snapshots, 'backupList.snapshots', (item, path) => decodeSnapshot(item, path)),
    pendingRestore: nullableAt(wire.pendingRestore, 'backupList.pendingRestore', stringAt),
  }
}

function decodeGitRemote(value: unknown): GitRemote {
  const wire = objectAt(value, 'gitRemote')
  return { url: nullableAt(wire.url, 'gitRemote.url', stringAt) }
}

function decodePushResult(value: unknown): PushResult {
  const wire = objectAt(value, 'pushResult')
  return {
    pushed: booleanAt(wire.pushed, 'pushResult.pushed'),
    error: nullableAt(wire.error, 'pushResult.error', stringAt),
  }
}

const READER_MARK_KINDS = ['highlight', 'bookmark', 'position'] as const satisfies readonly ReaderMarkKind[]

function decodeAppInfo(value: unknown): AppInfo {
  const wire = objectAt(value, 'appInfo')
  return {
    version: stringAt(wire.version, 'appInfo.version'),
    gitSha: stringAt(wire.gitSha, 'appInfo.gitSha'),
    builtAt: stringAt(wire.builtAt, 'appInfo.builtAt'),
    dataDir: stringAt(wire.dataDir, 'appInfo.dataDir'),
    logDir: stringAt(wire.logDir, 'appInfo.logDir'),
  }
}
function decodeCodexBin(value: unknown): CodexBin {
  const wire = objectAt(value, 'codexBin')
  return {
    path: nullableAt(wire.path, 'codexBin.path', stringAt),
    resolved: nullableAt(wire.resolved, 'codexBin.resolved', stringAt),
    error: nullableAt(wire.error, 'codexBin.error', stringAt),
  }
}
function decodeVoiceModel(value: unknown, path = 'voiceModel'): VoiceModel {
  const wire = objectAt(value, path)
  return {
    name: stringAt(wire.name, `${path}.name`),
    file: stringAt(wire.file, `${path}.file`),
    note: stringAt(wire.note, `${path}.note`),
    present: booleanAt(wire.present, `${path}.present`),
    bytes: nullableAt(wire.bytes, `${path}.bytes`, safeIntegerAt),
    selected: booleanAt(wire.selected, `${path}.selected`),
  }
}
function decodeTranscript(value: unknown): Transcript {
  const wire = objectAt(value, 'transcript')
  return {
    text: stringAt(wire.text, 'transcript.text'),
    seconds: finiteNumberAt(wire.seconds, 'transcript.seconds'),
    elapsed: finiteNumberAt(wire.elapsed, 'transcript.elapsed'),
    model: stringAt(wire.model, 'transcript.model'),
  }
}
function decodeReaderMark(value: unknown, path = 'readerMark'): ReaderMark {
  const wire = objectAt(value, path)
  return {
    id: safeIntegerAt(wire.id, `${path}.id`),
    bookId: safeIntegerAt(wire.bookId, `${path}.bookId`),
    kind: enumAt(wire.kind, `${path}.kind`, READER_MARK_KINDS),
    spineHref: stringAt(wire.spineHref, `${path}.spineHref`),
    cfiStart: stringAt(wire.cfiStart, `${path}.cfiStart`),
    cfiEnd: nullableAt(wire.cfiEnd, `${path}.cfiEnd`, stringAt),
    text: stringAt(wire.text, `${path}.text`),
    color: stringAt(wire.color, `${path}.color`),
    note: stringAt(wire.note, `${path}.note`),
    createdAt: stringAt(wire.createdAt, `${path}.createdAt`),
    updatedAt: stringAt(wire.updatedAt, `${path}.updatedAt`),
  }
}

function decodeFinalReport(value: unknown): FinalReport {
  const wire = objectAt(value, 'finalReport')
  const overall = safeIntegerAt(wire.overall, 'finalReport.overall')
  if (overall < 1 || overall > 5) invalidShape('finalReport.overall', '1..5', overall)
  return {
    artifactId: safeIntegerAt(wire.artifactId, 'finalReport.artifactId'),
    version: safeIntegerAt(wire.version, 'finalReport.version'),
    contentMd: stringAt(wire.contentMd, 'finalReport.contentMd'),
    overall,
    strongestModule: stringAt(wire.strongestModule, 'finalReport.strongestModule'),
    weakestModule: stringAt(wire.weakestModule, 'finalReport.weakestModule'),
  }
}

function decodeTurnResult(value: unknown): TurnResult {
  const wire = objectAt(value, 'turn')
  return {
    studentText: stringAt(wire.studentText, 'turn.studentText'),
    readyToEnd: booleanAt(wire.readyToEnd, 'turn.readyToEnd'),
    version: safeIntegerAt(wire.version, 'turn.version'),
  }
}

function decodeEvaluationView(value: unknown): EvaluationView {
  const wire = objectAt(value, 'evaluation')
  return {
    eval: decodeEval(wire.eval, 'evaluation.eval'),
    version: safeIntegerAt(wire.version, 'evaluation.version'),
  }
}

function decodeVerdictOutcome(value: unknown): VerdictOutcome {
  const wire = objectAt(value, 'verdict')
  return {
    passed: booleanAt(wire.passed, 'verdict.passed'),
    blockStatus: enumAt(wire.blockStatus, 'verdict.blockStatus', BLOCK_STATUSES),
    taskDone: booleanAt(wire.taskDone, 'verdict.taskDone'),
    outboxOps: safeIntegerAt(wire.outboxOps, 'verdict.outboxOps'),
    version: safeIntegerAt(wire.version, 'verdict.version'),
  }
}

function decodeImportResult(value: unknown): { bookId: number } {
  const wire = objectAt(value, 'library_import_epub_finalize')
  return { bookId: safeIntegerAt(wire.bookId, 'library_import_epub_finalize.bookId') }
}

function decodeBlockSource(value: unknown): { href: string; text: string } {
  const wire = objectAt(value, 'map_block_source')
  return {
    href: stringAt(wire.href, 'map_block_source.href'),
    text: stringAt(wire.text, 'map_block_source.text'),
  }
}

const REPLAN_STATUSES = ['on_track', 'auto_adjusted', 'needs_decision'] as const satisfies readonly ReplanStatus[]

function decodeReplan(value: unknown): Replan {
  const wire = objectAt(value, 'replan')
  const newDaily = optionalAt(wire, 'newDaily', 'replan', safeIntegerAt)
  const requiredDaily = optionalAt(wire, 'requiredDaily', 'replan', safeIntegerAt)
  return {
    status: enumAt(wire.status, 'replan.status', REPLAN_STATUSES),
    ...(newDaily === undefined ? {} : { newDaily }),
    ...(requiredDaily === undefined ? {} : { requiredDaily }),
    dailyCap: safeIntegerAt(wire.dailyCap, 'replan.dailyCap'),
    remainingBlocks: safeIntegerAt(wire.remainingBlocks, 'replan.remainingBlocks'),
    remainingDays: safeIntegerAt(wire.remainingDays, 'replan.remainingDays'),
    deadline: stringAt(wire.deadline, 'replan.deadline'),
  }
}

function decodePlanOrNull(value: unknown): StudyPlan | null {
  if (value === null) return null
  const wire = objectAt(value, 'plan')
  return {
    bookId: safeIntegerAt(wire.bookId, 'plan.bookId'),
    deadline: stringAt(wire.deadline, 'plan.deadline'),
    dailyNewBlocks: safeIntegerAt(wire.dailyNewBlocks, 'plan.dailyNewBlocks'),
    dailyCap: safeIntegerAt(wire.dailyCap, 'plan.dailyCap'),
    remindTime: stringAt(wire.remindTime, 'plan.remindTime'),
  }
}

const POMODORO_PHASES = ['idle', 'work', 'break', 'paused'] as const satisfies readonly PomodoroPhase[]
const PAUSED_PHASES = ['work', 'break'] as const

function decodePomodoro(value: unknown): PomodoroSnapshot {
  const wire = objectAt(value, 'pomodoro')
  return {
    phase: enumAt(wire.phase, 'pomodoro.phase', POMODORO_PHASES),
    taskId: wire.taskId === null ? null : safeIntegerAt(wire.taskId, 'pomodoro.taskId'),
    date: wire.date === null ? null : stringAt(wire.date, 'pomodoro.date'),
    endsAt: wire.endsAt === null ? null : safeIntegerAt(wire.endsAt, 'pomodoro.endsAt'),
    remainingSecs: safeIntegerAt(wire.remainingSecs, 'pomodoro.remainingSecs'),
    pausedPhase: wire.pausedPhase === null ? null : enumAt(wire.pausedPhase, 'pomodoro.pausedPhase', PAUSED_PHASES),
  }
}

const PROFILE_KEYS = ['background', 'mastered', 'pitfalls', 'context'] as const

function decodeProfile(value: unknown): Profile {
  const wire = objectAt(value, 'profile')
  const field = (key: keyof Profile) => stringAt(wire[key], `profile.${key}`)
  return { background: field('background'), mastered: field('mastered'), pitfalls: field('pitfalls'), context: field('context') }
}

function validateProfile(profile: Profile): void {
  const value = objectAt(profile, 'profile', 'invalid_request')
  for (const key of PROFILE_KEYS) outboundString(value[key], `profile.${key}`)
}

const BOOK_STATUSES_FOR_STATS = ['active', 'paused', 'finished'] as const satisfies readonly BookStatus[]

function decodeStatsDetail(value: unknown): StatsDetail {
  const wire = objectAt(value, 'statsDetail')
  return {
    books: arrayAt(wire.books, 'statsDetail.books', (item, path): BookProgress => {
      const b = objectAt(item, path)
      return {
        id: safeIntegerAt(b.id, `${path}.id`),
        title: stringAt(b.title, `${path}.title`),
        status: enumAt(b.status, `${path}.status`, BOOK_STATUSES_FOR_STATS),
        total: safeIntegerAt(b.total, `${path}.total`),
        passed: safeIntegerAt(b.passed, `${path}.passed`),
        consolidated: safeIntegerAt(b.consolidated, `${path}.consolidated`),
        deadline: nullableAt(b.deadline, `${path}.deadline`, stringAt),
        projectedFinish: nullableAt(b.projectedFinish, `${path}.projectedFinish`, stringAt),
      }
    }),
    days: arrayAt(wire.days, 'statsDetail.days', (item, path): DayEffort => {
      const d = objectAt(item, path)
      return {
        date: stringAt(d.date, `${path}.date`),
        minutes: safeIntegerAt(d.minutes, `${path}.minutes`),
        pomodoros: safeIntegerAt(d.pomodoros, `${path}.pomodoros`),
      }
    }),
    streakCalendar: arrayAt(wire.streakCalendar, 'statsDetail.streakCalendar', (item, path): StreakDay => {
      const d = objectAt(item, path)
      return { date: stringAt(d.date, `${path}.date`), active: booleanAt(d.active, `${path}.active`) }
    }),
    weakTrend: arrayAt(wire.weakTrend, 'statsDetail.weakTrend', (item, path): WeakTrendDay => {
      const d = objectAt(item, path)
      return {
        date: stringAt(d.date, `${path}.date`),
        opened: safeIntegerAt(d.opened, `${path}.opened`),
        fixed: safeIntegerAt(d.fixed, `${path}.fixed`),
      }
    }),
    avgScores: nullableAt(wire.avgScores, 'statsDetail.avgScores', (v, path): AvgScores => {
      const a = objectAt(v, path)
      return {
        accuracy: finiteNumberAt(a.accuracy, `${path}.accuracy`),
        completeness: finiteNumberAt(a.completeness, `${path}.completeness`),
        clarity: finiteNumberAt(a.clarity, `${path}.clarity`),
        samples: safeIntegerAt(a.samples, `${path}.samples`),
      }
    }),
    reviewPassRate: nullableAt(wire.reviewPassRate, 'statsDetail.reviewPassRate', finiteNumberAt),
  }
}

function decodeStats(value: unknown): Stats {
  const wire = objectAt(value, 'stats')
  const field = (key: keyof Stats) => safeIntegerAt(wire[key], `stats.${key}`)
  return {
    totalBlocks: field('totalBlocks'),
    passedBlocks: field('passedBlocks'),
    streakDays: field('streakDays'),
    openWeakPoints: field('openWeakPoints'),
    fixedWeakPoints: field('fixedWeakPoints'),
    minutesToday: field('minutesToday'),
  }
}

function decodeMapProgress(value: unknown, path: string): MapProgress {
  const wire = objectAt(value, path)
  switch (wire.stage) {
    case 'chapter':
      return {
        stage: 'chapter',
        index: safeIntegerAt(wire.index, `${path}.index`),
        total: safeIntegerAt(wire.total, `${path}.total`),
        title: stringAt(wire.title, `${path}.title`),
      }
    case 'merging':
      return { stage: 'merging' }
    case 'done':
      return { stage: 'done', blocks: safeIntegerAt(wire.blocks, `${path}.blocks`) }
    default:
      return invalidShape(`${path}.stage`, 'chapter | merging | done', wire.stage)
  }
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
  outboundString(value.eveningRemindTime, 'settings.eveningRemindTime')
}

export class TauriBackend implements Backend {
  private readonly invokeFn: InvokeFn
  private readonly contract: WireContract
  private readonly listen: ListenFn
  private readonly toAssetUrl: (path: string) => string
  private readonly chunkBytes: number

  constructor(invokeFn: InvokeFn = invoke, options: TauriBackendOptions = {}) {
    this.invokeFn = invokeFn
    this.contract = options.contract ?? tauriWireContract
    this.listen = options.listen ?? defaultListen
    this.toAssetUrl = options.convertFileSrc ?? (path => convertFileSrc(path))
    this.chunkBytes = options.chunkBytes ?? IMPORT_CHUNK_BYTES
  }

  /** 契约门控:未接线的 v2 能力显式 not_implemented,而不是调用不存在的 command 得到 transport_error */
  private async gated<T>(method: string, run: () => Promise<T>): Promise<T> {
    if (this.contract.unsupportedCapabilities.includes(method)) return this.unsupported<T>(method)
    return run() // async 包裹:出站校验的同步 throw 统一变成 rejection
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

  /** 原始请求体调用(Tauri 2:Uint8Array 作为 body,元数据走 headers) */
  private async callRaw(command: string, bytes: Uint8Array, headers: Record<string, string>): Promise<unknown> {
    try {
      return await this.invokeFn<unknown>(command, bytes, { headers })
    } catch (error) {
      throw normalizeInvokeError(error)
    }
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

  async finishBook(bookId: number): Promise<void> {
    return this.gated('finishBook', async () => {
      outboundInteger(bookId, 'bookId')
      await this.decode('library_finish_book', { bookId }, value => unitAt(value, 'library_finish_book'))
    })
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

  async checkBehind(bookId: number, date: string): Promise<Replan> {
    return this.gated('checkBehind', () => {
      outboundInteger(bookId, 'bookId')
      outboundString(date, 'date')
      return this.decode('planning_check_behind', { bookId, date }, decodeReplan)
    })
  }

  async getPlan(bookId: number): Promise<StudyPlan | null> {
    return this.gated('getPlan', () => {
      outboundInteger(bookId, 'bookId')
      return this.decode('planning_get_plan', { bookId }, decodePlanOrNull)
    })
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

  /** 分块上传 → finalize(同 opId 幂等);EPUB 抽取仍在 JS 侧(ADR-0004 选项 B) */
  async importEpub(file: File, type: BookType): Promise<{ bookId: number }> {
    return this.gated('importEpub', async () => {
      if (!BOOK_TYPES.includes(type)) invalidShape('type', BOOK_TYPES.join(' | '), type, 'invalid_request')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength === 0) {
        throw new BackendError({ code: 'invalid_request', message: '所选文件为空', retryable: false })
      }
      const opId = newClientId()
      for (let index = 0, offset = 0; offset < bytes.byteLength; index += 1, offset += this.chunkBytes) {
        const chunk = bytes.slice(offset, Math.min(offset + this.chunkBytes, bytes.byteLength))
        await this.callRaw('library_import_epub_chunk', chunk, {
          [IMPORT_OP_ID_HEADER]: opId,
          [IMPORT_CHUNK_INDEX_HEADER]: String(index),
        })
      }
      const title = file.name.replace(/\.epub$/i, '')
      return this.decode('library_import_epub_finalize', { opId, bookType: type, title }, decodeImportResult)
    })
  }
  confirmMap(bookId: number, expectedRevision: number, ops: MapEditOp[]): Promise<{ revision: number }> {
    return this.gated('confirmMap', () => {
      outboundInteger(bookId, 'bookId')
      outboundInteger(expectedRevision, 'expectedRevision')
      outboundOps(ops)
      return this.decode('map_confirm', { bookId, expectedRevision, ops }, decodeRevision)
    })
  }
  completeTask(_taskId: number): Promise<void> { return this.unsupported('completeTask') }
  async blockSource(blockId: number): Promise<{ href: string; text: string }> {
    return this.gated('blockSource', async () => {
      outboundInteger(blockId, 'blockId')
      return this.decode('map_block_source', { blockId }, decodeBlockSource)
    })
  }
  /** 原生只返回受管路径 books/<id>.epub;此处转为 asset 协议 URL 供 epub.js 加载 */
  async epubUrl(bookId: number): Promise<string> {
    return this.gated('epubUrl', async () => {
      outboundInteger(bookId, 'bookId')
      const path = await this.decode('library_epub_url', { bookId }, value => stringAt(value, 'library_epub_url'))
      return this.toAssetUrl(path)
    })
  }
  async pomodoroStart(taskId: number, date: string): Promise<PomodoroSnapshot> {
    return this.gated('pomodoroStart', () => {
      outboundInteger(taskId, 'taskId')
      outboundString(date, 'date')
      return this.decode('pomodoro_start', { taskId, date }, decodePomodoro)
    })
  }
  async pomodoroPause(): Promise<PomodoroSnapshot> {
    return this.gated('pomodoroPause', () => this.decode('pomodoro_pause', {}, decodePomodoro))
  }
  async pomodoroResume(): Promise<PomodoroSnapshot> {
    return this.gated('pomodoroResume', () => this.decode('pomodoro_resume', {}, decodePomodoro))
  }
  async pomodoroStop(): Promise<PomodoroSnapshot> {
    return this.gated('pomodoroStop', () => this.decode('pomodoro_stop', {}, decodePomodoro))
  }
  async pomodoroState(): Promise<PomodoroSnapshot> {
    return this.gated('pomodoroState', () => this.decode('pomodoro_state', {}, decodePomodoro))
  }
  /** 阶段变化事件:畸形 payload 忽略(快照仍可经 pomodoroState 取回) */
  async subscribePomodoro(handler: (snapshot: PomodoroSnapshot) => void): Promise<() => void> {
    return this.listen(POMODORO_CHANGED_EVENT, event => {
      try {
        handler(decodePomodoro(event.payload))
      } catch {
        // 忽略畸形事件
      }
    })
  }

  async profileGet(): Promise<Profile> {
    return this.gated('profileGet', () => this.decode('profile_get', {}, decodeProfile))
  }
  async profileSave(profile: Profile): Promise<void> {
    return this.gated('profileSave', async () => {
      validateProfile(profile)
      await this.decode('profile_save', { profile }, value => unitAt(value, 'profile_save'))
    })
  }

  extraStart(blockId: number, kind: ExtraKind, clientRequestId: string): Promise<SessionView> {
    return this.gated('extraStart', () => {
      outboundInteger(blockId, 'blockId')
      if (!EXTRA_KINDS.includes(kind)) invalidShape('kind', EXTRA_KINDS.join(' | '), kind, 'invalid_request')
      outboundClientId(clientRequestId, 'clientRequestId')
      return this.decode('extra_start', { blockId, kind, clientRequestId }, decodeSessionView)
    })
  }

  extraFinish(sessionId: number, expectedVersion: number, requestId: string): Promise<ExtraOutcome> {
    return this.gated('extraFinish', () => {
      outboundInteger(sessionId, 'sessionId')
      outboundInteger(expectedVersion, 'expectedVersion')
      outboundClientId(requestId, 'requestId')
      return this.decode('extra_finish', { sessionId, expectedVersion, requestId }, decodeExtraOutcome)
    })
  }

  /** 统计以本地日历日为"今天"(core 不读系统时间) */
  async stats(): Promise<Stats> {
    return this.gated('stats', () => this.decode('stats_get', { date: localCalendarDate() }, decodeStats))
  }

  finalExamEligible(bookId: number): Promise<boolean> {
    return this.gated('finalExamEligible', () => {
      outboundInteger(bookId, 'bookId')
      return this.decode('final_exam_eligible', { bookId }, value => booleanAt(value, 'final_exam_eligible'))
    })
  }

  finalExamStart(bookId: number, clientRequestId: string): Promise<SessionView> {
    return this.gated('finalExamStart', () => {
      outboundInteger(bookId, 'bookId')
      outboundClientId(clientRequestId, 'clientRequestId')
      return this.decode('final_exam_start', { bookId, clientRequestId }, decodeSessionView)
    })
  }

  finalExamFinish(sessionId: number, expectedVersion: number, requestId: string): Promise<FinalReport> {
    return this.gated('finalExamFinish', () => {
      outboundInteger(sessionId, 'sessionId')
      outboundInteger(expectedVersion, 'expectedVersion')
      outboundClientId(requestId, 'requestId')
      return this.decode('final_exam_finish', { sessionId, expectedVersion, requestId }, decodeFinalReport)
    })
  }

  exportPreview(bookId: number): Promise<ExportPreview> {
    return this.gated('exportPreview', () => {
      outboundInteger(bookId, 'bookId')
      return this.decode('export_preview', { bookId }, decodeExportPreview)
    })
  }

  exportObsidian(bookId: number): Promise<ExportReport> {
    return this.gated('exportObsidian', () => {
      outboundInteger(bookId, 'bookId')
      return this.decode('export_obsidian', { bookId }, decodeExportReport)
    })
  }

  async exportReveal(bookId: number): Promise<void> {
    return this.gated('exportReveal', async () => {
      outboundInteger(bookId, 'bookId')
      await this.decode('export_reveal', { bookId }, value => unitAt(value, 'export_reveal'))
    })
  }

  backupSnapshotNow(date: string): Promise<SnapshotInfo> {
    return this.gated('backupSnapshotNow', () => {
      outboundString(date, 'date')
      return this.decode('backup_snapshot_now', { date }, value => decodeSnapshot(value))
    })
  }
  backupList(): Promise<BackupList> {
    return this.gated('backupList', () => this.decode('backup_list', {}, decodeBackupList))
  }
  backupRestore(name: string): Promise<BackupList> {
    return this.gated('backupRestore', () => {
      outboundString(name, 'name')
      return this.decode('backup_restore', { name }, decodeBackupList)
    })
  }
  backupCancelRestore(): Promise<BackupList> {
    return this.gated('backupCancelRestore', () => this.decode('backup_cancel_restore', {}, decodeBackupList))
  }
  gitRemoteGet(): Promise<GitRemote> {
    return this.gated('gitRemoteGet', () => this.decode('git_remote_get', {}, decodeGitRemote))
  }
  gitRemoteSet(url: string): Promise<GitRemote> {
    return this.gated('gitRemoteSet', () => {
      outboundString(url, 'url')
      return this.decode('git_remote_set', { url }, decodeGitRemote)
    })
  }
  gitPushNow(): Promise<PushResult> {
    return this.gated('gitPushNow', () => this.decode('git_push_now', {}, decodePushResult))
  }

  readerMarkList(bookId: number): Promise<ReaderMark[]> {
    return this.gated('readerMarkList', () => {
      outboundInteger(bookId, 'bookId')
      return this.decode('reader_mark_list', { bookId }, value => arrayAt(value, 'readerMarks', (item, path) => decodeReaderMark(item, path)))
    })
  }
  readerMarkAdd(bookId: number, mark: NewReaderMark): Promise<ReaderMark> {
    return this.gated('readerMarkAdd', () => {
      outboundInteger(bookId, 'bookId')
      const wire = objectAt(mark, 'mark', 'invalid_request')
      outboundString(wire.kind, 'mark.kind')
      outboundString(wire.spineHref, 'mark.spineHref')
      outboundString(wire.cfiStart, 'mark.cfiStart')
      const payload = {
        kind: mark.kind, spineHref: mark.spineHref, cfiStart: mark.cfiStart, cfiEnd: mark.cfiEnd ?? null,
        text: mark.text ?? '', color: mark.color ?? '', note: mark.note ?? '',
      }
      return this.decode('reader_mark_add', { bookId, mark: payload }, value => decodeReaderMark(value))
    })
  }
  readerMarkUpdate(id: number, note: string | null, color: string | null): Promise<ReaderMark> {
    return this.gated('readerMarkUpdate', () => {
      outboundInteger(id, 'id')
      return this.decode('reader_mark_update', { id, note, color }, value => decodeReaderMark(value))
    })
  }
  async readerMarkRemove(id: number): Promise<void> {
    return this.gated('readerMarkRemove', async () => {
      outboundInteger(id, 'id')
      await this.decode('reader_mark_remove', { id }, value => unitAt(value, 'reader_mark_remove'))
    })
  }
  readerPositionSet(bookId: number, spineHref: string, cfi: string): Promise<ReaderMark> {
    return this.gated('readerPositionSet', () => {
      outboundInteger(bookId, 'bookId')
      outboundString(spineHref, 'spineHref')
      outboundString(cfi, 'cfi')
      return this.decode('reader_position_set', { bookId, spineHref, cfi }, value => decodeReaderMark(value))
    })
  }

  async statsDetail(): Promise<StatsDetail> {
    return this.gated('statsDetail', () => this.decode('stats_detail', { date: localCalendarDate() }, decodeStatsDetail))
  }

  // ---- 诊断 ----
  appInfo(): Promise<AppInfo> {
    return this.gated('appInfo', () => this.decode('app_info', {}, decodeAppInfo))
  }
  async appRevealLogs(): Promise<void> {
    return this.gated('appRevealLogs', async () => {
      await this.decode('app_reveal_logs', {}, value => unitAt(value, 'app_reveal_logs'))
    })
  }
  /** 日志转发绝不影响页面:任何失败吞掉(避免 error → log → error 循环) */
  async logClientEvent(level: ClientLogLevel, message: string, context?: Record<string, unknown>): Promise<void> {
    try {
      await this.invokeFn<unknown>('log_client_event', { level, message, context: context ?? null })
    } catch {
      /* 日志失败静默 */
    }
  }

  // ---- 删除书(测试阶段)----
  deleteBook(bookId: number, date: string): Promise<void> {
    return this.gated('deleteBook', async () => {
      outboundInteger(bookId, 'bookId')
      outboundString(date, 'date')
      await this.decode('library_delete_book', { bookId, date }, value => unitAt(value, 'library_delete_book'))
    })
  }

  // ---- codex 路径(M3 T6)----
  codexBinGet(): Promise<CodexBin> {
    return this.gated('codexBinGet', () => this.decode('settings_codex_get', {}, decodeCodexBin))
  }
  codexBinSet(path: string | null): Promise<CodexBin> {
    return this.gated('codexBinSet', () => {
      if (path !== null) outboundString(path, 'path')
      return this.decode('settings_codex_set', { path }, decodeCodexBin)
    })
  }

  // ---- 语音(M3 T3)----
  voiceModels(): Promise<VoiceModel[]> {
    return this.gated('voiceModels', () => this.decode('voice_models', {}, value => arrayAt(value, 'voiceModels', decodeVoiceModel)))
  }
  voiceImportModel(path: string | null): Promise<VoiceModel | null> {
    return this.gated('voiceImportModel', () => {
      if (path !== null) outboundString(path, 'path')
      return this.decode('voice_import_model', { path }, value => nullableAt(value, 'voiceModel', decodeVoiceModel))
    })
  }
  voiceSelectModel(name: string): Promise<VoiceModel[]> {
    return this.gated('voiceSelectModel', () => {
      outboundString(name, 'name')
      return this.decode('voice_select_model', { name }, value => arrayAt(value, 'voiceModels', decodeVoiceModel))
    })
  }
  voiceDeleteModel(name: string): Promise<VoiceModel[]> {
    return this.gated('voiceDeleteModel', () => {
      outboundString(name, 'name')
      return this.decode('voice_delete_model', { name }, value => arrayAt(value, 'voiceModels', decodeVoiceModel))
    })
  }
  /** 原始请求体 = i16 小端 PCM 字节;单块上限与导入相同(8 MiB ≈ 262 s @16 kHz),前端录音已限 120 s */
  voiceTranscribe(pcm: Int16Array, lang: string, hint: string): Promise<Transcript> {
    return this.gated('voiceTranscribe', async () => {
      outboundString(lang, 'lang')
      if (pcm.length === 0) throw new BackendError({ code: 'invalid_request', message: '没有录到声音', retryable: false })
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      const value = await this.callRaw('voice_transcribe', bytes, {
        [VOICE_LANG_HEADER]: lang,
        [VOICE_HINT_HEADER]: encodeURIComponent(hint),
      })
      return decodeTranscript(value)
    })
  }

  // ---- 契约 v2(按 unsupportedCapabilities 门控;Rust command/DTO 接线在 Mac)----

  storeSpine(bookId: number, chapters: SpineChapter[]): Promise<void> {
    return this.gated('storeSpine', async () => {
      outboundInteger(bookId, 'bookId')
      outboundChapters(chapters)
      await this.decode('map_store_spine', { bookId, chapters }, value => unitAt(value, 'map_store_spine'))
    })
  }

  runMapJob(bookId: number, jobId: string, onProgress?: (p: MapProgress) => void): Promise<KnowledgeBlock[]> {
    return this.gated('runMapJob', async () => {
      outboundInteger(bookId, 'bookId')
      outboundClientId(jobId, 'jobId')
      let unlisten: UnlistenFn | null = null
      if (onProgress) {
        unlisten = await this.listen(MAP_JOB_PROGRESS_EVENT, event => {
          const wire = event.payload
          if (typeof wire !== 'object' || wire === null || Array.isArray(wire)) return
          if ((wire as WireObject).jobId !== jobId) return
          try {
            onProgress(decodeMapProgress((wire as WireObject).progress, `${MAP_JOB_PROGRESS_EVENT}.progress`))
          } catch {
            // 进度只是提示,畸形事件忽略;最终结果仍由 command 返回值决定
          }
        })
      }
      try {
        return await this.decode('map_run_job', { bookId, jobId }, value => arrayAt(value, 'blocks', decodeBlock))
      } finally {
        unlisten?.()
      }
    })
  }

  setAnchorSegments(blockId: number, segments: AnchorSegment[]): Promise<void> {
    return this.gated('setAnchorSegments', async () => {
      outboundInteger(blockId, 'blockId')
      outboundSegments(segments)
      await this.decode('map_set_anchor_segments', { blockId, segments }, value => unitAt(value, 'map_set_anchor_segments'))
    })
  }

  listAnchors(blockId: number): Promise<AnchorSegment[]> {
    return this.gated('listAnchors', () => {
      outboundInteger(blockId, 'blockId')
      return this.decode('map_list_anchors', { blockId }, value => arrayAt(value, 'anchors', decodeAnchorSegment))
    })
  }

  startOrResumeSession(taskId: number, clientRequestId: string, date: string): Promise<SessionView> {
    return this.gated('startOrResumeSession', () => {
      outboundInteger(taskId, 'taskId')
      outboundClientId(clientRequestId, 'clientRequestId')
      outboundString(date, 'date')
      return this.decode('session_start_or_resume', { taskId, clientRequestId, date }, decodeSessionView)
    })
  }

  submitTurn(sessionId: number, expectedVersion: number, clientTurnId: string, text: string): Promise<TurnResult> {
    return this.gated('submitTurn', () => {
      outboundInteger(sessionId, 'sessionId')
      outboundInteger(expectedVersion, 'expectedVersion')
      outboundClientId(clientTurnId, 'clientTurnId')
      outboundString(text, 'text')
      return this.decode('session_submit_turn', { sessionId, expectedVersion, clientTurnId, text }, decodeTurnResult)
    })
  }

  requestEvaluation(sessionId: number, requestId: string): Promise<EvaluationView> {
    return this.gated('requestEvaluation', () => {
      outboundInteger(sessionId, 'sessionId')
      outboundClientId(requestId, 'requestId')
      return this.decode('session_request_evaluation', { sessionId, requestId }, decodeEvaluationView)
    })
  }

  confirmSessionVerdict(sessionId: number, expectedVersion: number, requestId: string, pass: boolean, date: string): Promise<VerdictOutcome> {
    return this.gated('confirmSessionVerdict', () => {
      outboundInteger(sessionId, 'sessionId')
      outboundInteger(expectedVersion, 'expectedVersion')
      outboundClientId(requestId, 'requestId')
      outboundBoolean(pass, 'pass')
      outboundString(date, 'date')
      return this.decode('session_confirm_verdict', { sessionId, expectedVersion, requestId, pass, date }, decodeVerdictOutcome)
    })
  }

  abandonSession(sessionId: number, expectedVersion: number): Promise<void> {
    return this.gated('abandonSession', async () => {
      outboundInteger(sessionId, 'sessionId')
      outboundInteger(expectedVersion, 'expectedVersion')
      await this.decode('session_abandon', { sessionId, expectedVersion }, value => unitAt(value, 'session_abandon'))
    })
  }
}
