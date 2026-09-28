import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReaderMark } from '../../types'
import MarksPanel from './MarksPanel'

const hl = (id: number, text: string, source: ReaderMark['source'], note = ''): ReaderMark => ({
  id, bookId: 1, kind: 'highlight', spineHref: 'c1.xhtml', cfiStart: 'epubcfi(/6/2!/4/2/1:0)', cfiEnd: 'epubcfi(/6/2!/4/2/1:4)',
  text, color: 'yellow', note, createdAt: 't', updatedAt: 't', source, externalId: source === 'weread' ? `bm-${id}` : null,
})

describe('标记面板 · 来源小标(BL-030 第二批)', () => {
  it('微信读书导入的高亮带「微信读书」小标,本地高亮没有;批注照常显示', () => {
    render(<MarksPanel marks={[hl(1, '本地划线', 'local'), hl(2, '微信划线', 'weread', '这就是命')]} onJump={vi.fn()} onRemove={vi.fn()} onClose={vi.fn()} />)
    const rows = screen.getAllByTestId('mark-highlight')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).queryByTestId('mark-source-weread')).toBeNull()
    expect(within(rows[1]).getByTestId('mark-source-weread')).toHaveTextContent('微信读书')
    expect(rows[1]).toHaveTextContent('这就是命')
  })
})
