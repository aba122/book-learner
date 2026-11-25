import { useState, type CSSProperties } from 'react'
import IconButton from '../../components/IconButton'
import Menu, { type MenuAnchor, type MenuEntry } from '../../components/Menu'
import { EXCERPT_SHORT_CHARS } from '../../config'
import type { Excerpt } from '../../types'

export interface ExcerptCardActions {
  onCopy: () => void
  /** 阅读器打不开(书还没有知识地图)时由页面提示原因 */
  onReveal: () => void
  onEdit: () => void
  onRemove: () => void
}

/**
 * 书摘卡片「纸笺」(BL-034,用户 11-25 在三种小样里选定):暖白纸面、细边、宋体正文,
 * 左上一枚作者色大引号;≤ 34 字的短句放大;底部虚线下是「《书》· 章节」与作者色标签。
 * 桌面悬停/聚焦时右上出现 复制 · 在书中查看 · 编辑 · 删除;触摸屏(无悬停)改为常驻「⋯」动作单。
 */
export default function ExcerptCard({
  excerpt,
  bookTitle,
  toneStyle,
  touch,
  actions,
}: {
  excerpt: Excerpt
  bookTitle: string
  toneStyle: CSSProperties
  /** 触摸屏:动作走「⋯」菜单 */
  touch: boolean
  actions: ExcerptCardActions
}) {
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null)
  const short = [...excerpt.text.replace(/\s/g, '')].length <= EXCERPT_SHORT_CHARS
  const source = excerpt.chapterTitle ? `《${bookTitle}》· ${excerpt.chapterTitle}` : `《${bookTitle}》`
  const items: MenuEntry[] = [
    { label: '复制', icon: 'doc-on-doc', onSelect: actions.onCopy },
    { label: '在书中查看', icon: 'book-open', onSelect: actions.onReveal },
    { label: '编辑', icon: 'pencil', onSelect: actions.onEdit },
    { separator: true },
    { label: '删除', icon: 'trash', danger: true, onSelect: actions.onRemove },
  ]
  return (
    <article
      aria-label={`书摘:${excerpt.text.slice(0, 24)}`}
      data-testid="excerpt-card"
      style={toneStyle}
      className="group/card bl-card-in relative mb-4 break-inside-avoid rounded-l border border-sep bg-card px-[22px] pt-[22px] pb-3.5 shadow-card transition-[box-shadow,transform] duration-[var(--dur-base)] ease-[var(--ease-out)] hover:-translate-y-px hover:shadow-popover"
    >
      <span aria-hidden className="pointer-events-none absolute top-1 left-3.5 font-[Georgia,serif] text-[44px] leading-none text-[var(--tone)] opacity-35 select-none">
        {'“'}
      </span>
      <blockquote
        className={`m-0 pt-3.5 font-serif whitespace-pre-line text-label-1 [text-wrap:pretty] ${short ? 'text-[19px] leading-[1.65]' : 'text-[15px] leading-[1.85]'}`}
      >
        {excerpt.text}
      </blockquote>
      <footer className="mt-3 flex items-center gap-2 border-t border-dashed border-sep pt-2.5 text-subhead text-label-3">
        <span className="min-w-0 truncate">{source}</span>
        {excerpt.source === 'user' && <span className="shrink-0 text-footnote font-semibold text-accent">我添加</span>}
        {excerpt.edited && <span className="shrink-0 text-footnote">已改</span>}
        {excerpt.tag && (
          <span className="ml-auto shrink-0 rounded-full bg-[var(--tone-soft)] px-2 py-px text-footnote text-[var(--tone)]">{excerpt.tag}</span>
        )}
      </footer>
      {touch ? (
        <div className="absolute top-2 right-2">
          <IconButton
            icon="ellipsis-circle"
            label="这条书摘的更多操作"
            size="sm"
            tooltip={false}
            expanded={menuAnchor !== null}
            onClick={e => setMenuAnchor(cur => (cur ? null : e.currentTarget))}
          />
          <Menu open={menuAnchor !== null} onClose={() => setMenuAnchor(null)} anchor={menuAnchor} items={items} aria-label="书摘操作" />
        </div>
      ) : (
        <div className="absolute top-2.5 right-2.5 flex gap-0.5 rounded-s bg-card/90 opacity-0 shadow-card transition-opacity duration-[var(--dur-fast)] group-focus-within/card:opacity-100 group-hover/card:opacity-100">
          <IconButton icon="doc-on-doc" label="复制" size="sm" onClick={actions.onCopy} />
          <IconButton icon="book-open" label="在书中查看" size="sm" onClick={actions.onReveal} />
          <IconButton icon="pencil" label="编辑" size="sm" onClick={actions.onEdit} />
          <IconButton icon="trash" label="删除" size="sm" onClick={actions.onRemove} />
        </div>
      )}
    </article>
  )
}
