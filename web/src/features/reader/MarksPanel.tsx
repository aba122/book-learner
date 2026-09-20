import type { ReactNode } from 'react'
import IconButton from '../../components/IconButton'
import type { ReaderMark } from '../../types'

const COLOR_DOT: Record<string, string> = {
  yellow: 'bg-hl-yellow',
  green: 'bg-hl-green',
  blue: 'bg-hl-blue',
  pink: 'bg-hl-pink',
}

function Row({ mark, label, onJump, onRemove }: { mark: ReaderMark; label: string; onJump: (mark: ReaderMark) => void; onRemove: (mark: ReaderMark) => void }) {
  return (
    <li className="flex min-h-[34px] items-center gap-1" data-testid={`mark-${mark.kind}`}>
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center rounded-s px-2 py-1 text-left transition-colors duration-[var(--dur-fast)] hover:bg-fill-hover"
        onClick={() => onJump(mark)}
      >
        <span className="flex items-center gap-2 text-body text-label-1">
          {mark.kind === 'highlight' && <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${COLOR_DOT[mark.color] ?? COLOR_DOT.yellow}`} />}
          <span className="truncate">{label}</span>
        </span>
        {mark.note && <span className="mt-0.5 block truncate text-footnote text-label-3">{mark.note}</span>}
      </button>
      <IconButton icon="trash" size="sm" label={`删除${mark.kind === 'highlight' ? '高亮' : '书签'}:${label}`} className="text-label-3" onClick={() => onRemove(mark)} />
    </li>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <h3 className="mt-3 mb-1 px-2 text-footnote font-medium text-label-3">
        {title} · {count}
      </h3>
      <ul className="divide-y divide-sep">{children}</ul>
    </section>
  )
}

/** 阅读器右侧抽屉(视觉改版第二批:34px 行 + 图标钮):书签与高亮清单(跳转 / 删除);标记来自 SQLite,按创建时间 */
export default function MarksPanel({
  marks,
  onJump,
  onRemove,
  onClose,
}: {
  marks: ReaderMark[]
  onJump: (mark: ReaderMark) => void
  onRemove: (mark: ReaderMark) => void
  onClose: () => void
}) {
  const bookmarks = marks.filter(m => m.kind === 'bookmark')
  const highlights = marks.filter(m => m.kind === 'highlight')
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-80 flex-col overflow-y-auto border-l border-sep bg-card p-3 shadow-popover" data-testid="marks-panel">
      <div className="flex items-center justify-between px-2">
        <h2 className="font-serif text-title3 font-semibold text-label-1">书签与高亮</h2>
        <IconButton icon="xmark" label="关闭" onClick={onClose} />
      </div>
      <Section title="书签" count={bookmarks.length}>
        {bookmarks.map(m => <Row key={m.id} mark={m} label={m.text || m.spineHref} onJump={onJump} onRemove={onRemove} />)}
        {bookmarks.length === 0 && <li className="px-2 py-1.5 text-footnote text-label-3">还没有书签;点工具栏的「书签」记下当前页。</li>}
      </Section>
      <Section title="高亮" count={highlights.length}>
        {highlights.map(m => <Row key={m.id} mark={m} label={m.text || '(无文本)'} onJump={onJump} onRemove={onRemove} />)}
        {highlights.length === 0 && <li className="px-2 py-1.5 text-footnote text-label-3">选中正文后可加高亮。</li>}
      </Section>
    </div>
  )
}
