import { describe, expect, it } from 'vitest'
import { APP_DEFAULTS } from '../config'
import type { MapProgress } from '../types'
import { MockBackend } from './mock'
import tauriWireContract from '../../../shared/tauri-wire-contract.json'

const D = '2026-09-05'

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
      // 契约 v2(Plan B):命名与 core 用例一致;Mac 接线后从 unsupportedCapabilities 移除即生效
      { method: 'storeSpine', command: 'map_store_spine', payloadKeys: ['bookId', 'chapters'] },
      { method: 'runMapJob', command: 'map_run_job', payloadKeys: ['bookId', 'jobId'] },
      { method: 'confirmMap', command: 'map_confirm', payloadKeys: ['bookId', 'expectedRevision', 'ops'] },
      { method: 'setAnchorSegments', command: 'map_set_anchor_segments', payloadKeys: ['blockId', 'segments'] },
      { method: 'listAnchors', command: 'map_list_anchors', payloadKeys: ['blockId'] },
      { method: 'startOrResumeSession', command: 'session_start_or_resume', payloadKeys: ['taskId', 'clientRequestId', 'date'] },
      { method: 'submitTurn', command: 'session_submit_turn', payloadKeys: ['sessionId', 'expectedVersion', 'clientTurnId', 'text'] },
      { method: 'requestEvaluation', command: 'session_request_evaluation', payloadKeys: ['sessionId', 'requestId'] },
      { method: 'confirmSessionVerdict', command: 'session_confirm_verdict', payloadKeys: ['sessionId', 'expectedVersion', 'requestId', 'pass', 'date'] },
      { method: 'abandonSession', command: 'session_abandon', payloadKeys: ['sessionId', 'expectedVersion'] },
    ])
    expect(tauriWireContract.unsupportedCapabilities).toEqual([
      'importEpub', 'generateMap', 'confirmMap', 'completeTask', 'blockSource', 'epubUrl',
      'startSession', 'studentReply', 'endSession', 'confirmVerdict', 'stats',
      'storeSpine', 'runMapJob', 'setAnchorSegments', 'listAnchors',
      'startOrResumeSession', 'submitTurn', 'requestEvaluation', 'confirmSessionVerdict', 'abandonSession',
    ])
  })
})

describe('MockBackend 与原生一致的切换约束(H-T9b / F4)', () => {
  it('切换到无学习计划的书籍返回 conflict;设定计划后可切换', async () => {
    const b = new MockBackend()
    const { bookId } = await b.importEpub(new File(['x'], 'x.epub'), 'textbook')
    await expect(b.setActiveBook(bookId)).rejects.toMatchObject({ code: 'conflict', retryable: false })
    expect((await b.listBooks()).find(x => x.id === 1)?.status).toBe('active')
    await b.setPlan({ bookId, deadline: '2026-12-31', dailyNewBlocks: 1, dailyCap: 4, remindTime: '21:00' })
    await b.setActiveBook(bookId)
    expect((await b.listBooks()).find(x => x.id === bookId)?.status).toBe('active')
  })
})

