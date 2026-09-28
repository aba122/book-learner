import Button from '../../components/Button'
import Select from '../../components/Select'
import Tag from '../../components/Tag'
import CoverTile from './CoverTile'
import { pendingNotes } from './wereadLocate'
import { formatDuration } from '../../lib/duration'
import type { Book, WereadBook, WereadNotes, WereadStatus } from '../../types'

const fmtDay = (iso: string) => iso.slice(0, 10)

export interface ImportProgress { wereadId: string; done: number; total: number }

interface Props {
  status: WereadStatus
  books: WereadBook[]
  localBooks: Book[]
  /** 已关联书的划线/想法(按 wereadId;第二批) */
  notes?: Map<string, WereadNotes>
  syncing: boolean
  importing?: ImportProgress | null
  onSync: () => void
  onLink: (wereadId: string, localBookId: number | null) => void
  onImport?: (wereadId: string, localBookId: number) => void
}


/**
 * 书架 › 微信读书分区(BL-030):每本一张签名封面卡 + 进度/时长/读完;右下用下拉关联本地书(自动匹配的标「自动」)。
 * 已从微信读书书架移除的书压暗并标出;未连接时由父组件不渲染本分区。
 */
export default function WereadShelf({ status, books, localBooks, notes, syncing, importing = null, onSync, onLink, onImport }: Props) {
  return (
    <section aria-labelledby="weread-shelf-title" className="mt-12" data-testid="weread-shelf">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h2 id="weread-shelf-title" className="font-serif text-title3 font-semibold text-label-1">微信读书</h2>
          <p className="mt-0.5 text-footnote text-label-3">
            已关联 {status.linkedCount} / {status.bookCount} 本
            {status.lastSyncAt && ` · 上次同步 ${fmtDay(status.lastSyncAt)}`}
            {status.lastSyncOk === false && ' · 上次同步失败,详见设置'}
          </p>
        </div>
        <Button size="sm" disabled={syncing || status.syncing} onClick={onSync}>
          {syncing || status.syncing ? '同步中…' : '同步'}
        </Button>
      </div>
      {books.length === 0 ? (
        <p className="mt-4 text-callout text-label-3">微信读书书架上还没有电子书。</p>
      ) : (
        <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-x-6 gap-y-8">
          {books.map(b => (
            <article key={b.wereadId} aria-label={`微信读书《${b.title}》`} className={`flex flex-col ${b.removed ? 'opacity-60' : ''}`} data-testid="weread-book">
              <CoverTile title={b.title} coverUrl={b.coverUrl || null} />
              <div className="mt-2.5 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-serif text-headline text-label-1">{b.title}</div>
                  <div className="truncate text-subhead text-label-2">{b.author || '—'}</div>
                </div>
                {b.removed ? (
                  <Tag tone="neutral" className="shrink-0">已移出书架</Tag>
                ) : b.finishReading || b.progress >= 100 ? (
                  <Tag tone="ok" className="shrink-0">读完</Tag>
                ) : (
                  <Tag tone="neutral" className="shrink-0 tabular-nums">{b.progress}%</Tag>
                )}
              </div>
              <p className="mt-1 text-footnote text-label-3 tabular-nums">
                {b.readingSeconds > 0 ? `读了 ${formatDuration(b.readingSeconds)}` : '还没开始读'}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Select
                  size="sm"
                  aria-label={`《${b.title}》关联本地书`}
                  value={b.localBookId ?? ''}
                  onChange={e => onLink(b.wereadId, e.target.value === '' ? null : Number(e.target.value))}
                  className="min-w-0 flex-1"
                >
                  <option value="">不关联本地书</option>
                  {localBooks.map(l => (
                    <option key={l.id} value={l.id}>{l.title}</option>
                  ))}
                </Select>
                {b.localBookId !== null && b.linkSource === 'auto' && <span className="shrink-0 text-footnote text-label-3">自动</span>}
              </div>
              {b.localBookId !== null && notes?.get(b.wereadId) && (() => {
                const n = notes.get(b.wereadId)!
                const pending = pendingNotes(n)
                const busy = importing !== null
                const mine = importing?.wereadId === b.wereadId
                if (n.markCount === 0 && n.thoughtCount === 0) return null
                return (
                  <div className="mt-2 flex items-center justify-between gap-2 text-footnote text-label-3" data-testid="weread-notes">
                    <span className="tabular-nums">
                      划线 {n.markCount} · 想法 {n.thoughtCount}
                      {n.locatedCount > 0 && ` · 已导入 ${n.locatedCount}`}
                    </span>
                    {pending > 0 ? (
                      <Button size="sm" disabled={busy || !onImport} onClick={() => onImport?.(b.wereadId, b.localBookId!)}>
                        {mine ? `定位中 ${importing.done}/${importing.total}` : '导入划线'}
                      </Button>
                    ) : (
                      <span className="shrink-0">已处理</span>
                    )}
                  </div>
                )
              })()}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
