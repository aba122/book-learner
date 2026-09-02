import { describe, expect, it } from 'vitest'
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

    const expected = tauriWireContract.commands.filter(entry => entry.method !== 'unsupported')
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

  it.each([
    ['native Error', new Error('/Users/alice/private/app.db')],
    ['plain string', 'token=top-secret'],
    ['unknown object', { path: '/Users/alice/private/app.db', token: 'top-secret' }],
    ['unknown structured code', {
      code: 'raw_native_failure', message: '/Users/alice/private/app.db', retryable: true,
      details: { token: 'top-secret' },
    }],
  ])('uses a fixed safe error for an unknown invoke rejection: %s', async (_name, rejection) => {
    const backend = new TauriBackend(async () => { throw rejection })

    const error = await backend.listBooks().catch(reason => reason as BackendError)

    expect(error).toMatchObject({
      code: 'unknown',
      message: '原生后端调用失败',
      retryable: false,
      details: undefined,
    })
    const visible = `${error.message} ${JSON.stringify(error.details)}`
    expect(visible).not.toMatch(/alice|top-secret/)
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
    const operations = [
      () => backend.importEpub(new File([], 'book.epub'), 'textbook'),
      () => backend.generateMap(1, () => { progressCalls += 1 }),
      () => backend.confirmMap(1, []),
      () => backend.completeTask(1),
      () => backend.blockSource(1),
      () => backend.epubUrl(1),
      () => backend.startSession(1, 'new'),
      () => backend.studentReply(1, []),
      () => backend.endSession(1),
      () => backend.confirmVerdict(1, true),
      () => backend.stats(),
    ]

    for (const operation of operations) {
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
