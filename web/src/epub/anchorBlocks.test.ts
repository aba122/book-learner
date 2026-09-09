import { describe, expect, it, vi } from 'vitest'
import type { Book } from 'epubjs'
import type { AnchorSegment } from '../types'
import * as anchorsModule from './anchors'
import { anchorBlocks } from './anchorBlocks'

vi.mock('./anchors', () => ({ resolveBlockAnchors: vi.fn() }))

const fallback = (href: string, hint: string): AnchorSegment => ({ spineHref: href, cfiStart: 'epubcfi(/6/2!/4/2/1:0)', cfiEnd: 'epubcfi(/6/2!/4/8/1:0)', precision: 'chapter_fallback', hint, text: '' })
const exact = (href: string, hint: string): AnchorSegment => ({ spineHref: href, cfiStart: 'epubcfi(/6/2!/4/4/1:0)', cfiEnd: 'epubcfi(/6/2!/4/6/1:0)', precision: 'exact', hint, text: '段落' })

describe('锚点回填 anchorBlocks(BL-001)', () => {
  it('整章回退的块按 hint 解析并写回;已精确的块跳过;单块失败不影响其它块', async () => {
    const store = new Map<number, AnchorSegment[]>([
      [1, [fallback('ch1.xhtml', '一 节')]],
      [2, [exact('ch2.xhtml', '二 节')]],
      [3, [fallback('ch3.xhtml', '三 节')]],
      [4, []],
    ])
    const backend = {
      listAnchors: vi.fn(async (id: number) => (store.get(id) ?? []).map(s => ({ ...s }))),
      setAnchorSegments: vi.fn(async (id: number, segs: AnchorSegment[]) => { store.set(id, segs) }),
    }
    vi.mocked(anchorsModule.resolveBlockAnchors).mockImplementation(async (_book, hints) => {
      if (hints[0].spineHref === 'ch3.xhtml') throw new Error('section missing')
      return hints.map(h => exact(h.spineHref, h.hint))
    })
    const progress: number[] = []
    const report = await anchorBlocks({} as Book, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], backend, p => progress.push(p.done))
    expect(report).toEqual({ resolved: 1, skipped: 2, failed: 1 })
    expect(backend.setAnchorSegments).toHaveBeenCalledTimes(1)
    expect(backend.setAnchorSegments).toHaveBeenCalledWith(1, [exact('ch1.xhtml', '一 节')])
    expect(vi.mocked(anchorsModule.resolveBlockAnchors).mock.calls[0][1]).toEqual([{ spineHref: 'ch1.xhtml', hint: '一 节' }])
    expect(store.get(1)?.[0].precision).toBe('exact')
    expect(store.get(3)?.[0].precision).toBe('chapter_fallback')
    expect(progress).toEqual([1, 2, 3, 4])
  })
})
