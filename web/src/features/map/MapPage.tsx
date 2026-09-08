import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import Tag, { type TagTone } from '../../components/Tag'
import { DAILY_CAP_DEFAULT } from '../../config'
import { localCalendarDate } from '../../lib/localDate'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useSession } from '../../store'
import type { BlockStatus, KnowledgeBlock, MapEditOp, Scores } from '../../types'
import { diffMapOps, type EditEntry } from './mapOps'

const STATUS_LABEL: Record<BlockStatus, string> = {
  unlearned: '未学',
  learning: '学习中',
  passed: '已通过',
  weak: '薄弱',
  consolidated: '已巩固',
}
const STATUS_TONE: Record<BlockStatus, TagTone> = {
  unlearned: 'neutral',
  learning: 'review',
  passed: 'ok',
  weak: 'weak',
  consolidated: 'ok',
}

function Stars({ scores }: { scores: Scores }) {
  const avg = Math.round((scores.accuracy + scores.completeness + scores.clarity) / 3)
  return (
    <span
      data-testid="block-stars"
      aria-label={`${avg} 星`}
      className="text-sm tracking-wider text-review"
    >
      {'★'.repeat(avg)}
      <span className="text-ink-4">{'☆'.repeat(Math.max(0, 5 - avg))}</span>
    </span>
  )
}

/** 路由参数变化即重挂载:旧 bookId 的晚到结果随旧实例卸载而作废,无需手工 generation。 */
export default function MapPage() {
  const { bookId: bookIdParam } = useParams()
  const bookId = Number(bookIdParam)
  return <MapPageContent key={bookId} bookId={bookId} />
}

