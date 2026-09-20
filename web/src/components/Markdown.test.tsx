import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline } from '../lib/markdownParse'
import Markdown from './Markdown'

describe('轻量 Markdown 渲染(BL-015)', () => {
  it('行内:粗体、斜体、行内码、链接', () => {
    const p = parseInline('这是**粗**和*斜*与`码`和[看](https://x.com)')
    expect(p.find(x => x.bold)?.text).toBe('粗')
    expect(p.find(x => x.italic)?.text).toBe('斜')
    expect(p.find(x => x.code)?.text).toBe('码')
    expect(p.find(x => x.href)?.href).toBe('https://x.com')
  })

  it('块:标题/无序/有序/引用/围栏代码/段落', () => {
    const src = '# 标题\n\n段落一\n第二行\n\n- a\n- b\n\n1. 甲\n2. 乙\n\n> 引用\n\n```\ncode()\n```'
    const b = parseBlocks(src)
    expect(b.map(x => x.kind)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'code'])
  })

  it('用户报的例子:**加粗** 渲染为 <strong>,不再出现原始星号', () => {
    const text = '这句话的核心是:**贫穷不只是“拥有的钱少”**。社会中的“我们”如何生活,决定了谁被视为穷人。'
    render(<Markdown text={text} />)
    const strong = screen.getByText('贫穷不只是“拥有的钱少”')
    expect(strong.tagName).toBe('STRONG')
    // 整体文本里不应残留 ** 星号
    expect(document.body.textContent).not.toContain('**')
  })

  it('列表渲染为 li;链接是带 href 的 a', () => {
    render(<Markdown text={'- 第一点\n- 第二点\n\n见[文档](https://d.example)'} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    const link = screen.getByRole('link', { name: '文档' })
    expect(link).toHaveAttribute('href', 'https://d.example')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('纯文本(无标记)原样成段', () => {
    render(<Markdown text={'就一句话。'} />)
    expect(screen.getByText('就一句话。')).toBeInTheDocument()
  })
})
