/**
 * 无 DOM 依赖的标题/文本归一化与匹配(vitest 覆盖);DOM/CFI 部分见 extract.ts / anchors.ts(Playwright 覆盖)。
 */

export interface HeadingCandidate {
  /** 在该章标题序列中的序号 */
  index: number
  /** h1..h6 → 1..6 */
  level: number
  /** 标题的 textContent(含嵌套子元素文本) */
  text: string
}

// 编号前缀:第X章/节、1.2、一、(三)、（三)、1)、1:
const NUMBERING_PREFIX = /^(第[一二三四五六七八九十百千零〇\d]+[章节部分篇课讲][\s:.、-]*|[（(][一二三四五六七八九十\d]+[)）][\s.、:-]*|[一二三四五六七八九十]+[、.．:]\s*|\d+(?:\.\d+)*[.、:)）]?\s+|\d+(?:\.\d+)+\s*)/u

/** 去编号前缀、折叠空白、全角标点/字母数字 → 半角(NFKC)、小写 */
export function normalizeHeading(s: string): string {
  let out = s.normalize('NFKC').replace(/\s+/g, ' ').trim()
  out = out.replace(NUMBERING_PREFIX, '').trim()
  return out.toLowerCase()
}

/** 行内空白折叠、空行去除、段落以空行分隔(与 core Stage A 的 "\n\n" 切片边界一致) */
export function normalizeText(s: string): string {
  return s
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n\n')
}

/**
 * 按 hint 在候选中找标题:精确归一化相等优先,其次包含(任一方向,≥2 字);
 * 同一 hint 多次出现按 used 集合跳过已消费者;空 hint 或无匹配 → null。
 */
export function pickHeading(hint: string, candidates: HeadingCandidate[], used: Set<number>): HeadingCandidate | null {
  const target = normalizeHeading(hint)
  if (!target) return null
  const free = candidates.filter(c => !used.has(c.index))
  const exact = free.find(c => normalizeHeading(c.text) === target)
  if (exact) return exact
  if (target.length < 2) return null
  return free.find(c => {
    const text = normalizeHeading(c.text)
    return text.length >= 2 && (text.includes(target) || target.includes(text))
  }) ?? null
}

/** 段范围终点:下一个 level ≤ 本标题 level 的候选(无则 null = 章末) */
export function segmentEnd(start: HeadingCandidate, candidates: HeadingCandidate[]): HeadingCandidate | null {
  return candidates.find(c => c.index > start.index && c.level <= start.level) ?? null
}
