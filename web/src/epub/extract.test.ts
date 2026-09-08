import { describe, expect, it, vi } from 'vitest'
import type { Book } from 'epubjs'
import { EXTRACT_YIELD_EVERY, extractSpine, yieldToMain } from './extract'

/** 假 Book:spine.each 依次给出 n 个 section,每个 document 有一个标题与一段正文 */
function fakeBook(n: number) {
  const sections = Array.from({ length: n }, (_, i) => {
    const doc = new DOMParser().parseFromString(`<html><body><h1>第${i + 1}章</h1><p>正文 ${i + 1}</p></body></html>`, 'text/html')
    return { href: `ch${i}.xhtml`, document: doc, load: vi.fn(async () => doc), unload: vi.fn(), cfiFromRange: () => '' }
  })
  return {
    loaded: { navigation: Promise.resolve({ toc: [] }) },
    spine: { each: (cb: (s: unknown) => void) => sections.forEach(cb) },
    load: () => undefined,
  } as unknown as Book
}

describe('章节抽取(M3 T6.1):进度与主线程让出', () => {
  it('逐章汇报进度,每 EXTRACT_YIELD_EVERY 章让出一次主线程', async () => {
    const n = EXTRACT_YIELD_EVERY * 2 + 1
    const timeouts = vi.spyOn(globalThis, 'setTimeout')
    const progress: number[] = []
    const chapters = await extractSpine(fakeBook(n), p => {
      expect(p.total).toBe(n)
      progress.push(p.done)
    })
    expect(chapters.map(c => c.title)).toEqual(Array.from({ length: n }, (_, i) => `第${i + 1}章`))
    expect(chapters[0].text).toContain('正文 1')
    expect(progress).toEqual(Array.from({ length: n }, (_, i) => i + 1))
    // 两次让出(第 6、12 章);jsdom 无 scheduler.yield → setTimeout(0)
    expect(timeouts.mock.calls.filter(c => c[1] === 0)).toHaveLength(2)
    timeouts.mockRestore()
  })

  it('yieldToMain 优先用 scheduler.yield', async () => {
    const yielded = vi.fn(async () => {})
    vi.stubGlobal('scheduler', { yield: yielded })
    await yieldToMain()
    expect(yielded).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
