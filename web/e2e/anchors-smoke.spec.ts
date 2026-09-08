import { expect, test } from '@playwright/test'
import type { AnchorSegment, SpineChapter } from '../src/types'

type AnchorsSmokeResult = {
  spine: SpineChapter[]
  segments: AnchorSegment[]
  restored: string[]
  multi: AnchorSegment[]
  plain: Record<string, string>
}

declare global {
  interface Window {
    __ANCHORS_SMOKE__?: AnchorsSmokeResult
    __ANCHORS_SMOKE_ERROR__?: string
  }
}

test('extracts the spine and resolves heading hints into ordered CFI segments', async ({ page }) => {
  await page.goto('/anchors-smoke.html')
  await expect(page).toHaveTitle('EPUB anchors smoke')
  await expect.poll(() => page.evaluate(() => document.querySelector('#status')?.textContent), { timeout: 10_000 }).toBe('complete')
  expect(await page.evaluate(() => window.__ANCHORS_SMOKE_ERROR__ ?? null)).toBeNull()
  const r = await page.evaluate(() => window.__ANCHORS_SMOKE__!)
  console.info('anchors smoke segments', r.segments.map(s => [s.spineHref, s.hint, s.precision, s.cfiStart]))

  // 1. spine 抽取:3 章、href、h1 标题、含标题层级标记与正文
  expect(r.spine.map(c => c.href)).toEqual(['chap1.xhtml', 'chap2.xhtml', 'chap3.xhtml'])
  expect(r.spine.map(c => c.idx)).toEqual([0, 1, 2])
  expect(r.spine[0].title).toBe('第一章 供给与需求')
  expect(r.spine[0].text).toContain('## 需求定律')
  expect(r.spine[0].text).toContain('弹性衡量')
  expect(r.spine[2].text).toContain('## 机会成本')

  const [demand, summary1, summary2, summary2b, opportunity, missing, empty] = r.segments
  // 2. 精确段在下一小节前结束
  expect(demand.precision).toBe('exact')
  expect(demand.text.startsWith('需求定律')).toBe(true)
  expect(demand.text).toContain('需求定律说的是')
  expect(demand.text).not.toContain('均衡与弹性')
  expect(demand.cfiStart).toMatch(/^epubcfi\(/)
  expect(demand.cfiEnd).toMatch(/^epubcfi\(/)
  expect(demand.cfiStart).not.toBe(demand.cfiEnd)
  // 3. 章内重复标题按顺序消费;跨章同名标题独立
  expect(summary1.precision).toBe('exact')
  expect(summary2.precision).toBe('exact')
  expect(summary1.cfiStart).not.toBe(summary2.cfiStart)
  expect(summary1.text).toContain('谁让步更多')
  expect(summary2.text).toContain('练习之后')
  expect(summary2b.spineHref).toBe('chap2.xhtml')
  expect(summary2b.precision).toBe('exact')
  expect(summary2b.text).toContain('替代效应')
  // 4. 嵌套节点的标题仍可匹配
  expect(opportunity.precision).toBe('exact')
  expect(opportunity.text).toContain('机会成本')
  expect(opportunity.text).not.toContain('规模经济')
  // 5. 缺失标题 / 空 hint → 整章回退并标注精度
  expect(missing.precision).toBe('chapter_fallback')
  expect(missing.text).toBe(r.plain['chap3.xhtml'])
  expect(missing.cfiStart).toMatch(/^epubcfi\(/)
  expect(missing.cfiEnd).toMatch(/^epubcfi\(/)
  expect(empty.precision).toBe('chapter_fallback')
  expect(empty.text).toBe(r.plain['chap1.xhtml'])
  expect(empty.text).not.toBe(r.spine[0].text) // 不含 "# " 标记
  // 6. 往返还原:每个 exact 段经两个点 CFI 还原出同样的文本
  r.segments.forEach((seg, i) => {
    if (seg.precision === 'exact') expect(r.restored[i]).toBe(seg.text)
  })
  // 7. 多段块顺序保持
  expect(r.multi.map(s => [s.spineHref, s.precision])).toEqual([['chap1.xhtml', 'exact'], ['chap2.xhtml', 'exact']])
})
