import { describe, expect, it } from 'vitest'
import { APP_DEFAULTS } from '../config'
import { MockBackend } from './mock'
import tauriWireContract from '../../../shared/tauri-wire-contract.json'

describe('MockBackend 契约行为', () => {
  it('种子含至少一本主攻书', async () => {
    const b = new MockBackend()
    const books = await b.listBooks()
    expect(books.length).toBeGreaterThan(0)
    expect(books.some(x => x.status === 'active')).toBe(true)
  })
  it('今日队列按 weak_retest→review→new 排序', async () => {
    const b = new MockBackend()
    const q = await b.todayQueue('2026-08-30')
    const kinds = q.map(t => t.kind)
    expect(kinds).toEqual([...kinds].sort((a, z) =>
      ['weak_retest', 'review', 'new'].indexOf(a) - ['weak_retest', 'review', 'new'].indexOf(z)))
    expect(new Set(kinds)).toEqual(new Set(['weak_retest', 'review', 'new']))
  })
  it('学生剧本依次消费且末条 readyToEnd', async () => {
    const b = new MockBackend()
    const { sessionId } = await b.startSession(1, 'new')
    const replies = []
    for (let i = 0; i < 4; i++) replies.push(await b.studentReply(sessionId, []))
    expect(replies.at(-1)!.readyToEnd).toBe(true)
    expect(new Set(replies.map(r => r.text)).size).toBe(4)
  })
  it('评估结果分数在 1-5 且确认通过改变块状态', async () => {
    const b = new MockBackend()
    const { sessionId } = await b.startSession(4, 'new')
    const ev = await b.endSession(sessionId)
    for (const s of Object.values(ev.scores)) { expect(s).toBeGreaterThanOrEqual(1); expect(s).toBeLessThanOrEqual(5) }
    await b.confirmVerdict(sessionId, true)
    expect((await b.getBlock(4)).status).toBe('passed')
  })
  it('设置默认值来自共享配置', async () => {
    const b = new MockBackend()

    expect(await b.getSettings()).toEqual(APP_DEFAULTS)
  })
  it('共享默认值不可变且 Mock 使用独立副本', async () => {
    expect(Object.isFrozen(APP_DEFAULTS)).toBe(true)
    expect(Reflect.set(APP_DEFAULTS, 'pomodoroMinutes', 99)).toBe(false)

    expect((await new MockBackend().getSettings()).pomodoroMinutes).toBe(25)
  })
})

describe('Tauri wire contract fixture', () => {
  it('固定命令名、顶层 payload key 与 unsupported capability', () => {
    expect(Object.keys(tauriWireContract)).toEqual(['commands', 'unsupportedCapabilities'])
    expect(tauriWireContract.commands).toEqual([
      { method: 'listBooks', command: 'library_list_books', payloadKeys: [] },
      { method: 'setActiveBook', command: 'library_set_active_book', payloadKeys: ['bookId'] },
      { method: 'listBlocks', command: 'map_list_blocks', payloadKeys: ['bookId'] },
      { method: 'getBlock', command: 'map_get_block', payloadKeys: ['blockId'] },
      { method: 'setPlan', command: 'planning_set_plan', payloadKeys: ['request'] },
      { method: 'todayQueue', command: 'planning_today_queue', payloadKeys: ['date'] },
      { method: 'getSettings', command: 'settings_get', payloadKeys: [] },
      { method: 'saveSettings', command: 'settings_save', payloadKeys: ['settings'] },
      { method: 'unsupported', command: 'unsupported_capability', payloadKeys: ['capability'] },
    ])
    expect(tauriWireContract.unsupportedCapabilities).toEqual([
      'importEpub', 'generateMap', 'confirmMap', 'completeTask', 'blockSource', 'epubUrl',
      'startSession', 'studentReply', 'endSession', 'confirmVerdict', 'stats',
    ])
  })
})
