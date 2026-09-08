import Button from '../../components/Button'
import type { ReaderMark } from '../../types'

const COLOR_DOT: Record<string, string> = {
  yellow: 'bg-yellow-300',
  green: 'bg-green-300',
  blue: 'bg-blue-300',
  pink: 'bg-pink-300',
}

/** 阅读器右侧抽屉:书签与高亮清单(跳转 / 删除);标记来自 SQLite,按创建时间 */
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
  const Row = ({ mark, label }: { mark: ReaderMark; label: string }) => (
    <li className="flex items-start gap-2 py-1.5" data-testid={`mark-${mark.kind}`}>
      <button
        className="min-w-0 flex-1 cursor-pointer rounded-s px-2 py-1 text-left text-sm text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink-1"
        onClick={() => onJump(mark)}
      >
        <span className="flex items-center gap-2">
          {mark.kind === 'highlight' && <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${COLOR_DOT[mark.color] ?? COLOR_DOT.yellow}`} />}
          <span className="truncate">{label}</span>
        </span>
        {mark.note && <span className="mt-0.5 block truncate text-xs text-ink-4">{mark.note}</span>}
      </button>
      <Button className="px-2 py-1 text-xs" aria-label={`删除${mark.kind === 'highlight' ? '高亮' : '书签'}:${label}`} onClick={() => onRemove(mark)}>
        删除
      </Button>
    </li>
  )
  return (
    <div className="absolute inset-y-0 right-0 z-30 w-80 overflow-y-auto border-l border-line bg-paper-2 p-5 shadow-pop" data-testid="marks-panel">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-serif text-base font-semibold text-ink-1">书签与高亮</h2>
        <button className="cursor-pointer text-xs text-ink-4 hover:text-ink-1" onClick={onClose}>收起 ›</button>
      </div>
      <h3 className="text-xs text-ink-3">书签 · {bookmarks.length}</h3>
      <ul className="mb-4 divide-y divide-line">
        {bookmarks.map(m => <Row key={m.id} mark={m} label={m.text || m.spineHref} />)}
        {bookmarks.length === 0 && <li className="py-1.5 text-xs text-ink-4">还没有书签;点顶栏"书签"记下当前页。</li>}
      </ul>
      <h3 className="text-xs text-ink-3">高亮 · {highlights.length}</h3>
      <ul className="divide-y divide-line">
        {highlights.map(m => <Row key={m.id} mark={m} label={m.text || '(无文本)'} />)}
        {highlights.length === 0 && <li className="py-1.5 text-xs text-ink-4">选中正文后可加高亮。</li>}
      </ul>
    </div>
  )
}
