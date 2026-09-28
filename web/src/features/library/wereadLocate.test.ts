import { describe, expect, it } from 'vitest'
import type { NewReaderMark, ReaderMark, WereadLocateStatus, WereadNotes } from '../../types'
import { candidates, locateWereadNotes, wereadColor, type SearchSection } from './wereadLocate'

/** 假章节:按纯文本 indexOf 查找,cfi 编成 `<href>@<pos>`;记录 load/unload */
function section(href: string, text: string, log: string[]): SearchSection {
  return {
    href,
    load: async () => { log.push(`load ${href}`) },
    unload: () => { log.push(`unload ${href}`) },
    search: query => {
      const pos = text.toLowerCase().indexOf(query.toLowerCase())
      return pos === -1 ? [] : [{ cfi: `epubcfi(${href}@${pos})` }]
    },
  }
}

function fakeBackend() {
  const calls: { kind: string; id: string; status: WereadLocateStatus; mark: NewReaderMark | null; attachTo: number | null }[] = []
  let next = 100
  const backend = {
    wereadLocate: async (kind: 'mark' | 'thought', id: string, status: WereadLocateStatus, localBookId: number, mark: NewReaderMark | null, attachTo: number | null): Promise<ReaderMark | null> => {
      calls.push({ kind, id, status, mark, attachTo })
      if (!mark) return null
      return {
        id: next++, bookId: localBookId, kind: 'highlight', spineHref: mark.spineHref, cfiStart: mark.cfiStart, cfiEnd: mark.cfiEnd ?? null,
        text: mark.text ?? '', color: mark.color ?? 'yellow', note: mark.note ?? '', createdAt: 't', updatedAt: 't', source: 'weread', externalId: id,
      }
    },
  }
  return { backend, calls }
}

const mark = (bookmarkId: string, chapterUid: number, range: string, markText: string, colorStyle = 0): WereadNotes['marks'][number] => ({
  bookmarkId, wereadId: 'w1', chapterUid, chapterIdx: chapterUid, chapterTitle: '', range, markText, colorStyle, createdAt: 1, localMarkId: null, locateStatus: 'pending',
})
const thought = (reviewId: string, chapterUid: number, range: string, abstractText: string, content: string): WereadNotes['thoughts'][number] => ({
  reviewId, wereadId: 'w1', content, abstractText, range, chapterUid, chapterTitle: '', createdAt: 2, star: -1, localMarkId: null, locateStatus: 'pending',
})
const notesOf = (marks: WereadNotes['marks'], thoughts: WereadNotes['thoughts']): WereadNotes => ({
  wereadId: 'w1', marks, thoughts, markCount: marks.length, locatedCount: 0, pendingCount: marks.length, thoughtCount: thoughts.length,
})

