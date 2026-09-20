import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import Dialog from '../../components/Dialog'
import EmptyState from '../../components/EmptyState'
import Field from '../../components/Field'
import IconButton from '../../components/IconButton'
import Input from '../../components/Input'
import PageHeader from '../../components/PageHeader'
import Skeleton from '../../components/Skeleton'
import Tag, { type TagTone } from '../../components/Tag'
import Toolbar, { ToolbarSpacer } from '../../components/Toolbar'
import { DAILY_CAP_DEFAULT } from '../../config'
import { localCalendarDate } from '../../lib/localDate'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useSession } from '../../store'
import type { BlockStatus, KnowledgeBlock, MapEditOp, Scores } from '../../types'
import { diffMapOps, isLive, newEntry, type EditEntry } from './mapOps'

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
      role="img"
      aria-label={`${avg} 星`}
      className="text-callout tracking-wider text-review"
    >
      {'★'.repeat(avg)}
      <span className="text-label-4">{'☆'.repeat(Math.max(0, 5 - avg))}</span>
    </span>
  )
}

/**
 * 知识地图(视觉改版第三批):工具栏带放 编辑地图 / 整书终评(浏览态)与 取消 / 确认定稿(编辑态);
 * 每模块一张分组卡(44px 行),编辑态动作是行内图标钮组(悬停/聚焦显现,始终在 DOM);目标设定用 Dialog。
 * 路由参数变化即重挂载:旧 bookId 的晚到结果随旧实例卸载而作废,无需手工 generation。
 */
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
  // 整书终评入口(M3 T1):未跳过块全部通过/巩固
  const allPassed = remaining > 0 && (blocks?.filter(b => !b.skipped).every(b => b.status === 'passed' || b.status === 'consolidated') ?? false)
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
    setEdits(blocks.map(newEntry))
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

  // BL-002:删除(可撤销)、并入上一块(可撤销)、拆分(两个标题)
  const toggleDelete = (idx: number) => {
    setEdits(cur =>
      cur ? cur.map((e, i) => (i === idx ? { ...e, deleted: !e.deleted, mergedInto: null, split: null } : e)) : cur,
    )
  }
  const mergeIntoPrev = (idx: number) => {
    setEdits(cur => {
      if (!cur) return cur
      const self = cur[idx]
      let j = idx - 1
      while (j >= 0 && !isLive(cur[j])) j -= 1
      if (j < 0) return cur
      const target = cur[j].block.id
      // 已并入本块的行一并改指向新目标,避免链式合并
      return cur.map((e, i) => {
        if (i === idx) return { ...e, mergedInto: target, split: null }
        if (e.mergedInto === self.block.id) return { ...e, mergedInto: target }
        return e
      })
    })
  }
  const unmerge = (idx: number) => {
    setEdits(cur => (cur ? cur.map((e, i) => (i === idx ? { ...e, mergedInto: null } : e)) : cur))
  }
  const setSplit = (idx: number, split: EditEntry['split']) => {
    setEdits(cur => (cur ? cur.map((e, i) => (i === idx ? { ...e, split } : e)) : cur))
  }
  const hasPrevLive = (idx: number) => (edits ?? []).slice(0, idx).some(isLive)
  const indexOfBlock = (id: number) => (edits ?? []).findIndex(e => e.block.id === id)

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

  const closeGoal = () => {
    planOp.clearError('plan')
    setGoalOpen(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="知识地图工具栏">
        <ToolbarSpacer />
        {editing ? (
          <>
            <Button size="sm" disabled={confirming} onClick={() => {
              confirmOp.clearError('confirm')
              setEdits(null)
            }}>
              取消
            </Button>
            <Button size="sm" variant="primary" disabled={confirming} onClick={finalize}>
              {confirming ? '定稿中…' : '确认定稿'}
            </Button>
          </>
        ) : (
          <>
            {allPassed && (
              <Button size="sm" variant="primary" onClick={() => navigate(`/final/${bookId}`)}>整书终评</Button>
            )}
            <Button size="sm" onClick={startEdit} disabled={!blocks}>编辑地图</Button>
          </>
        )}
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-y-auto @container">
        <div className="mx-auto w-full max-w-[56rem] px-8 pt-6 pb-16">
          <PageHeader
            title="知识地图"
            subtitle={bookTitle ? `《${bookTitle}》· ${remaining} 个知识块` : undefined}
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
              {confirmError.code === 'invalid_request' && edits?.some(e => e.deleted) && (
                <p className="mt-1 text-footnote text-label-3">删除只对还没开始学的块有效(未学且未进今日计划);其余请改用「跳过」。</p>
              )}
            </div>
          )}

          {editing && (
            <p className="mb-4 rounded-m bg-inset px-4 py-2.5 text-footnote leading-relaxed text-label-2">
              把鼠标移到某一行会出现动作:上移 / 下移 / 跳过 / 并入上一块(原文段并入上一块,依赖改指上一块)/ 拆分(两块先共用原文段)/ 删除(只限未学且未进今日计划的块;其余用「跳过」)。
            </p>
          )}

          {blocksRes.error && blocks === null ? (
            <AsyncError error={blocksRes.error} onRetry={blocksRes.reload} />
          ) : blocks === null ? (
            <div aria-busy="true" className="rounded-l border border-sep bg-card px-4 py-3">
              <Skeleton lines={8} />
            </div>
          ) : blocks.length === 0 ? (
            <EmptyState icon="map" title="这本书还没有知识块" body="地图生成可能被中断,请回到书架重新导入一次。" />
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map(group => (
                <Card key={group.moduleName} className="divide-y divide-sep p-0">
                  <div className="flex min-h-11 items-center gap-3 px-4 py-2">
                    {editing ? (
                      <Input
                        size="sm"
                        aria-label={`模块名:${group.moduleName}`}
                        defaultValue={group.moduleName}
                        disabled={confirming}
                        onBlur={e => renameModule(group.moduleName, e.target.value || group.moduleName)}
                        className="w-72 font-serif font-semibold"
                      />
                    ) : (
                      <h2 className="font-serif text-title3 font-semibold text-label-1">
                        {group.moduleName}
                      </h2>
                    )}
                    <span className="ml-auto text-footnote text-label-3">{group.rows.length} 块</span>
                  </div>
                  {group.rows.map(({ entry, block, flatIdx }) => {
                    const dimmed = entry?.skipped ?? block.skipped
                    return (
                      <div
                        key={`${block.id}-${flatIdx}`}
                        data-testid="block-item"
                        className={`group/row flex min-h-11 items-center gap-3 px-4 py-2 ${dimmed ? 'opacity-50' : ''}`}
                      >
                        <span className="w-6 shrink-0 text-right font-serif text-subhead text-label-3 tabular-nums">
                          {String(flatIdx + 1).padStart(2, '0')}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className={`font-serif text-body text-label-1 ${entry?.skipped || entry?.deleted ? 'line-through' : ''}`}>
                              {entry?.title ?? block.title}
                            </span>
                            {block.prereqIds.length > 0 && (
                              <span className="text-footnote text-label-3">依赖 #{block.prereqIds.join(' #')}</span>
                            )}
                            {entry?.deleted && <Tag tone="weak">将删除</Tag>}
                            {entry && entry.mergedInto !== null && (
                              <Tag tone="review">并入 #{indexOfBlock(entry.mergedInto) + 1}</Tag>
                            )}
                          </div>
                          {entry?.split && (
                            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="split-editor">
                              <Input
                                size="sm"
                                aria-label="拆分:前半标题"
                                value={entry.split.titleA}
                                disabled={confirming}
                                onChange={e => setSplit(flatIdx, { titleA: e.target.value, titleB: entry.split?.titleB ?? '' })}
                                className="w-52"
                              />
                              <span className="text-footnote text-label-3">+</span>
                              <Input
                                size="sm"
                                aria-label="拆分:后半标题"
                                value={entry.split.titleB}
                                disabled={confirming}
                                onChange={e => setSplit(flatIdx, { titleA: entry.split?.titleA ?? '', titleB: e.target.value })}
                                className="w-52"
                              />
                              <span className="text-footnote text-label-3">两块先共用同一段原文,可分别改名</span>
                            </div>
                          )}
                        </div>
                        {block.scores && !editing && <Stars scores={block.scores} />}
                        {!editing && block.skipped && <Tag tone="neutral">已跳过</Tag>}
                        {!editing && <Tag tone={STATUS_TONE[block.status]}>{STATUS_LABEL[block.status]}</Tag>}
                        {editing && entry && (entry.deleted || entry.mergedInto !== null) && (
                          <Button size="sm" disabled={confirming} onClick={() => (entry.deleted ? toggleDelete(flatIdx) : unmerge(flatIdx))}>
                            撤销
                          </Button>
                        )}
                        {editing && entry && isLive(entry) && (
                          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                            <IconButton icon="arrow-up" label="上移" disabled={confirming} onClick={() => move(flatIdx, -1)} />
                            <IconButton icon="arrow-down" label="下移" disabled={confirming} onClick={() => move(flatIdx, 1)} />
                            <IconButton icon={entry.skipped ? 'eye' : 'eye-slash'} label={entry.skipped ? '恢复' : '跳过'} disabled={confirming} onClick={() => toggleSkip(flatIdx)} />
                            <IconButton icon="arrow-merge" label="并入上一块" disabled={confirming || !hasPrevLive(flatIdx)} onClick={() => mergeIntoPrev(flatIdx)} />
                            <IconButton
                              icon="scissors"
                              label={entry.split ? '取消拆分' : '拆分'}
                              active={!!entry.split}
                              disabled={confirming}
                              onClick={() => setSplit(flatIdx, entry.split ? null : { titleA: `${entry.title}(上)`, titleB: `${entry.title}(下)` })}
                            />
                            <IconButton icon="trash" label="删除" disabled={confirming || block.status !== 'unlearned'} onClick={() => toggleDelete(flatIdx)} />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={goalOpen}
        title="设定攻克目标"
        label="目标设定"
        description={`西蒙学习法:定一个期限,把 ${remaining} 个知识块摊到每一天。`}
        size="sm"
        closeButton={false}
        dismissible={!planning}
        onClose={closeGoal}
        footer={
          <>
            <Button disabled={planning} onClick={closeGoal}>稍后再定</Button>
            <Button variant="primary" disabled={dailyBlocks === null || planning} onClick={startLearning}>
              {planning ? '保存中…' : '开始学习'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col divide-y divide-sep">
          <Field label="完成期限">
            {ctl => <Input {...ctl} type="date" value={deadline} disabled={planning} onChange={e => setDeadline(e.target.value)} />}
          </Field>
          <Field label="提醒时间">
            {ctl => <Input {...ctl} type="time" value={remindTime} disabled={planning} onChange={e => setRemindTime(e.target.value)} />}
          </Field>
        </div>
        <div className="mt-3 rounded-m bg-inset px-3 py-2.5 text-callout leading-relaxed text-label-2">
          {dailyBlocks !== null ? (
            <>
              照此期限,<span className="font-semibold text-label-1">每日 {dailyBlocks} 块</span>
              (上限 {DAILY_CAP_DEFAULT} 块/日,薄弱重考与复习另计)
            </>
          ) : (
            '选择期限后,这里会算出每天要攻克几块。'
          )}
        </div>
        {planError && (
          <div className="mt-3">
            <AsyncError error={planError} onRetry={startLearning} variant="compact" />
          </div>
        )}
      </Dialog>
    </div>
  )
}
