import type { Book } from 'epubjs'
import { candidates } from '../library/wereadLocate'

/** epub.js Section 用到的子集:`search` 在已加载的章节文档里跨最多 5 个文本节点做精确子串匹配 */
interface SearchableSection {
  load: (request: unknown) => Promise<unknown>
  search: (query: string) => { cfi: string }[]
}

/**
 * 「在书中查看」(BL-034):在章节 `href` 里按原文找区间 CFI——先全文(空白折叠),
 * 再 40/20 字前缀(与微信读书划线定位同一套候选);找不到或章节不在 spine → null。
 */
export async function locateTextCfi(book: Pick<Book, 'spine' | 'load'>, href: string, text: string): Promise<string | null> {
  try {
    const spine = book.spine as unknown as { get?: (target: string) => SearchableSection | null | undefined } | undefined
    const section = spine?.get?.(href)
    if (!section) return null
    await section.load(book.load.bind(book))
    for (const query of candidates(text)) {
      const hits = section.search(query)
      if (hits.length > 0 && hits[0].cfi) return hits[0].cfi
    }
  } catch {
    /* 章节加载失败:退回只打开章节 */
  }
  return null
}
