import { describe, expect, it, vi } from 'vitest'
import tauriWireContract from '../../../shared/tauri-wire-contract.json'
import { BackendError } from './errors'
import { TauriBackend, type InvokeFn } from './tauri'

const book = {
  id: 1,
  title: '微观经济学',
  author: '曼昆',
  type: 'textbook',
  slug: 'microeconomics',
  status: 'active',
  mapRevision: 1,
}

const block = {
  id: 2,
  bookId: 1,
  moduleName: '供给与需求',
  seq: 1,
  title: '供需弹性',
  slug: 'elasticity',
  prereqIds: [1],
  status: 'passed',
  scores: { accuracy: 5, completeness: 4, clarity: 3 },
  passedAt: '2026-08-31',
  skipped: false,
}

const task = {
  id: 3,
  bookId: 1,
  blockId: 2,
  kind: 'review',
  seq: 1,
  status: 'pending',
  estMinutes: 5,
  refId: 4,
}

const settings = {
  obsidianVault: '/tmp/vault',
  pomodoroMinutes: 25,
  breakMinutes: 5,
  remindTime: '20:00',
}

describe('TauriBackend supported transport', () => {
  it('uses the shared wire commands and decodes complete fixtures', async () => {
    const calls: { command: string; payload: Record<string, unknown> }[] = []
    const replies: Record<string, unknown> = {
      library_list_books: [book],
      library_set_active_book: null,
      map_list_blocks: [block],
      map_get_block: block,
      planning_set_plan: null,
      planning_today_queue: [task],
      settings_get: settings,
      settings_save: null,
    }
    const invoke: InvokeFn = async <T>(command: string, payload = {}) => {
      calls.push({ command, payload })
      return replies[command] as T
    }
    const backend = new TauriBackend(invoke)
    const plan = { bookId: 1, deadline: '2026-09-30', dailyNewBlocks: 2, dailyCap: 60, remindTime: '20:00' }

    expect(await backend.listBooks()).toEqual([book])
    await backend.setActiveBook(1)
    expect(await backend.listBlocks(1)).toEqual([block])
    expect(await backend.getBlock(2)).toEqual(block)
    await backend.setPlan(plan)
    expect(await backend.todayQueue('2026-09-01')).toEqual([task])
    expect(await backend.getSettings()).toEqual(settings)
    await backend.saveSettings(settings)

    // 本用例只走 v1 的 8 个方法;v2 与原生导入/阅读器方法的传输由下方专门用例覆盖
    const expected = tauriWireContract.commands.filter(entry =>
      entry.method !== 'unsupported' && !V2_METHODS.includes(entry.method) && !NATIVE_METHODS.includes(entry.method))
    expect(calls.map(({ command, payload }, index) => ({
      method: expected[index].method,
      command,
      payloadKeys: Object.keys(payload),
    }))).toEqual(expected)
    expect(calls).toMatchObject([
      { payload: {} },
      { payload: { bookId: 1 } },
      { payload: { bookId: 1 } },
      { payload: { blockId: 2 } },
      { payload: { request: plan } },
      { payload: { date: '2026-09-01' } },
      { payload: {} },
      { payload: { settings } },
    ])
  })

  it('preserves absent optional block and task fields', async () => {
    const blockWithoutOptional = { ...block }
    delete (blockWithoutOptional as Partial<typeof block>).scores
    delete (blockWithoutOptional as Partial<typeof block>).passedAt
    const taskWithoutRef = { ...task }
    delete (taskWithoutRef as Partial<typeof task>).refId
    const invoke: InvokeFn = async <T>(command: string) => (
      command === 'map_get_block' ? blockWithoutOptional : [taskWithoutRef]
    ) as T
    const backend = new TauriBackend(invoke)

    expect(await backend.getBlock(2)).toEqual(blockWithoutOptional)
    expect(await backend.todayQueue('2026-09-01')).toEqual([taskWithoutRef])
  })

  it('requires mapRevision/skipped now that the native DTO carries them (Mac M4)', async () => {
    const legacyBook = { ...book } as Partial<typeof book>
    delete legacyBook.mapRevision
    const legacyBlock = { ...block } as Partial<typeof block>
    delete legacyBlock.skipped
    const invoke: InvokeFn = async <T>(command: string) => (
      command === 'library_list_books' ? [legacyBook] : legacyBlock
    ) as T
    const backend = new TauriBackend(invoke)

    await expect(backend.listBooks()).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(backend.getBlock(2)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it.each([
    ['books must be an array', {}, (backend: TauriBackend) => backend.listBooks()],
    ['each book must be an object', [null], (backend: TauriBackend) => backend.listBooks()],
    ['book IDs must be safe integers', [{ ...book, id: Number.MAX_SAFE_INTEGER + 1 }], (backend: TauriBackend) => backend.listBooks()],
    ['book strings keep their wire shape', [{ ...book, title: 42 }], (backend: TauriBackend) => backend.listBooks()],
    ['book type is exact', [{ ...book, type: 'novel' }], (backend: TauriBackend) => backend.listBooks()],
    ['book status is exact', [{ ...book, status: 'archived' }], (backend: TauriBackend) => backend.listBooks()],
    ['block IDs are safe integers', { ...block, id: Number.MAX_SAFE_INTEGER + 1 }, (backend: TauriBackend) => backend.getBlock(2)],
    ['block IDs are safe integers', { ...block, bookId: 1.5 }, (backend: TauriBackend) => backend.getBlock(2)],
    ['block sequence is a safe integer', { ...block, seq: Number.POSITIVE_INFINITY }, (backend: TauriBackend) => backend.getBlock(2)],
    ['prerequisite IDs are safe integers', { ...block, prereqIds: [Number.MAX_SAFE_INTEGER + 1] }, (backend: TauriBackend) => backend.getBlock(2)],
    ['block status is exact', { ...block, status: 'queued' }, (backend: TauriBackend) => backend.getBlock(2)],
    ['scores are objects', { ...block, scores: [] }, (backend: TauriBackend) => backend.getBlock(2)],
    ['scores are safe integers from 1 through 5', { ...block, scores: { ...block.scores, clarity: 6 } }, (backend: TauriBackend) => backend.getBlock(2)],
    ['present passedAt is a string', { ...block, passedAt: null }, (backend: TauriBackend) => backend.getBlock(2)],
    ['task IDs are safe integers', [{ ...task, id: Number.MAX_SAFE_INTEGER + 1 }], (backend: TauriBackend) => backend.todayQueue('2026-09-01')],
    ['task book IDs are safe integers', [{ ...task, bookId: 1.5 }], (backend: TauriBackend) => backend.todayQueue('2026-09-01')],
    ['task block IDs are safe integers', [{ ...task, blockId: Number.NaN }], (backend: TauriBackend) => backend.todayQueue('2026-09-01')],
    ['task kind is exact', [{ ...task, kind: 'quiz' }], (backend: TauriBackend) => backend.todayQueue('2026-09-01')],
    ['task status is exact', [{ ...task, status: 'running' }], (backend: TauriBackend) => backend.todayQueue('2026-09-01')],
    ['task durations are safe integers', [{ ...task, estMinutes: 5.5 }], (backend: TauriBackend) => backend.todayQueue('2026-09-01')],
    ['present refId is a safe integer', [{ ...task, refId: null }], (backend: TauriBackend) => backend.todayQueue('2026-09-01')],
    ['settings are objects', [], (backend: TauriBackend) => backend.getSettings()],
    ['settings paths are strings', { ...settings, obsidianVault: 1 }, (backend: TauriBackend) => backend.getSettings()],
    ['settings durations are safe integers', { ...settings, breakMinutes: 2.5 }, (backend: TauriBackend) => backend.getSettings()],
    ['settings remindTime is a string', { ...settings, remindTime: 2000 }, (backend: TauriBackend) => backend.getSettings()],
  ])('rejects malformed wire data: %s', async (_name, reply, operation) => {
    const backend = new TauriBackend(async <T>() => reply as T)
    const result = operation(backend)

    await expect(result).rejects.toMatchObject({
      name: 'BackendError',
      code: 'invalid_response',
      retryable: false,
    })
    await expect(result).rejects.toBeInstanceOf(BackendError)
  })

  it.each([
    ['setActiveBook ID', (backend: TauriBackend) => backend.setActiveBook(Number.MAX_SAFE_INTEGER + 1)],
    ['listBlocks ID', (backend: TauriBackend) => backend.listBlocks(1.5)],
    ['getBlock ID', (backend: TauriBackend) => backend.getBlock(Number.NaN)],
    ['plan i64 fields', (backend: TauriBackend) => backend.setPlan({
      bookId: 1, deadline: '2026-09-30', dailyNewBlocks: 1.5, dailyCap: 60, remindTime: '20:00',
    })],
    ['settings i64 fields', (backend: TauriBackend) => backend.saveSettings({ ...settings, pomodoroMinutes: Number.POSITIVE_INFINITY })],
  ])('rejects unsafe outbound transport values: %s', async (_name, operation) => {
    let invoked = false
    const backend = new TauriBackend(async <T>() => {
      invoked = true
      return undefined as T
    })

    await expect(operation(backend)).rejects.toBeInstanceOf(BackendError)
    expect(invoked).toBe(false)
  })

  it.each([
    ['null plan', (backend: TauriBackend) => backend.setPlan(null as never)],
    ['array plan', (backend: TauriBackend) => backend.setPlan([] as never)],
    ['null settings', (backend: TauriBackend) => backend.saveSettings(null as never)],
    ['array settings', (backend: TauriBackend) => backend.saveSettings([] as never)],
  ])('classifies an invalid outbound root as invalid_request: %s', async (_name, operation) => {
    let invoked = false
    const backend = new TauriBackend(async <T>() => {
      invoked = true
      return null as T
    })

    await expect(operation(backend)).rejects.toMatchObject({
      name: 'BackendError',
      code: 'invalid_request',
      retryable: false,
    })
    expect(invoked).toBe(false)
  })

  it('leaves product ranges to core after validating integer transport shape', async () => {
    const calls: Record<string, unknown>[] = []
    const backend = new TauriBackend(async <T>(_command, payload = {}) => {
      calls.push(payload)
      return null as T
    })

    await backend.setPlan({ bookId: -1, deadline: '', dailyNewBlocks: 0, dailyCap: -5, remindTime: '' })
    await backend.saveSettings({ obsidianVault: '', pomodoroMinutes: 0, breakMinutes: -1, remindTime: '' })

    expect(calls).toHaveLength(2)
  })

  it.each([
    ['setActiveBook', undefined, (backend: TauriBackend) => backend.setActiveBook(1)],
    ['setPlan', {}, (backend: TauriBackend) => backend.setPlan({
      bookId: 1, deadline: '2026-09-30', dailyNewBlocks: 2, dailyCap: 60, remindTime: '20:00',
    })],
    ['saveSettings', 'ok', (backend: TauriBackend) => backend.saveSettings(settings)],
  ])('requires a null Rust unit response from %s', async (_name, reply, operation) => {
    const backend = new TauriBackend(async <T>() => reply as T)

    await expect(operation(backend)).rejects.toMatchObject({
      name: 'BackendError',
      code: 'invalid_response',
      retryable: false,
    })
  })
})

describe('TauriBackend failures and unsupported capabilities', () => {
  it('preserves safe fields from a known structured invoke rejection', async () => {
    const rejection = {
      code: 'db_unavailable',
      message: '无法读取本地学习数据',
      retryable: true,
    }
    const backend = new TauriBackend(async () => { throw rejection })
    const result = backend.listBooks()

    await expect(result).rejects.toEqual(expect.objectContaining(rejection))
    await expect(result).rejects.toBeInstanceOf(BackendError)
  })

  it('does not expose malformed wire values through BackendError metadata', async () => {
    const secret = '/Users/alice/private/learning.db?token=top-secret'
    const backend = new TauriBackend(async <T>() => [{ ...book, id: secret }] as T)

    const error = await backend.listBooks().catch(reason => reason as BackendError)

    expect(error).toBeInstanceOf(BackendError)
    expect(error.details).toEqual({
      path: 'books[0].id',
      expected: 'safe integer',
      actualType: 'string',
    })
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(secret)
  })

  // H-T6b(F8):非契约拒绝不再坍缩为 unknown,而是 transport_error + 脱敏摘要(类型/长度/键名),
  // 让 Tauri 参数反序列化失败等契约破坏在前端可见、可诊断;隐私断言保持。
  it.each([
    ['native Error', new Error('/Users/alice/private/app.db'), { actualType: 'object', errorName: 'Error', keys: [] }],
    ['plain string', 'token=top-secret', { actualType: 'string', length: 16 }],
    ['unknown object', { path: '/Users/alice/private/app.db', token: 'top-secret' }, { actualType: 'object', keys: ['path', 'token'] }],
    ['unknown structured code', {
      code: 'raw_native_failure', message: '/Users/alice/private/app.db', retryable: true,
      details: { token: 'top-secret' },
    }, { actualType: 'object', keys: ['code', 'message', 'retryable', 'details'] }],
    ['null', null, { actualType: 'null' }],
  ])('classifies an unknown invoke rejection as transport_error with redacted details: %s', async (_name, rejection, expectedDetails) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const backend = new TauriBackend(async () => { throw rejection })

    const error = await backend.listBooks().catch(reason => reason as BackendError)

    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({
      code: 'transport_error',
      message: '与本地后端通信失败',
      retryable: false,
      details: expectedDetails,
    })
    const visible = `${error.message} ${JSON.stringify(error.details)}`
    expect(visible).not.toMatch(/alice|top-secret/)
    expect(consoleError).toHaveBeenCalledWith('[ipc] transport_error', expectedDetails)
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/alice|top-secret/)
    consoleError.mockRestore()
  })

  it('caps redacted key summary at 10 keys', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wide = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]))
    const backend = new TauriBackend(async () => { throw wide })
    const error = await backend.listBooks().catch(reason => reason as BackendError)
    expect((error.details as { keys: string[] }).keys).toHaveLength(10)
    vi.restoreAllMocks()
  })

  it('drops raw details from a known structured native error', async () => {
    const backend = new TauriBackend(async () => {
      throw {
        code: 'db_unavailable',
        message: '无法读取本地学习数据',
        retryable: true,
        details: { path: '/Users/alice/private/app.db', token: 'top-secret' },
      }
    })

    const error = await backend.listBooks().catch(reason => reason as BackendError)

    expect(error).toMatchObject({
      code: 'db_unavailable',
      message: '无法读取本地学习数据',
      retryable: true,
      details: undefined,
    })
  })

  it('keeps only a shared-contract capability in not_implemented details', async () => {
    const backend = new TauriBackend(async () => {
      throw {
        code: 'not_implemented',
        message: '此功能尚未在 Mac 版中实现',
        retryable: false,
        details: { capability: 'stats', path: '/Users/alice/private/app.db' },
      }
    })

    const error = await backend.stats().catch(reason => reason as BackendError)

    expect(error.details).toEqual({ capability: 'stats' })
    expect(JSON.stringify(error.details)).not.toContain('alice')
  })

  it('routes every unsupported method through the shared capability contract without fake progress', async () => {
    const calls: { command: string; payload: Record<string, unknown> }[] = []
    const rejection = { code: 'not_implemented', message: '此功能尚未在 Mac 版中实现', retryable: false }
    const backend = new TauriBackend(async <_T>(command, payload = {}) => {
      calls.push({ command, payload })
      throw rejection
    })
    let progressCalls = 0
    // 按契约 JSON 的 unsupportedCapabilities 驱动:Mac 每接线一条即从 JSON 移除,本用例自动收缩
    const operationByCapability: Record<string, () => Promise<unknown>> = {
      importEpub: () => backend.importEpub(new File([], 'book.epub'), 'textbook'),
      confirmMap: () => backend.confirmMap(1, 1, []),
      completeTask: () => backend.completeTask(1),
      blockSource: () => backend.blockSource(1),
      epubUrl: () => backend.epubUrl(1),
      stats: () => backend.stats(),
      storeSpine: () => backend.storeSpine(1, []),
      runMapJob: () => backend.runMapJob(1, 'job-1', () => { progressCalls += 1 }),
      setAnchorSegments: () => backend.setAnchorSegments(1, []),
      listAnchors: () => backend.listAnchors(1),
      startOrResumeSession: () => backend.startOrResumeSession(1, 'req-1', '2026-09-05'),
      submitTurn: () => backend.submitTurn(1, 0, 'turn-1', 'x'),
      requestEvaluation: () => backend.requestEvaluation(1, 'eval'),
      confirmSessionVerdict: () => backend.confirmSessionVerdict(1, 0, 'verdict', true, '2026-09-05'),
      abandonSession: () => backend.abandonSession(1, 0),
    }

    for (const capability of tauriWireContract.unsupportedCapabilities) {
      const operation = operationByCapability[capability]
      expect(operation, capability).toBeDefined()
      const result = operation()
      await expect(result).rejects.toMatchObject(rejection)
      await expect(result).rejects.toBeInstanceOf(BackendError)
    }

    const expectedCommand = tauriWireContract.commands.find(entry => entry.method === 'unsupported')!
    expect(calls.map(({ command, payload }) => ({
      method: 'unsupported',
      command,
      payloadKeys: Object.keys(payload),
      capability: payload.capability,
    }))).toEqual(tauriWireContract.unsupportedCapabilities.map(capability => ({
      ...expectedCommand,
      capability,
    })))
    expect(progressCalls).toBe(0)
  })

  it('rejects instead of assuming success if unsupported_capability unexpectedly resolves', async () => {
    const backend = new TauriBackend(async <T>() => undefined as T)

    await expect(backend.stats()).rejects.toMatchObject({
      name: 'BackendError',
      code: 'invalid_response',
      retryable: false,
    })
  })
})

