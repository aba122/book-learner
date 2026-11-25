import { describe, expect, it } from 'vitest'
import type { Book, Excerpt, ExcerptBookStats } from '../../types'
import { UNKNOWN_AUTHOR, authorInfo, groupByAuthor, matchesQuery, toneFor } from './authors'

const book = (id: number, author: string, title = `书${id}`): Book => ({
  id, title, author, type: 'humanities', slug: `b${id}`, status: 'paused', mapRevision: 1, importState: 'mapped', coverUrl: null,
})
const stats = (bookId: number, over: Partial<ExcerptBookStats> = {}): ExcerptBookStats => ({
  bookId, hasText: true, readerBlockId: null, aiCount: 0, userCount: 0, job: null, ...over,
})
const excerpt = (id: number, bookId: number, text = `第${id}句`): Excerpt => ({
  id, bookId, source: 'ai', text, originalText: text, tag: '', spineHref: 'a.xhtml', chapterTitle: '第一章', chapterIdx: 1,
  cfi: null, edited: false, createdAt: 't', updatedAt: 't',
})

describe('作者归一(BL-034)', () => {
  it('去掉国别前缀、结尾原名括注、著/译,注记另存', () => {
    expect(authorInfo('(英)齐格蒙特·鲍曼')).toMatchObject({ name: '齐格蒙特·鲍曼', note: '英', mono: '鲍' })
    expect(authorInfo('西格蒙德·弗洛伊德(Sigmund Freud)')).toMatchObject({ name: '西格蒙德·弗洛伊德', note: 'Sigmund Freud', mono: '弗' })
    expect(authorInfo('[美]欧文·D·亚隆 著')).toMatchObject({ name: '欧文·D·亚隆', note: '美', mono: '亚' })
    expect(authorInfo('孙武 著').name).toBe('孙武')
    expect(authorInfo('段永平').mono).toBe('段')
  })
  it('同一作者的不同写法得到同一个键', () => {
    const a = authorInfo('(英)齐格蒙特·鲍曼')
    const b = authorInfo('齐格蒙特 • 鲍曼 著')
    expect(a.key).toBe(b.key)
    expect(a.tone).toBe(b.tone)
    expect(a.tone).toBeGreaterThanOrEqual(1)
    expect(a.tone).toBeLessThanOrEqual(6)
  })
  it('多位作者取第一位;拉丁名徽记取姓的首字母', () => {
    expect(authorInfo('张三、李四').name).toBe('张三')
    expect(authorInfo('Daniel Kahneman, Amos Tversky')).toMatchObject({ name: 'Daniel Kahneman', mono: 'K' })
  })
  it('空 / 待识别 → 未识别作者(中性色)', () => {
    for (const raw of ['', '  ', '待识别', 'Unknown', null]) {
      expect(authorInfo(raw)).toMatchObject({ key: '', name: UNKNOWN_AUTHOR, tone: 0 })
    }
    expect(toneFor('')).toBe(0)
  })
})

describe('按作者分组', () => {
  it('同作者的书并组;没正文没卡片没作业的书不收;未识别作者排最后;卡片数累加', () => {
    const books = [book(1, '待识别'), book(2, '(英)齐格蒙特·鲍曼'), book(3, '齐格蒙特·鲍曼'), book(4, '老子'), book(5, '曼昆')]
    const st = [stats(1), stats(2), stats(3), stats(4), stats(5, { hasText: false })]
    const groups = groupByAuthor(books, st, [excerpt(1, 2), excerpt(2, 3), excerpt(3, 3), excerpt(4, 1)])
    expect(groups.map(g => g.name)).toEqual(['齐格蒙特·鲍曼', '老子', UNKNOWN_AUTHOR])
    expect(groups[0].books.map(b => b.book.id)).toEqual([2, 3])
    expect(groups[0].count).toBe(3)
    expect(groups[0].note).toBe('英')
    expect(groups[1].count).toBe(0)
  })
  it('搜索覆盖文字、标签、章节与书名', () => {
    const e = { ...excerpt(1, 1, '其实地上本没有路'), tag: '希望', chapterTitle: '故乡' }
    expect(matchesQuery(e, '呐喊', '路')).toBe(true)
    expect(matchesQuery(e, '呐喊', '希望')).toBe(true)
    expect(matchesQuery(e, '呐喊', '故乡')).toBe(true)
    expect(matchesQuery(e, '呐喊', '呐喊')).toBe(true)
    expect(matchesQuery(e, '呐喊', '彷徨')).toBe(false)
    expect(matchesQuery(e, '呐喊', '  ')).toBe(true)
  })
})
