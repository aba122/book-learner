import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { backend } from '../../backend'
import { BackendError } from '../../backend/errors'
import Button from '../../components/Button'
import { READING_POLL_MAX_MS, READING_POLL_MS, READING_QUOTE_MAX_CHARS, READING_TEXT_MAX_CHARS } from '../../config'
import type { ReadingMessage, ReadingTopic } from '../../types'
import Markdown from '../../components/Markdown'

/** clientMsgId:过 outboundClientId(字母数字 . _ -,≤ 64) */
function newClientMsgId(): string {
  return `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface Props {
  bookId: number
  /** 当前阅读位置所在章节 href(发问时记到消息上) */
  currentHref: string
  /** 当前 href 属于路由块的锚点段时给块 id,否则 null */
  blockIdForHref: (href: string) => number | null
  /** 「问 AI」带入的选文;用掉后调 onQuoteConsumed */
  quoteDraft: string | null
  onQuoteConsumed: () => void
  /** 取消等待后轮询 reading_messages 的间隔(测试用) */
  pollMs?: number
}

const errorText = (e: unknown) => (e instanceof BackendError ? e.message : e instanceof Error ? e.message : '发送失败,请重试。')

/**
 * 「问书」面板(spec 2026-09-16):ChatGPT 式自由问答,带入选文;对话按书存,默认续最新未结束话题,可「另起话题」。
 * AI 失败是成功载荷(用户消息 failed + 「重试」);「取消」只是停止等待,后端照常完成,靠轮询补上。
 */
export default function ReadingChatPanel({ bookId, currentHref, blockIdForHref, quoteDraft, onQuoteConsumed, pollMs = READING_POLL_MS }: Props) {
  const [topics, setTopics] = useState<ReadingTopic[]>([])
  const [topicId, setTopicId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ReadingMessage[]>([])
  const [text, setText] = useState('')
  const [quote, setQuote] = useState('')
  /** 正在等待回复的 clientMsgId */
  const [sending, setSending] = useState<string | null>(null)
  /** 用户点了「取消」(停止等待)的 clientMsgId:轮询直到它不再 pending */
  const [waiting, setWaiting] = useState<string | null>(null)
  const [pollExpired, setPollExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const topicIdRef = useRef<number | null>(null)
  const messagesRef = useRef<ReadingMessage[]>([])
  const inFlight = useRef<string | null>(null)
  useEffect(() => {
    topicIdRef.current = topicId
    messagesRef.current = messages
  })

  const loadTopics = useCallback(async () => {
    const list = await backend.readingTopics(bookId)
    setTopics(list)
    return list
  }, [bookId])

  const loadMessages = useCallback(async (id: number) => {
    const list = await backend.readingMessages(id)
    setMessages(list)
    return list
  }, [])

  // 首次:该书最新未结束话题即当前话题
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const list = await loadTopics()
        if (!alive) return
        const open = list.find(t => t.endedAt === null) ?? null
        setTopicId(open?.id ?? null)
        if (open) await loadMessages(open.id)
      } catch (e) {
        if (alive) setLoadError(errorText(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [loadTopics, loadMessages])

  // 离开阅读器:对当前话题排一次提炼(第一批后端返回 false;忙时 conflict,吞掉)
  useEffect(
    () => () => {
      const id = topicIdRef.current
      if (id !== null && messagesRef.current.some(m => m.role === 'assistant')) {
        void backend.readingDistill(id).catch(() => {})
      }
    },
    [],
  )

  // 「问 AI」带入的选文优先于本地引用;用掉(发送/删除)时才通知父组件清掉,不在 effect 里 setState
  const effectiveQuote = quoteDraft !== null ? quoteDraft.slice(0, READING_QUOTE_MAX_CHARS) : quote
  const clearQuote = () => {
    if (quoteDraft !== null) onQuoteConsumed()
    setQuote('')
  }
  useEffect(() => {
    if (quoteDraft !== null) textareaRef.current?.focus()
  }, [quoteDraft])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight // jsdom 无 scrollTo
  }, [messages, sending])

  const applyResult = useCallback((clientMsgId: string, result: { topicId: number; userMessage: ReadingMessage; assistantMessage: ReadingMessage | null }) => {
    setTopicId(result.topicId)
    setMessages(cur => {
      const already = cur.some(m => m.clientMsgId === clientMsgId && m.status !== 'pending')
      if (already) return cur
      const replaced = cur.map(m => (m.clientMsgId === clientMsgId ? result.userMessage : m))
      return result.assistantMessage ? [...replaced, result.assistantMessage] : replaced
    })
    void loadTopics().catch(() => {})
  }, [loadTopics])

  const dispatch = useCallback(async (input: { topicId: number | null; clientMsgId: string; text: string; quote: string; spineHref: string; blockId: number | null }) => {
    setError(null)
    setSending(input.clientMsgId)
    inFlight.current = input.clientMsgId
    try {
      const result = await backend.readingSend({ bookId, ...input })
      applyResult(input.clientMsgId, result)
    } catch (e) {
      setMessages(cur => cur.map(m => (m.clientMsgId === input.clientMsgId ? { ...m, status: 'failed' } : m)))
      setError(errorText(e))
    } finally {
      if (inFlight.current === input.clientMsgId) {
        inFlight.current = null
        setSending(null)
      }
    }
  }, [bookId, applyResult])

  const send = () => {
    const body = text.trim().slice(0, READING_TEXT_MAX_CHARS)
    if (!body || sending || waiting) return
    const clientMsgId = newClientMsgId()
    const q = effectiveQuote.slice(0, READING_QUOTE_MAX_CHARS)
    const blockId = blockIdForHref(currentHref)
    const optimistic: ReadingMessage = {
      id: -Date.now(), topicId: topicId ?? -1, role: 'user', text: body, quote: q, spineHref: currentHref, blockId,
      status: 'pending', clientMsgId, createdAt: new Date().toISOString(),
    }
    setMessages(cur => [...cur, optimistic])
    setText('')
    clearQuote()
    void dispatch({ topicId, clientMsgId, text: body, quote: q, spineHref: currentHref, blockId })
  }

  const retry = (m: ReadingMessage) => {
    if (!m.clientMsgId || sending || waiting) return
    setMessages(cur => cur.map(x => (x.id === m.id ? { ...x, status: 'pending' } : x)))
    void dispatch({ topicId: topicId ?? (m.topicId > 0 ? m.topicId : null), clientMsgId: m.clientMsgId, text: m.text, quote: m.quote, spineHref: m.spineHref, blockId: m.blockId })
  }

  /** 「取消」= 停止等待;后端照常完成,轮询 reading_messages 直到该条不再 pending */
  const cancelWaiting = () => {
    if (!sending) return
    const id = sending
    inFlight.current = null
    setSending(null)
    setWaiting(id)
    setPollExpired(false)
  }

  const pollOnce = useCallback(async (): Promise<boolean> => {
    const id = waiting
    if (!id) return true
    let tid = topicIdRef.current
    if (tid === null) {
      const list = await backend.readingTopics(bookId)
      tid = list.find(t => t.endedAt === null)?.id ?? null
      if (tid === null) return false
      setTopicId(tid)
    }
    const list = await backend.readingMessages(tid)
    const mine = list.find(m => m.clientMsgId === id)
    if (mine && mine.status !== 'pending') {
      setMessages(list)
      setWaiting(null)
      setPollExpired(false)
      void loadTopics().catch(() => {})
      return true
    }
    return false
  }, [waiting, bookId, loadTopics])

  useEffect(() => {
    if (!waiting || pollExpired) return
    const started = Date.now()
    const timer = setInterval(() => {
      void pollOnce()
        .then(done => {
          if (!done && Date.now() - started >= READING_POLL_MAX_MS) setPollExpired(true)
        })
        .catch(() => {})
    }, pollMs)
    const onFocus = () => void pollOnce().catch(() => {})
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [waiting, pollExpired, pollMs, pollOnce])

  const newTopic = () => {
    const old = topicId
    setTopicId(null)
    setMessages([])
    setError(null)
    if (old !== null) {
      void backend.readingTopicEnd(old).catch(() => {}).finally(() => void loadTopics().catch(() => {}))
    }
  }

  const switchTopic = async (id: number) => {
    setTopicId(id)
    setError(null)
    try {
      await loadMessages(id)
    } catch (e) {
      setLoadError(errorText(e))
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const current = topics.find(t => t.id === topicId) ?? null
  const topicState = (t: ReadingTopic): 'pending' | 'done' | 'none' => (t.needsDistill ? 'pending' : t.distilledAt ? 'done' : 'none')
  const busy = sending !== null || waiting !== null
  const waitingMsg = waiting ? messages.find(m => m.clientMsgId === waiting) : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="reading-chat">
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <span className="truncate" title={current?.anchorHref}>
          {current ? `话题 · ${current.startedAt.slice(0, 10)}` : '新话题'}
        </span>
        {current && (
          <span data-testid="topic-state" data-state={topicState(current)} className="text-[11px] text-ink-4">
            {topicState(current) === 'pending' ? '待整理' : topicState(current) === 'done' ? '已记入记忆' : ''}
          </span>
        )}
        <span className="flex-1" />
        <select
          aria-label="历史话题"
          className="max-w-32 rounded-s border border-line bg-paper-1 px-1 py-0.5 text-[11px] text-ink-2"
          value={topicId ?? ''}
          onChange={e => {
            const v = e.target.value
            if (v) void switchTopic(Number(v))
          }}
        >
          <option value="">历史</option>
          {topics.map(t => (
            <option key={t.id} value={t.id}>
              {t.startedAt.slice(0, 16).replace('T', ' ')} · {t.firstQuestion || '(空)'}
            </option>
          ))}
        </select>
        <Button className="px-2 py-0.5 text-[11px]" disabled={busy || messages.length === 0} onClick={newTopic}>
          另起话题
        </Button>
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1" data-testid="reading-messages">
        {loadError && <p className="text-xs text-weak">{loadError}</p>}
        {messages.length === 0 && !sending && (
          <p className="text-xs leading-relaxed text-ink-3">选中正文里的一段文字点「问 AI」,或直接在这里贴一段话来问。</p>
        )}
        {messages.map(m => (
          <div
            key={m.id}
            data-testid="reading-msg"
            data-role={m.role}
            data-status={m.status}
            className={`max-w-[88%] rounded-m px-3.5 py-2.5 text-sm leading-relaxed ${m.role === 'user' ? 'self-end bg-paper-3 text-ink-1' : 'self-start border border-line bg-paper-2 text-ink-1'}`}
          >
            {m.quote && <blockquote className="mb-1.5 border-l-2 border-line pl-2 text-xs text-ink-3 line-clamp-4">{m.quote}</blockquote>}
            {m.role === 'assistant' ? <Markdown text={m.text} /> : <div className="whitespace-pre-wrap">{m.text}</div>}
            {m.role === 'user' && m.status === 'failed' && (
              <div className="mt-1 flex items-center gap-2 text-[11px] text-weak">
                <span>没有得到回复</span>
                <button className="cursor-pointer underline" disabled={busy} onClick={() => retry(m)}>重试</button>
              </div>
            )}
            {m.role === 'user' && m.status === 'pending' && waiting === m.clientMsgId && (
              <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-4">
                <span>等待中…</span>
                {pollExpired && (
                  <button className="cursor-pointer underline" onClick={() => { setPollExpired(false); void pollOnce().catch(() => {}) }}>刷新</button>
                )}
              </div>
            )}
          </div>
        ))}
        {sending && (
          <div className="self-start flex items-center gap-2 text-xs text-ink-4" data-testid="reading-thinking">
            <span>思考中…</span>
            <button className="cursor-pointer underline" onClick={cancelWaiting}>取消</button>
          </div>
        )}
        {waitingMsg && !sending && null}
        {error && <p className="text-xs text-weak" role="alert">{error}</p>}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line pt-2">
        {effectiveQuote && (
          <div className="flex items-start gap-2 rounded-s border border-line bg-paper-1 px-2 py-1 text-[11px] text-ink-3" data-testid="quote-draft">
            <span className="line-clamp-3 flex-1">{effectiveQuote}</span>
            <button className="cursor-pointer text-ink-4 hover:text-ink-1" aria-label="删除引用" onClick={clearQuote}>×</button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          aria-label="问书输入"
          rows={3}
          value={text}
          disabled={busy}
          placeholder="读到哪里不懂,就在这里问(Enter 发送,Shift+Enter 换行)"
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full resize-none rounded-s border border-line bg-paper-2 px-2 py-1.5 text-xs text-ink-1 disabled:opacity-60"
        />
        <div className="flex justify-end">
          <Button variant="primary" className="px-3 py-1 text-xs" disabled={busy || !text.trim()} onClick={send}>
            发送
          </Button>
        </div>
      </div>
    </div>
  )
}