function MapPageContent({ bookId }: { bookId: number }) {
  const navigate = useNavigate()
  const setActiveBookId = useSession(s => s.setActiveBookId)

  const [edits, setEdits] = useState<EditEntry[] | null>(null) // 非 null = 编辑模式
  const [goalOpen, setGoalOpen] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [remindTime, setRemindTime] = useState('21:00')

  const blocksRes = useAsyncResource(useCallback(async () => {
    const list = await backend.listBlocks(bookId)
    return [...list].sort((a, z) => a.seq - z.seq)
  }, [bookId]))
  const title = useAsyncResource(useCallback(async () => {
    const books = await backend.listBooks()
    const book = books.find(entry => entry.id === bookId)
    return { title: book?.title ?? '', mapRevision: book?.mapRevision ?? 0 }
  }, [bookId]))
  const blocks = blocksRes.data
  const bookTitle = title.data?.title ?? ''
  const mapRevision = title.data?.mapRevision ?? 0

  // 定稿:失败保留全部编辑;重试重发同一操作集与修订号(hook 记录上次 args);成功才重载列表/修订号并打开目标设定
  const confirmOp = useBackendOperation(
    (ops: MapEditOp[], expectedRevision: number) => backend.confirmMap(bookId, expectedRevision, ops),
    {
      onCommitted: async () => {
        setEdits(null)
        setGoalOpen(true)
        void blocksRes.reload()
        void title.reload()
      },
    },
  )
  const confirming = confirmOp.pending.has('confirm')
  const confirmError = confirmOp.errors.get('confirm')

  // 目标换算:未跳过块数 ÷ 天数(含今天与截止日),向上取整(须先于 planOp 声明,其闭包引用它)
  const remaining = blocks?.filter(b => !b.skipped).length ?? 0
  const dailyBlocks = (() => {
    if (!deadline) return null
    const days = Math.floor((Date.parse(deadline) - Date.parse(localCalendarDate())) / 86400000) + 1
    if (days < 1) return null
    return Math.ceil(remaining / days)
  })()

  // 目标设定:setPlan→setActiveBook 两步为一个操作;成功后该书成为主攻书并回今日
  const planOp = useBackendOperation(
    async () => {
      if (!deadline || dailyBlocks === null) return
      await backend.setPlan({
        bookId,
        deadline,
        dailyNewBlocks: dailyBlocks,
        dailyCap: DAILY_CAP_DEFAULT,
        remindTime,
      })
      await backend.setActiveBook(bookId)
    },
    {
      onCommitted: async () => {
        setActiveBookId(bookId)
        navigate('/')
      },
    },
  )
  const planning = planOp.pending.has('plan')
  const planError = planOp.errors.get('plan')

  const startEdit = () => {
    if (!blocks) return
    confirmOp.clearError('confirm')
    setEdits(blocks.map(b => ({ title: b.title, moduleName: b.moduleName, skipped: b.skipped, block: b })))
  }

  const move = (idx: number, dir: -1 | 1) => {
    setEdits(cur => {
      if (!cur) return cur
      const j = idx + dir
      if (j < 0 || j >= cur.length) return cur
      const next = [...cur]
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }

  const toggleSkip = (idx: number) => {
    setEdits(cur =>
      cur ? cur.map((e, i) => (i === idx ? { ...e, skipped: !e.skipped } : e)) : cur,
    )
  }

  const renameModule = (oldName: string, newName: string) => {
    setEdits(cur =>
      cur ? cur.map(e => (e.moduleName === oldName ? { ...e, moduleName: newName } : e)) : cur,
    )
  }

  const finalize = () => {
    if (!edits || !blocks) return
    const ops = diffMapOps(blocks, edits)
    confirmOp.clearError('confirm')
    if (ops.length === 0) {
      // 原样接受生成的地图:不调后端,但目标设定只有此入口,必须仍可达
      setEdits(null)
      setGoalOpen(true)
      return
    }
    void confirmOp.run('confirm', ops, mapRevision)
  }

  const startLearning = () => {
    if (!deadline || dailyBlocks === null) return
    planOp.clearError('plan')
    void planOp.run('plan')
  }

  // 渲染顺序:编辑模式用 edits 平铺;浏览模式用 blocks
  const editing = edits !== null
  const rows: { entry?: EditEntry; block: KnowledgeBlock }[] = editing
    ? edits.map(e => ({ entry: e, block: e.block }))
    : (blocks ?? []).map(b => ({ block: b }))

  const groups: { moduleName: string; rows: { entry?: EditEntry; block: KnowledgeBlock; flatIdx: number }[] }[] = []
  rows.forEach((row, flatIdx) => {
    const name = row.entry?.moduleName ?? row.block.moduleName
    const last = groups.at(-1)
    if (last && last.moduleName === name) last.rows.push({ ...row, flatIdx })
    else groups.push({ moduleName: name, rows: [{ ...row, flatIdx }] })
  })

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader
        title="知识地图"
        subtitle={bookTitle ? `《${bookTitle}》· ${remaining} 个知识块` : undefined}
        actions={
          editing ? (
            <>
              <Button disabled={confirming} onClick={() => {
                confirmOp.clearError('confirm')
                setEdits(null)
              }}>
                取消
              </Button>
              <Button variant="primary" disabled={confirming} onClick={finalize}>
                {confirming ? '定稿中…' : '确认定稿'}
              </Button>
            </>
          ) : (
            <Button onClick={startEdit}>编辑地图</Button>
          )
        }
      />

      {title.error && (
        <div className="mb-4">
          <AsyncError error={title.error} onRetry={title.reload} variant="compact" />
        </div>
      )}

      {blocksRes.error && blocks !== null && (
        <div className="mb-4">
          <AsyncError error={blocksRes.error} onRetry={blocksRes.reload} variant="compact" />
        </div>
      )}

      {confirmError && (
        <div className="mb-4">
          <AsyncError
            error={confirmError}
            onRetry={() => void confirmOp.retry('confirm')}
            variant="compact"
          />
        </div>
      )}

      {blocksRes.error && blocks === null ? (
        <AsyncError error={blocksRes.error} onRetry={blocksRes.reload} />
      ) : blocks === null ? (
        <p className="text-sm text-ink-3">正在展开地图…</p>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map(group => (
            <section key={group.moduleName}>
              <div className="mb-3 flex items-center gap-3">
                {editing ? (
                  <input
                    aria-label={`模块名:${group.moduleName}`}
                    defaultValue={group.moduleName}
                    disabled={confirming}
                    onBlur={e => renameModule(group.moduleName, e.target.value || group.moduleName)}
                    className="rounded-s border border-line bg-paper-2 px-2 py-1 font-serif text-base font-semibold text-ink-1"
                  />
                ) : (
                  <h2 className="font-serif text-lg font-semibold text-ink-1">
                    {group.moduleName}
                  </h2>
                )}
                <span aria-hidden className="h-px flex-1 bg-line" />
              </div>
              <div className="flex flex-col gap-2">
                {group.rows.map(({ entry, block, flatIdx }) => (
                  <Card
                    key={`${block.id}-${flatIdx}`}
                    data-testid="block-item"
                    className={`flex items-center gap-4 px-5 py-3.5 ${(entry?.skipped ?? block.skipped) ? 'opacity-45' : ''}`}
                  >
                    <span className="w-6 shrink-0 text-right font-serif text-sm text-ink-4">
                      {flatIdx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span
                        className={`font-serif text-base text-ink-1 ${entry?.skipped ? 'line-through' : ''}`}
                      >
                        {entry?.title ?? block.title}
                      </span>
                      {block.prereqIds.length > 0 && (
                        <span className="ml-2 text-xs text-ink-4">依赖 #{block.prereqIds.join(' #')}</span>
                      )}
                    </div>
                    {block.scores && !editing && <Stars scores={block.scores} />}
                    {!editing && block.skipped && <Tag tone="neutral">已跳过</Tag>}
                    {!editing && <Tag tone={STATUS_TONE[block.status]}>{STATUS_LABEL[block.status]}</Tag>}
                    {editing && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button disabled={confirming} className="px-2.5 py-1 text-xs" onClick={() => move(flatIdx, -1)}>
                          上移
                        </Button>
                        <Button disabled={confirming} className="px-2.5 py-1 text-xs" onClick={() => move(flatIdx, 1)}>
                          下移
                        </Button>
                        <Button disabled={confirming} className="px-2.5 py-1 text-xs" onClick={() => toggleSkip(flatIdx)}>
                          {entry?.skipped ? '恢复' : '跳过'}
                        </Button>
                        <Button
                          className="px-2.5 py-1 text-xs"
                          disabled
                          title="合并/拆分需读原文选区,Mac 阶段实现"
                        >
                          合并/拆分
                        </Button>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {goalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="目标设定"
          className="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div className="absolute inset-0 bg-ink-1/25" />
          <Card className="relative w-110 max-w-[92vw] p-8 shadow-pop">
            <h2 className="font-serif text-xl font-semibold text-ink-1">设定攻克目标</h2>
            <p className="mt-1 text-sm text-ink-3">
              西蒙学习法:定一个期限,把 {remaining} 个知识块摊到每一天。
            </p>
            <div className="mt-6 flex flex-col gap-4">
              <label className="flex items-center justify-between gap-4 text-sm text-ink-2">
                完成期限
                <input
                  type="date"
                  value={deadline}
                  disabled={planning}
                  onChange={e => setDeadline(e.target.value)}
                  className="rounded-s border border-line bg-paper-1 px-3 py-1.5 text-ink-1"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm text-ink-2">
                提醒时间
                <input
                  type="time"
                  value={remindTime}
                  disabled={planning}
                  onChange={e => setRemindTime(e.target.value)}
                  className="rounded-s border border-line bg-paper-1 px-3 py-1.5 text-ink-1"
                />
              </label>
              <div className="rounded-m bg-paper-3/60 px-4 py-3 text-sm text-ink-2">
                {dailyBlocks !== null ? (
                  <>
                    照此期限,<span className="font-semibold text-ink-1">每日 {dailyBlocks} 块</span>
                    (上限 {DAILY_CAP_DEFAULT} 块/日,薄弱重考与复习另计)
                  </>
                ) : (
                  '选择期限后,这里会算出每天要攻克几块。'
                )}
              </div>
            </div>
            {planError && (
              <div className="mt-4">
                <AsyncError error={planError} onRetry={startLearning} variant="compact" />
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <Button disabled={planning} onClick={() => {
                planOp.clearError('plan')
                setGoalOpen(false)
              }}>
                稍后再定
              </Button>
              <Button variant="primary" disabled={dailyBlocks === null || planning} onClick={startLearning}>
                {planning ? '保存中…' : '开始学习'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