// ---- 原生导入与阅读器(Mac M6):分块原始请求体、受管路径 → asset URL、块原文 ----
const NATIVE_METHODS = ['importEpubChunk', 'importEpubFinalize', 'epubUrl', 'blockSource']

describe('TauriBackend native import and reader (Mac M6)', () => {
  type RawCall = { command: string; payload: unknown; headers?: Record<string, string> }
  const recorder = (replies: Record<string, unknown>) => {
    const calls: RawCall[] = []
    const invoke: InvokeFn = async <T>(command: string, payload?: unknown, options?: { headers?: unknown }) => {
      calls.push({ command, payload, headers: options?.headers as Record<string, string> | undefined })
      return replies[command] as T
    }
    return { calls, invoke }
  }

  it('uploads the file as raw chunks with op/index headers, then finalizes with type and title', async () => {
    const { calls, invoke } = recorder({
      library_import_epub_chunk: { stagedBytes: 1 },
      library_import_epub_finalize: { bookId: 7 },
    })
    const backend = new TauriBackend(invoke, { chunkBytes: 4 })
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], 'my-book.epub')

    expect(await backend.importEpub(file, 'textbook')).toEqual({ bookId: 7 })
    const chunks = calls.slice(0, 3)
    expect(chunks.map(c => c.command)).toEqual(Array(3).fill('library_import_epub_chunk'))
    expect(chunks.map(c => (c.payload as Uint8Array).length)).toEqual([4, 4, 2])
    expect(chunks.every(c => c.payload instanceof Uint8Array)).toBe(true)
    expect(Array.from(chunks[2].payload as Uint8Array)).toEqual([9, 10])
    const opIds = new Set(chunks.map(c => c.headers?.['x-op-id']))
    expect(opIds.size).toBe(1)
    expect(chunks.map(c => c.headers?.['x-chunk-index'])).toEqual(['0', '1', '2'])
    expect(calls[3]).toMatchObject({
      command: 'library_import_epub_finalize',
      payload: { opId: [...opIds][0], bookType: 'textbook', title: 'my-book' },
    })
    expect(calls).toHaveLength(4)
  })

  it('rejects an empty file before any upload and validates the book type', async () => {
    const { calls, invoke } = recorder({})
    const backend = new TauriBackend(invoke)
    await expect(backend.importEpub(new File([], 'empty.epub'), 'textbook')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(backend.importEpub(new File([new Uint8Array([1])], 'x.epub'), 'novel' as never)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(calls).toHaveLength(0)
  })

  it('turns the managed epub path into an asset url and decodes block source', async () => {
    const { calls, invoke } = recorder({
      library_epub_url: '/data/book-learner/books/1.epub',
      map_block_source: { href: 'ch0.xhtml', text: '原文' },
    })
    const backend = new TauriBackend(invoke, { convertFileSrc: path => `asset://localhost${path}` })
    expect(await backend.epubUrl(1)).toBe('asset://localhost/data/book-learner/books/1.epub')
    expect(await backend.blockSource(2)).toEqual({ href: 'ch0.xhtml', text: '原文' })
    expect(calls.map(c => [c.command, c.payload])).toEqual([
      ['library_epub_url', { bookId: 1 }],
      ['map_block_source', { blockId: 2 }],
    ])
    const bad = new TauriBackend(async <T>() => ({ href: 1 }) as T, { convertFileSrc: p => p })
    await expect(bad.blockSource(2)).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

// ---- 契约 v2 传输(Plan B B2):按 unsupportedCapabilities 门控;解码器用假 invoke 验证 ----
const V2_METHODS = [
  'storeSpine', 'runMapJob', 'confirmMap', 'setAnchorSegments', 'listAnchors', 'startOrResumeSession',
  'submitTurn', 'requestEvaluation', 'confirmSessionVerdict', 'abandonSession',
]
const enabledContract = {
  ...tauriWireContract,
  unsupportedCapabilities: tauriWireContract.unsupportedCapabilities.filter(c => !V2_METHODS.includes(c)),
}
const evalResult = {
  verdict: 'pass_suggested',
  scores: { accuracy: 4, completeness: 4, clarity: 5 },
  summary: '讲解到位',
  weakPoints: [{ title: '弹性vs斜率', detail: '未完全修复', fixedInSession: false }],
  finalRestatement: '弹性是相对变化率',
  observationNote: '举例能力强',
}
const sessionView = {
  sessionId: 7, taskId: 3, version: 2, state: 'open', blockId: 4, kind: 'learn',
  transcript: [
    { role: 'user', text: '弹性是相对变化率', status: 'done', clientTurnId: 't1', readyToEnd: false },
    { role: 'student', text: '讲清楚了', status: 'done', clientTurnId: null, readyToEnd: true },
  ],
  eval: null,
}
const segment = {
  spineHref: 'chap1.xhtml', cfiStart: 'epubcfi(/6/2!/4/2/1:0)', cfiEnd: 'epubcfi(/6/2!/4/6/1:0)',
  precision: 'exact', hint: '需求定律', text: '需求定律说的是……',
}
const chapters = [{ idx: 0, href: 'chap1.xhtml', title: '第一章', text: '正文' }]

describe('TauriBackend v2 transport (contract-gated)', () => {
  it('uses the v2 wire commands and decodes complete fixtures', async () => {
    const calls: { command: string; payload: Record<string, unknown> }[] = []
    const replies: Record<string, unknown> = {
      map_store_spine: null,
      map_run_job: [block],
      map_confirm: { revision: 2 },
      map_set_anchor_segments: null,
      map_list_anchors: [segment],
      session_start_or_resume: sessionView,
      session_submit_turn: { studentText: '为什么?', readyToEnd: false, version: 3 },
      session_request_evaluation: { eval: evalResult, version: 4 },
      session_confirm_verdict: { passed: true, blockStatus: 'passed', taskDone: true, outboxOps: 4, version: 5 },
      session_abandon: null,
    }
    const invoke: InvokeFn = async <T>(command: string, payload = {}) => {
      calls.push({ command, payload })
      return replies[command] as T
    }
    const backend = new TauriBackend(invoke, { contract: enabledContract })

    await backend.storeSpine(1, chapters)
    expect(await backend.runMapJob(1, 'job-1')).toEqual([block])
    expect(await backend.confirmMap(1, 1, [{ op: 'setSkipped', blockId: 2, skipped: true }, { op: 'reorder', blockIds: [2] }])).toEqual({ revision: 2 })
    await backend.setAnchorSegments(2, [segment])
    expect(await backend.listAnchors(2)).toEqual([segment])
    expect(await backend.startOrResumeSession(3, 'req-1', '2026-09-05')).toEqual(sessionView)
    expect(await backend.submitTurn(7, 2, 'turn-1', '弹性')).toEqual({ studentText: '为什么?', readyToEnd: false, version: 3 })
    expect(await backend.requestEvaluation(7, 'eval')).toEqual({ eval: evalResult, version: 4 })
    expect(await backend.confirmSessionVerdict(7, 4, 'verdict', true, '2026-09-05'))
      .toEqual({ passed: true, blockStatus: 'passed', taskDone: true, outboxOps: 4, version: 5 })
    await backend.abandonSession(7, 5)

    const expected = tauriWireContract.commands.filter(entry => V2_METHODS.includes(entry.method))
    expect(calls.map(({ command, payload }, index) => ({
      method: expected[index].method,
      command,
      payloadKeys: Object.keys(payload),
    }))).toEqual(expected)
    expect(calls[2].payload).toEqual({ bookId: 1, expectedRevision: 1, ops: [{ op: 'setSkipped', blockId: 2, skipped: true }, { op: 'reorder', blockIds: [2] }] })
    expect(calls[5].payload).toEqual({ taskId: 3, clientRequestId: 'req-1', date: '2026-09-05' })
    expect(calls[8].payload).toEqual({ sessionId: 7, expectedVersion: 4, requestId: 'verdict', pass: true, date: '2026-09-05' })
  })

  it('decodes an evaluated session view with its eval', async () => {
    const backend = new TauriBackend(async <T>() => ({ ...sessionView, state: 'evaluated', eval: evalResult }) as T, { contract: enabledContract })
    expect(await backend.startOrResumeSession(3, 'req-1', '2026-09-05')).toEqual({ ...sessionView, state: 'evaluated', eval: evalResult })
  })

  it.each([
    ['sessionId', (backend: TauriBackend) => backend.submitTurn(1.5, 0, 'turn-1', 'x')],
    ['expectedVersion', (backend: TauriBackend) => backend.submitTurn(1, Number.NaN, 'turn-1', 'x')],
    ['empty clientTurnId', (backend: TauriBackend) => backend.submitTurn(1, 0, '', 'x')],
    ['clientTurnId with colon', (backend: TauriBackend) => backend.submitTurn(1, 0, 'a:b', 'x')],
    ['jobId with space', (backend: TauriBackend) => backend.runMapJob(1, 'job 1')],
    ['chapters not an array', (backend: TauriBackend) => backend.storeSpine(1, {} as never)],
    ['chapter idx not integer', (backend: TauriBackend) => backend.storeSpine(1, [{ ...chapters[0], idx: 0.5 }])],
    ['segment precision unknown', (backend: TauriBackend) => backend.setAnchorSegments(1, [{ ...segment, precision: 'fuzzy' as never }])],
    ['pass not boolean', (backend: TauriBackend) => backend.confirmSessionVerdict(1, 0, 'verdict', 'yes' as never, '2026-09-05')],
    ['date not string', (backend: TauriBackend) => backend.startOrResumeSession(1, 'req', 20260905 as never)],
    ['unknown map op', (backend: TauriBackend) => backend.confirmMap(1, 1, [{ op: 'explode', blockId: 1 } as never])],
    ['reorder ids not integers', (backend: TauriBackend) => backend.confirmMap(1, 1, [{ op: 'reorder', blockIds: [1.5] }])],
    ['expectedRevision not integer', (backend: TauriBackend) => backend.confirmMap(1, 1.5, [])],
  ])('rejects unsafe outbound v2 values before invoking: %s', async (_name, operation) => {
    let invoked = false
    const backend = new TauriBackend(async <T>() => {
      invoked = true
      return null as T
    }, { contract: enabledContract })

    await expect(operation(backend)).rejects.toMatchObject({ name: 'BackendError', code: 'invalid_request', retryable: false })
    expect(invoked).toBe(false)
  })

  it.each([
    ['session state is exact', { ...sessionView, state: 'paused' }, (backend: TauriBackend) => backend.startOrResumeSession(3, 'r', '2026-09-05'), 'session.state'],
    ['turn role is exact', { ...sessionView, transcript: [{ ...sessionView.transcript[0], role: 'assistant' }] }, (backend: TauriBackend) => backend.startOrResumeSession(3, 'r', '2026-09-05'), 'session.transcript[0].role'],
    ['version is a safe integer', { ...sessionView, version: 1.5 }, (backend: TauriBackend) => backend.startOrResumeSession(3, 'r', '2026-09-05'), 'session.version'],
    ['eval is null or object', { ...sessionView, eval: 'ok' }, (backend: TauriBackend) => backend.startOrResumeSession(3, 'r', '2026-09-05'), 'session.eval'],
    ['clientTurnId is null or string', { ...sessionView, transcript: [{ ...sessionView.transcript[0], clientTurnId: 5 }] }, (backend: TauriBackend) => backend.startOrResumeSession(3, 'r', '2026-09-05'), 'session.transcript[0].clientTurnId'],
    ['turn result readyToEnd is boolean', { studentText: 'x', readyToEnd: 'no', version: 1 }, (backend: TauriBackend) => backend.submitTurn(1, 0, 't', 'x'), 'turn.readyToEnd'],
    ['evaluation verdict is exact', { eval: { ...evalResult, verdict: 'maybe' }, version: 1 }, (backend: TauriBackend) => backend.requestEvaluation(1, 'eval'), 'evaluation.eval.verdict'],
    ['weak point fixedInSession is boolean', { eval: { ...evalResult, weakPoints: [{ title: 'a', detail: 'b', fixedInSession: 1 }] }, version: 1 }, (backend: TauriBackend) => backend.requestEvaluation(1, 'eval'), 'evaluation.eval.weakPoints[0].fixedInSession'],
    ['verdict blockStatus is exact', { passed: true, blockStatus: 'done', taskDone: true, outboxOps: 4, version: 5 }, (backend: TauriBackend) => backend.confirmSessionVerdict(1, 4, 'verdict', true, '2026-09-05'), 'verdict.blockStatus'],
    ['anchor precision is exact', [{ ...segment, precision: 'rough' }], (backend: TauriBackend) => backend.listAnchors(1), 'anchors[0].precision'],
    ['abandon requires unit', 'ok', (backend: TauriBackend) => backend.abandonSession(1, 0), 'session_abandon'],
    ['confirmMap revision is a safe integer', { revision: 'two' }, (backend: TauriBackend) => backend.confirmMap(1, 1, []), 'map_confirm.revision'],
  ])('rejects malformed v2 wire data: %s', async (_name, reply, operation, path) => {
    const backend = new TauriBackend(async <T>() => reply as T, { contract: enabledContract })
    const error = await operation(backend).catch(reason => reason as BackendError)

    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: 'invalid_response', retryable: false })
    expect((error.details as { path: string }).path).toBe(path)
  })

  it('routes v2 methods to real commands under the shipped contract, and gates them only when listed', async () => {
    const calls: string[] = []
    const rejection = { code: 'not_implemented', message: '此功能尚未在 Mac 版中实现', retryable: false }
    const invoke = async <_T>(command: string) => {
      calls.push(command)
      throw rejection
    }
    // 出厂契约:Mac M4/M5 已接线,submitTurn 直达 session_submit_turn
    await expect(new TauriBackend(invoke).submitTurn(1, 0, 'turn-1', 'x')).rejects.toMatchObject(rejection)
    expect(calls).toEqual(['session_submit_turn'])

    // 仍在 unsupportedCapabilities 里的方法才走 unsupported_capability 门控
    calls.length = 0
    const gatedContract = {
      ...tauriWireContract,
      unsupportedCapabilities: [...tauriWireContract.unsupportedCapabilities, 'submitTurn'],
    }
    await expect(new TauriBackend(invoke, { contract: gatedContract }).submitTurn(1, 0, 'turn-1', 'x')).rejects.toMatchObject(rejection)
    expect(calls).toEqual(['unsupported_capability'])
  })

  it('subscribes runMapJob progress by jobId and unlistens after invoke, even on failure', async () => {
    type Handler = (event: { payload: unknown }) => void
    const handlers: Handler[] = []
    let unlistened = 0
    const listen = async (_event: string, handler: Handler) => {
      handlers.push(handler)
      return () => { unlistened += 1 }
    }
    const progress: unknown[] = []
    let resolveInvoke!: (v: unknown) => void
    const backend = new TauriBackend(
      async <T>() => new Promise<T>(res => { resolveInvoke = res as (v: unknown) => void }),
      { contract: enabledContract, listen },
    )

    const pending = backend.runMapJob(1, 'job-1', p => progress.push(p))
    await Promise.resolve()
    expect(handlers).toHaveLength(1)
    handlers[0]({ payload: { jobId: 'job-1', progress: { stage: 'chapter', index: 0, total: 3, title: '一' } } })
    handlers[0]({ payload: { jobId: 'other', progress: { stage: 'merging' } } })
    handlers[0]({ payload: { jobId: 'job-1', progress: { stage: 'bogus' } } })
    handlers[0]({ payload: { jobId: 'job-1', progress: { stage: 'done', blocks: 3 } } })
    resolveInvoke([block])
    expect(await pending).toEqual([block])
    expect(progress).toEqual([
      { stage: 'chapter', index: 0, total: 3, title: '一' },
      { stage: 'done', blocks: 3 },
    ])
    expect(unlistened).toBe(1)

    const failing = new TauriBackend(async () => { throw { code: 'conflict', message: '冲突', retryable: false } }, { contract: enabledContract, listen })
    await expect(failing.runMapJob(1, 'job-2', () => {})).rejects.toMatchObject({ code: 'conflict' })
    expect(unlistened).toBe(2)
  })

  it('does not subscribe to progress events without an onProgress callback', async () => {
    let subscribed = 0
    const listen = async () => { subscribed += 1; return () => {} }
    const backend = new TauriBackend(async <T>() => [block] as T, { contract: enabledContract, listen })
    await backend.runMapJob(1, 'job-1')
    expect(subscribed).toBe(0)
  })
})
