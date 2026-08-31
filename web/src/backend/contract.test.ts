import { describe, expect, it } from 'vitest'
import { APP_DEFAULTS } from '../config'
import { MockBackend } from './mock'

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
})
