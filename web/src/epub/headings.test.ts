import { describe, expect, it } from 'vitest'
import { normalizeHeading, normalizeText, pickHeading, segmentEnd, type HeadingCandidate } from './headings'

const cands: HeadingCandidate[] = [
  { index: 0, level: 1, text: '第一章 供给与需求' },
  { index: 1, level: 2, text: '需求定律' },
  { index: 2, level: 2, text: '均衡与弹性' },
  { index: 3, level: 3, text: '弧弹性' },
  { index: 4, level: 2, text: '小结' },
  { index: 5, level: 2, text: '小结' },
]

describe('normalizeHeading', () => {
  it('去编号前缀、折叠空白、全角→半角、小写', () => {
    expect(normalizeHeading('第一节 需求定律')).toBe('需求定律')
    expect(normalizeHeading('1.2  均衡与弹性')).toBe('均衡与弹性')
    expect(normalizeHeading('一、需求定律')).toBe('需求定律')
    expect(normalizeHeading('  Demand   LAW ')).toBe('demand law')
    expect(normalizeHeading('弹性:定义')).toBe('弹性:定义')
    expect(normalizeHeading('（三）小结')).toBe('小结')
    expect(normalizeHeading('')).toBe('')
  })
})

describe('normalizeText', () => {
  it('行内空白折叠、空行去除、段落以空行分隔', () => {
    expect(normalizeText('  a  b \n\n\n c\t d \n')).toBe('a b\n\nc d')
    expect(normalizeText('\n  \n')).toBe('')
  })
})

describe('pickHeading', () => {
  it('精确归一化匹配优先于包含匹配', () => {
    const wide: HeadingCandidate[] = [{ index: 0, level: 2, text: '需求定律的例外' }, { index: 1, level: 2, text: '需求定律' }]
    expect(pickHeading('需求定律', wide, new Set())?.index).toBe(1)
    expect(pickHeading('定律', wide, new Set())?.index).toBe(0)
  })
  it('重复标题按 used 集合依次消费', () => {
    const used = new Set<number>()
    const first = pickHeading('小结', cands, used)!
    used.add(first.index)
    const second = pickHeading('小结', cands, used)!
    used.add(second.index)
    expect([first.index, second.index]).toEqual([4, 5])
    expect(pickHeading('小结', cands, used)).toBeNull()
  })
  it('空 hint 或无匹配返回 null', () => {
    expect(pickHeading('', cands, new Set())).toBeNull()
    expect(pickHeading('不存在的小节', cands, new Set())).toBeNull()
  })
})

describe('segmentEnd', () => {
  it('终点是下一个 level ≤ 本标题的候选;末尾为 null', () => {
    expect(segmentEnd(cands[1], cands)?.index).toBe(2) // h2 → 下一个 h2
    expect(segmentEnd(cands[2], cands)?.index).toBe(4) // h2 跨过 h3
    expect(segmentEnd(cands[3], cands)?.index).toBe(4) // h3 → 下一个 h2
    expect(segmentEnd(cands[5], cands)).toBeNull()
    expect(segmentEnd(cands[0], cands)).toBeNull() // h1 之后再无 h1
  })
})
