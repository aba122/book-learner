import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import Confirm from '../../components/Confirm'
import Tag from '../../components/Tag'
import { KIND_LABEL, TYPEWRITER_CHAR_MS } from '../../config'
import { localCalendarDate } from '../../lib/localDate'
import { StaleResult, useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useSession } from '../../store'
import type { ChatMessage, DailyTask, EvalResult, KnowledgeBlock } from '../../types'
import EvalCard from './EvalCard'

interface TeachingSession {
  task: DailyTask
  block: KnowledgeBlock
  source: { href: string; text: string }
  sessionId: number
}

const NO_SESSION = () =>
  new BackendError({ code: 'invalid_request', message: '会话尚未建立', retryable: false })

export default function FeynmanPage() {
  const { taskId: taskIdParam } = useParams()
  const taskId = Number(taskIdParam)
  const navigate = useNavigate()
  const setPendingNotice = useSession(s => s.setPendingNotice)
  const [today] = useState(localCalendarDate)

  // 一旦尝试过 startSession(付费会话),即使失败也不再允许重试初始化,只提供安全返回
  const [startAttempted, setStartAttempted] = useState(false)

  // 初始化管线:队列→块→原文→会话,任一步失败均为只读失败;卸载/重载后不继续后续步骤
  const init = useAsyncResource(useCallback(async (isCurrent: () => boolean): Promise<TeachingSession> => {
    const queue = await backend.todayQueue(today)
    if (!isCurrent()) throw new StaleResult()
    const task = queue.find(x => x.id === taskId)
    if (!task) {
      throw new BackendError({
        code: 'not_found',
        message: '今天的队列中没有找到这项学习任务',
        retryable: false,
      })
    }
    const block = await backend.getBlock(task.blockId)
    if (!isCurrent()) throw new StaleResult()
    const source = await backend.blockSource(task.blockId)
    if (!isCurrent()) throw new StaleResult()
    setStartAttempted(true)
    const s = await backend.startSession(task.blockId, task.kind)
    if (!isCurrent()) throw new StaleResult()
    return { task, block, source, sessionId: s.sessionId }
  }, [taskId, today]))
  const session = init.data
  const sessionId = session?.sessionId ?? null
  const task = session?.task ?? null
  const block = session?.block ?? null
  const source = session?.source ?? null

  const [transcript, setTranscript] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [typing, setTyping] = useState<string | null>(null)
  const [typingKey, setTypingKey] = useState(0)
  const typingFull = useRef('')
  const [readyToEnd, setReadyToEnd] = useState(false)
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null)
  const [abandonOpen, setAbandonOpen] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(true)
  const scrollAnchor = useRef<HTMLDivElement>(null)

  // 发送:失败保留已发送的用户消息,重试重发同一 transcript;成功后学生回复渐显
  const lastReply = useRef<{ text: string; readyToEnd: boolean } | null>(null)
  const sendOp = useBackendOperation(
    async (next: ChatMessage[]) => {
      if (sessionId === null) throw NO_SESSION()
      lastReply.current = await backend.studentReply(sessionId, next)
    },
    {
      onCommitted: async () => {
        const reply = lastReply.current
        if (!reply) return
        typingFull.current = reply.text
        setTyping('')
        setTypingKey(k => k + 1)
        if (reply.readyToEnd) setReadyToEnd(true)
      },
    },
  )
  const thinking = sendOp.pending.has('send')
  const sendError = sendOp.errors.get('send')

  // 结束讲授:失败留在对话页可重试,不导航
  const lastEval = useRef<EvalResult | null>(null)
  const endOp = useBackendOperation(
    async () => {
      if (sessionId === null) throw NO_SESSION()
      lastEval.current = await backend.endSession(sessionId)
    },
    { onCommitted: async () => { if (lastEval.current) setEvalResult(lastEval.current) } },
  )
  const ending = endOp.pending.has('end')
  const endError = endOp.errors.get('end')

  // 确认判定:confirmVerdict 失败在卡内显示;判定已落库而 completeTask 失败 → 不回滚不重发,回今日并提示后台同步
  const confirmOp = useBackendOperation(
    async (pass: boolean) => {
      if (sessionId === null || !task) throw NO_SESSION()
      await backend.confirmVerdict(sessionId, pass)
      if (pass) {
        try {
          await backend.completeTask(task.id)
        } catch {
          setPendingNotice('评估已保存,任务状态稍后同步')
        }
      }
    },
    { onCommitted: async () => navigate('/') },
  )
  const confirming = confirmOp.pending.has('confirm')
  const confirmError = confirmOp.errors.get('confirm')
  const anyPending = thinking || ending || confirming

  // 打字机:interval 单独按轮次启动,批量推进也能整段渐显
  useEffect(() => {
    if (typingKey === 0) return
    const id = setInterval(() => {
      setTyping(cur => {
        if (cur === null || cur.length >= typingFull.current.length) return cur
        return typingFull.current.slice(0, cur.length + 1)
      })
    }, TYPEWRITER_CHAR_MS)
    return () => clearInterval(id)
  }, [typingKey])

  // 渐显完成 → 落入对话流
  useEffect(() => {
    if (typing !== null && typingFull.current && typing.length >= typingFull.current.length) {
      setTranscript(cur => [...cur, { role: 'student', text: typingFull.current }])
      setTyping(null)
    }
  }, [typing])

  useEffect(() => {
    scrollAnchor.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [transcript, typing, thinking])

  const busy = thinking || typing !== null

  const send = () => {
    const text = draft.trim()
    if (!text || sessionId === null || busy) return
    const next: ChatMessage[] = [...transcript, { role: 'user', text }]
    setTranscript(next)
    setDraft('')
    sendOp.clearError('send')
    void sendOp.run('send', next)
  }

  const endTeaching = () => {
    if (sessionId === null) return
    endOp.clearError('end')
    void endOp.run('end')
  }

  const confirmVerdict = (pass: boolean) => {
    confirmOp.clearError('confirm')
    void confirmOp.run('confirm', pass)
  }

  if (session === null) {
    return (
      <div className="flex h-full items-center justify-center px-8 py-12">
        <Card className="w-full max-w-xl p-8">
          <h1 className="font-serif text-xl font-semibold text-ink-1">准备费曼讲授</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-3">
            正在读取今日任务、原文和讲授上下文。会话创建后才会开放输入。
          </p>
          <div className="mt-6">
            {init.error ? (
              <AsyncError
                error={init.error}
                onRetry={startAttempted ? undefined : init.reload}
              />
            ) : (
              <p className="text-sm text-ink-3">正在准备讲授…</p>
            )}
          </div>
          <div className="mt-6 flex justify-end">
            <Button onClick={() => navigate('/')}>返回今日</Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* 左:可折叠原文参考 */}
      {sourceOpen ? (
        <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-paper-2/60 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-medium tracking-wide text-ink-3">原文参考</h2>
            <button
              className="cursor-pointer text-xs text-ink-4 hover:text-ink-1"
              onClick={() => setSourceOpen(false)}
            >
              ‹ 收起
            </button>
          </div>
          {source ? (
            <p className="overflow-y-auto text-sm leading-loose text-ink-2">{source.text}</p>
          ) : (
            <p className="text-xs text-ink-4">加载原文…</p>
          )}
          <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-4">
            尽量先不看参考;卡住了再瞄一眼,讲完记得把它折起来。
          </p>
        </aside>
      ) : (
        <button
          className="shrink-0 cursor-pointer border-r border-line bg-paper-2/60 px-1.5 text-xs text-ink-3 hover:text-ink-1"
          onClick={() => setSourceOpen(true)}
        >
          原文
        </button>
      )}

      {/* 中:对话 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-paper-2/70 px-6 py-3">
          {task && <Tag tone={task.kind === 'new' ? 'new' : 'weak'}>{KIND_LABEL[task.kind]}</Tag>}
          <h1 className="min-w-0 flex-1 truncate font-serif text-base font-semibold text-ink-1">
            {block ? `讲授:${block.title}` : '费曼讲授'}
          </h1>
          <Button
            className="px-3 py-1.5 text-xs"
            onClick={() => block && navigate(`/reader/${block.id}?back=${taskId}`)}
          >
            回读原文
          </Button>
          <Button
            variant={readyToEnd ? 'primary' : 'ghost'}
            data-ready={readyToEnd ? 'true' : 'false'}
            className="px-3 py-1.5 text-xs"
            disabled={ending}
            onClick={endTeaching}
          >
            {ending ? '评估中…' : '结束讲授'}
          </Button>
          <Button
            className="px-3 py-1.5 text-xs"
            disabled={anyPending}
            onClick={() => setAbandonOpen(true)}
          >
            放弃本次
          </Button>
        </header>

        {endError && (
          <div className="border-b border-line bg-paper-2/70 px-6 py-3">
            <AsyncError error={endError} onRetry={() => void endOp.retry('end')} variant="compact" />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {transcript.length === 0 && typing === null && !thinking && (
              <div className="rounded-m bg-paper-3/50 px-5 py-4 text-sm leading-relaxed text-ink-3">
                你的学生已经坐好了。用自己的话,把「{block?.title ?? '这个知识块'}
                」讲给 TA 听——讲不清的地方,就是要回补的漏洞。
              </div>
            )}
            {transcript.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="self-end">
                  <div className="max-w-md rounded-m rounded-br-s bg-ink-1 px-4 py-2.5 text-sm leading-relaxed text-paper-2">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex items-start gap-2.5 self-start">
                  <span
                    aria-hidden
                    className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-new-soft font-serif text-xs text-new"
                  >
                    生
                  </span>
                  <div className="max-w-md rounded-m rounded-tl-s border border-line bg-paper-2 px-4 py-2.5 text-sm leading-relaxed text-ink-1 shadow-card">
                    {m.text}
                  </div>
                </div>
              ),
            )}
            {thinking && (
              <div className="flex items-center gap-2.5 self-start text-sm text-ink-3">
                <span
                  aria-hidden
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-new-soft font-serif text-xs text-new"
                >
                  生
                </span>
                学生思考中<span className="animate-pulse">…</span>
              </div>
            )}
            {typing !== null && !thinking && (
              <div className="flex items-start gap-2.5 self-start">
                <span
                  aria-hidden
                  className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-new-soft font-serif text-xs text-new"
                >
                  生
                </span>
                <div className="max-w-md rounded-m rounded-tl-s border border-line bg-paper-2 px-4 py-2.5 text-sm leading-relaxed text-ink-1 shadow-card">
                  {typing}
                  <span className="animate-pulse text-ink-4">▍</span>
                </div>
              </div>
            )}
            {sendError && (
              <div className="self-start">
                <AsyncError error={sendError} onRetry={() => void sendOp.retry('send')} variant="compact" />
              </div>
            )}
            <div ref={scrollAnchor} />
          </div>
        </div>

        <div className="border-t border-line bg-paper-2/70 px-6 py-4">
          <div className="mx-auto flex max-w-2xl items-end gap-3">
            <button
              disabled
              title="语音输入 Mac 版可用"
              className="cursor-not-allowed rounded-m border border-line px-3 py-2 text-sm text-ink-4 opacity-60"
            >
              🎙
            </button>
            <textarea
              aria-label="复述输入"
              rows={2}
              value={draft}
              disabled={busy || sessionId === null}
              placeholder="用自己的话讲给学生听…(Cmd/Ctrl + Enter 发送)"
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  send()
                }
              }}
              className="min-h-0 flex-1 resize-none rounded-m border border-line bg-paper-1 px-4 py-2.5 text-sm leading-relaxed text-ink-1 placeholder:text-ink-4 disabled:opacity-60"
            />
            <Button variant="primary" disabled={!draft.trim() || busy} onClick={send}>
              发送
            </Button>
          </div>
        </div>
      </div>

      {evalResult && (
        <EvalCard
          result={evalResult}
          onConfirm={confirmVerdict}
          error={confirmError ?? null}
          onRetry={() => void confirmOp.retry('confirm')}
          busy={confirming}
          confirmDisabled={confirmError?.retryable === false}
        />
      )}
      <Confirm
        open={abandonOpen}
        title="放弃这次讲授?"
        message="本次对话不会计入评估,知识块状态保持不变。"
        confirmText="放弃"
        cancelText="继续讲"
        danger
        onConfirm={() => navigate('/')}
        onCancel={() => setAbandonOpen(false)}
      />
    </div>
  )
}