describe('MockBackend 会话契约 v2(幂等 id / 版本 / 一任务一会话)', () => {
  it('同任务多次开始返回同一会话;clientRequestId 重放', async () => {
    const b = new MockBackend()
    const a = await b.startOrResumeSession(3, 'a', D)
    const a2 = await b.startOrResumeSession(3, 'b', D)
    const a3 = await b.startOrResumeSession(3, 'a', D)
    expect(a2.sessionId).toBe(a.sessionId)
    expect(a3.sessionId).toBe(a.sessionId)
    expect(a).toMatchObject({ taskId: 3, blockId: 4, version: 0, state: 'open', kind: 'learn', transcript: [], eval: null })
  })

  it('任务与 id 校验:不存在 not_found、已完成 conflict、坏 id/日期 invalid_request', async () => {
    const b = new MockBackend()
    await expect(b.startOrResumeSession(999, 'a', D)).rejects.toMatchObject({ code: 'not_found' })
    await b.completeTask(2)
    await expect(b.startOrResumeSession(2, 'a', D)).rejects.toMatchObject({ code: 'conflict' })
    await expect(b.startOrResumeSession(3, 'bad id', D)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(b.startOrResumeSession(3, 'a:b', D)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(b.startOrResumeSession(3, 'a'.repeat(65), D)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(b.startOrResumeSession(3, 'ok', 'not-a-date')).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('回合:同 clientTurnId 重放、版本冲突、剧本推进、重放会话含 transcript', async () => {
    const b = new MockBackend()
    const s = await b.startOrResumeSession(3, 'a', D)
    const r1 = await b.submitTurn(s.sessionId, 0, 't1', 'x')
    expect(r1.version).toBe(1)
    expect(r1.readyToEnd).toBe(false)
    expect(r1.studentText).toContain('总收入')
    expect(await b.submitTurn(s.sessionId, 7, 't1', 'x')).toEqual(r1)
    await expect(b.submitTurn(s.sessionId, 0, 't2', 'y')).rejects.toMatchObject({ code: 'conflict' })
    const r2 = await b.submitTurn(s.sessionId, 1, 't2', 'y')
    expect(r2.version).toBe(2)
    expect(r2.studentText).not.toBe(r1.studentText)
    await expect(b.submitTurn(s.sessionId, 2, 't3', '   ')).rejects.toMatchObject({ code: 'invalid_request' })
    await b.submitTurn(s.sessionId, 2, 't3', 'z')
    const r4 = await b.submitTurn(s.sessionId, 3, 't4', 'w')
    expect(r4.readyToEnd).toBe(true)
    const view = await b.startOrResumeSession(3, 'resume', D)
    expect(view.sessionId).toBe(s.sessionId)
    expect(view.version).toBe(4)
    expect(view.transcript.map(t => t.role)).toEqual(['user', 'student', 'user', 'student', 'user', 'student', 'user', 'student'])
    expect(view.transcript[0]).toMatchObject({ text: 'x', status: 'done', clientTurnId: 't1', readyToEnd: false })
    expect(view.transcript[7]).toMatchObject({ role: 'student', readyToEnd: true, clientTurnId: null })
    expect(await b.submitTurn(s.sessionId, 4, 't1', 'x')).toEqual(r1)
  })

  it('评估幂等、判定原子且同 requestId 重放', async () => {
    const b = new MockBackend()
    const s = await b.startOrResumeSession(3, 'a', D)
    await expect(b.requestEvaluation(s.sessionId, 'eval')).rejects.toMatchObject({ code: 'conflict' })
    await b.submitTurn(s.sessionId, 0, 't1', 'x')
    const e = await b.requestEvaluation(s.sessionId, 'eval')
    expect(e.version).toBe(2)
    expect(e.eval.verdict).toBe('pass_suggested')
    expect(await b.requestEvaluation(s.sessionId, 'eval')).toEqual(e)
    await expect(b.requestEvaluation(s.sessionId, 'e2')).rejects.toMatchObject({ code: 'conflict' })
    expect(await b.startOrResumeSession(3, 'r', D)).toMatchObject({ state: 'evaluated', version: 2, eval: e.eval })
    await expect(b.confirmSessionVerdict(s.sessionId, 1, 'verdict', true, D)).rejects.toMatchObject({ code: 'conflict' })
    const out = await b.confirmSessionVerdict(s.sessionId, 2, 'verdict', true, D)
    expect(out).toEqual({ passed: true, blockStatus: 'passed', taskDone: true, outboxOps: 4, version: 3 })
    const block = await b.getBlock(4)
    expect(block.status).toBe('passed')
    expect(block.passedAt).toBe(D)
    expect(block.scores).toEqual(e.eval.scores)
    expect((await b.todayQueue(D)).find(t => t.id === 3)?.status).toBe('done')
    expect(await b.confirmSessionVerdict(s.sessionId, 999, 'verdict', false, D)).toEqual(out)
    await expect(b.confirmSessionVerdict(s.sessionId, 3, 'c2', true, D)).rejects.toMatchObject({ code: 'conflict' })
    expect(await b.startOrResumeSession(3, 'a', D)).toMatchObject({ state: 'confirmed', version: 3 })
  })

  it('用户判定重学:块 learning、任务仍 pending', async () => {
    const b = new MockBackend()
    const s = await b.startOrResumeSession(3, 'a', D)
    await b.submitTurn(s.sessionId, 0, 't1', 'x')
    const e = await b.requestEvaluation(s.sessionId, 'eval')
    const out = await b.confirmSessionVerdict(s.sessionId, e.version, 'verdict', false, D)
    expect(out).toMatchObject({ passed: false, blockStatus: 'learning', taskDone: false, outboxOps: 4 })
    expect((await b.getBlock(4)).status).toBe('learning')
    expect((await b.todayQueue(D)).find(t => t.id === 3)?.status).toBe('pending')
  })

  it('薄弱点重考/复习任务:块状态不变、outboxOps 3、任务 done', async () => {
    const b = new MockBackend()
    for (const [taskId, blockId, kind] of [[1, 3, 'retest'], [2, 1, 'review']] as const) {
      const s = await b.startOrResumeSession(taskId, `s${taskId}`, D)
      expect(s.kind).toBe(kind)
      const before = (await b.getBlock(blockId)).status
      await b.submitTurn(s.sessionId, 0, 't1', 'x')
      const e = await b.requestEvaluation(s.sessionId, 'eval')
      const out = await b.confirmSessionVerdict(s.sessionId, e.version, 'verdict', true, D)
      expect(out).toMatchObject({ blockStatus: before, taskDone: true, outboxOps: 3 })
      expect((await b.getBlock(blockId)).status).toBe(before)
      expect((await b.todayQueue(D)).find(t => t.id === taskId)?.status).toBe('done')
    }
  })

  it('放弃:版本校验、之后回合冲突、同任务可重开新会话', async () => {
    const b = new MockBackend()
    const s = await b.startOrResumeSession(3, 'a', D)
    await expect(b.abandonSession(s.sessionId, 5)).rejects.toMatchObject({ code: 'conflict' })
    await b.abandonSession(s.sessionId, 0)
    await expect(b.submitTurn(s.sessionId, 1, 't1', 'x')).rejects.toMatchObject({ code: 'conflict' })
    await expect(b.abandonSession(s.sessionId, 1)).rejects.toMatchObject({ code: 'conflict' })
    const again = await b.startOrResumeSession(3, 'z', D)
    expect(again.sessionId).not.toBe(s.sessionId)
    expect(again.state).toBe('open')
    expect(await b.startOrResumeSession(3, 'a', D)).toMatchObject({ sessionId: s.sessionId, state: 'abandoned', version: 1 })
  })
})

describe('MockBackend 地图契约 v2(修订号 / 作业 / 锚点)', () => {
  it('种子书修订号 1、块 skipped=false;已有地图的作业直接返回且不发进度', async () => {
    const b = new MockBackend()
    expect((await b.listBooks())[0].mapRevision).toBe(1)
    expect((await b.listBlocks(1)).every(k => k.skipped === false)).toBe(true)
    const events: MapProgress[] = []
    const blocks = await b.runMapJob(1, 'job-1', p => events.push(p))
    expect(blocks).toHaveLength(12)
    expect(events).toEqual([])
    expect((await b.listBooks())[0].mapRevision).toBe(1)
  })

  it('新书:storeSpine → runMapJob 进度、块与锚点、同 jobId 幂等、jobId 冲突', async () => {
    const b = new MockBackend()
    const { bookId } = await b.importEpub(new File(['x'], '深度工作.epub'), 'textbook')
    expect((await b.listBooks()).find(x => x.id === bookId)?.mapRevision).toBe(0)
    const chapters = [0, 1, 2].map(i => ({ idx: i, href: `ch${i}.xhtml`, title: `第${i}章`, text: `第${i}章正文` }))
    await b.storeSpine(bookId, chapters)
    const events: MapProgress[] = []
    const blocks = await b.runMapJob(bookId, 'job-2', p => events.push(p))
    expect(events).toEqual([
      { stage: 'chapter', index: 0, total: 3, title: '第0章' },
      { stage: 'chapter', index: 1, total: 3, title: '第1章' },
      { stage: 'chapter', index: 2, total: 3, title: '第2章' },
      { stage: 'merging' },
      { stage: 'done', blocks: 3 },
    ])
    expect(blocks.map(k => k.title)).toEqual(['第0章', '第1章', '第2章'])
    expect(blocks.map(k => k.seq)).toEqual([1, 2, 3])
    expect(blocks.every(k => k.bookId === bookId && !k.skipped && k.status === 'unlearned')).toBe(true)
    expect(await b.listAnchors(blocks[1].id)).toEqual([
      { spineHref: 'ch1.xhtml', cfiStart: '', cfiEnd: '', precision: 'chapter_fallback', hint: '第1章', text: '第1章正文' },
    ])
    expect((await b.listBooks()).find(x => x.id === bookId)?.mapRevision).toBe(1)
    const events2: MapProgress[] = []
    const again = await b.runMapJob(bookId, 'job-2', p => events2.push(p))
    expect(again.map(k => k.id)).toEqual(blocks.map(k => k.id))
    expect(events2).toEqual([])
    await expect(b.runMapJob(1, 'job-2')).rejects.toMatchObject({ code: 'conflict' })
    await expect(b.runMapJob(999, 'job-3')).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.storeSpine(999, chapters)).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.runMapJob(bookId, 'bad id')).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('setAnchorSegments 覆盖锚点并让 blockSource 取段文本', async () => {
    const b = new MockBackend()
    const seg = {
      spineHref: 'chap2.xhtml', cfiStart: 'epubcfi(/6/4!/4/2/1:0)', cfiEnd: 'epubcfi(/6/4!/4/6/1:0)',
      precision: 'exact' as const, hint: '效用', text: '效用是满足感的度量。',
    }
    await b.setAnchorSegments(5, [seg])
    expect(await b.listAnchors(5)).toEqual([seg])
    expect(await b.blockSource(5)).toEqual({ href: 'chap2.xhtml', text: '效用是满足感的度量。' })
    await expect(b.setAnchorSegments(999, [seg])).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.setAnchorSegments(5, [{ ...seg, precision: 'fuzzy' as never }])).rejects.toMatchObject({ code: 'invalid_request' })
    expect(await b.listAnchors(6)).toEqual([])
  })
})