describe('微信读书划线定位(BL-030 第二批)', () => {
  it('候选:全文 → 去标点前缀 40 / 20;短文本不生成前缀;颜色按 colorStyle 循环', () => {
    const long = '“君子可以寓意于物，不可以留意于物。”寓意于物，则人为主体，人居物外，来欣赏物，则天下没有不可欣赏之物；留意于物，则物为主体。'
    const list = candidates(long)
    expect(list[0]).toBe(long)
    expect([...list[1]].length).toBeLessThanOrEqual(40)
    expect(list[1].startsWith('君子可以寓意于物')).toBe(true)
    expect([...list[2]].length).toBeLessThanOrEqual(20)
    expect(candidates('  短句  ')).toEqual(['短句'])
    expect(candidates('')).toEqual([])
    expect(candidates('a  b\n c')).toEqual(['a b c'])
    expect([wereadColor(0), wereadColor(1), wereadColor(4), wereadColor(-1)]).toEqual(['yellow', 'green', 'yellow', 'pink'])
  })

  it('全文命中 → located 建高亮;只有前缀命中 → partial;找不到 → missing;章节加载一次、用完卸载、都找到后不再开后面的章', async () => {
    const log: string[] = []
    const sections = [
      section('c1.xhtml', '第一章。价格是信号，不是命令。其余内容。', log),
      section('c2.xhtml', '第二章。需求曲线向右下方倾斜，因为价格上升时需求量减少，这是需求定律的核心表述之一。', log),
      section('c3.xhtml', '第三章。', log),
    ]
    const notes = notesOf([
      mark('bm-full', 1, '1-8', '价格是信号，不是命令。', 1),
      mark('bm-prefix', 2, '10-60', '需求曲线向右下方倾斜，因为价格上升时需求量减少，这是需求定律的核心表述之一，但是原书的这句话后面还有一段本地版没有的话。', 2),
      mark('bm-missing', 3, '1-4', '完全不存在的句子', 0),
    ], [])
    const { backend, calls } = fakeBackend()
    const progress: number[] = []
    const summary = await locateWereadNotes(7, notes, sections, backend, done => progress.push(done))
    expect(summary).toEqual({ located: 1, partial: 1, missing: 1, attached: 0 })
    expect(progress).toEqual([1, 2, 3])
    expect(calls.map(c => [c.id, c.status])).toEqual([['bm-full', 'located'], ['bm-prefix', 'partial'], ['bm-missing', 'missing']])
    expect(calls[0].mark).toMatchObject({ kind: 'highlight', spineHref: 'c1.xhtml', cfiStart: 'epubcfi(c1.xhtml@4)', cfiEnd: 'epubcfi(c1.xhtml@4)', text: '价格是信号，不是命令。', color: 'green' })
    expect(calls[1].mark?.color).toBe('blue')
    expect(calls[2].mark).toBeNull()
    // 三条都要查:第三章也开了(missing 的要查遍);每章 load/unload 成对
    expect(log).toEqual(['load c1.xhtml', 'unload c1.xhtml', 'load c2.xhtml', 'unload c2.xhtml', 'load c3.xhtml', 'unload c3.xhtml'])
  })

  it('想法:同 range 挂到划线高亮;有原文无划线 → 自己定位成带批注的高亮;无原文 → missing 不建高亮;已定位划线也能挂', async () => {
    const log: string[] = []
    const sections = [section('c1.xhtml', '价格是信号。市场会说话。', log)]
    const already = { ...mark('bm-old', 1, '20-30', '市场会说话。'), localMarkId: 55, locateStatus: 'located' as const }
    const notes = notesOf(
      [mark('bm-1', 1, '0-5', '价格是信号。'), already],
      [
        thought('rv-attach', 1, '0-5', '价格是信号。', '所以别管价格'),
        thought('rv-old', 1, '20-30', '市场会说话。', '挂到已定位的'),
        thought('rv-solo', 1, '7-12', '市场会说话', '独立想法'),
        thought('rv-book', 0, '', '', '整本书评'),
      ],
    )
    const { backend, calls } = fakeBackend()
    const summary = await locateWereadNotes(7, notes, sections, backend)
    expect(summary).toEqual({ located: 2, partial: 0, missing: 1, attached: 2 })
    const byId = Object.fromEntries(calls.map(c => [c.id, c]))
    expect(byId['bm-1'].status).toBe('located')
    expect(byId['rv-attach']).toMatchObject({ kind: 'thought', status: 'located', attachTo: 100, mark: null })
    expect(byId['rv-old']).toMatchObject({ status: 'located', attachTo: 55 })
    expect(byId['rv-solo']).toMatchObject({ status: 'located', attachTo: null })
    expect(byId['rv-solo'].mark).toMatchObject({ text: '市场会说话', note: '独立想法', color: 'yellow' })
    expect(byId['rv-book']).toMatchObject({ status: 'missing', mark: null, attachTo: null })
    // 没有待定位的 → 不开章、不调后端
    const idle = await locateWereadNotes(7, notesOf([already], []), sections, backend)
    expect(idle).toEqual({ located: 0, partial: 0, missing: 0, attached: 0 })
    expect(calls).toHaveLength(5)
  })
})
