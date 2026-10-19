import { describe, expect, it, vi } from 'vitest'
import { BackendError } from './errors'
import {
  createHttpInvoke, createSseListen, fileUrl, HttpBackend, isHttpRuntime, pairTokenFromHash, pairWithToken, pingServer,
} from './http'

type Call = { url: string; init?: RequestInit }
function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return respond(url, init)
  }) as unknown as typeof fetch
  return { fn, calls }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('手机访问 · HTTP 后端(BL-032 M2)', () => {
  it('运行时标记与受管文件地址', () => {
    const doc = (content: string | null) => ({ querySelector: () => (content === null ? null : { getAttribute: () => content }) }) as unknown as Document
    expect(isHttpRuntime(doc('http'))).toBe(true)
    expect(isHttpRuntime(doc('tauri'))).toBe(false)
    expect(isHttpRuntime(doc(null))).toBe(false)
    expect(isHttpRuntime(undefined)).toBe(false)
    expect(fileUrl('/Users/me/Library/Application Support/book-learner/books/1.cover.jpg')).toBe('/files/1.cover.jpg')
    expect(fileUrl('C:\\data\\books\\7.epub')).toBe('/files/7.epub')
    expect(pairTokenFromHash('#pair=' + 'ab'.repeat(32))).toBe('ab'.repeat(32))
    expect(pairTokenFromHash('#pair=../x')).toBeNull()
    expect(pairTokenFromHash('')).toBeNull()
  })

  it('命令:JSON 平铺参数 / 原始体 + 元数据头;非 2xx 抛出响应体;401 回配对;503 换连接重试一次;网络失败可重试', async () => {
    let first503 = true
    const { fn, calls } = fakeFetch(url => {
      if (url === '/api/list') return json([1, 2])
      if (url === '/api/unit') return new Response('', { status: 200 })
      if (url === '/api/chunk') return json({ received: 4 })
      if (url === '/api/bad') return json('invalid args `bookId` for command `bad`', 400)
      if (url === '/api/missing') return json({ code: 'not_found', message: 'x', retryable: false, details: null }, 404)
      if (url === '/api/locked') return json({ code: 'unauthorized' }, 401)
      if (url === '/api/restart') {
        if (first503) {
          first503 = false
          return json({ code: 'internal' }, 503)
        }
        return json('ok')
      }
      throw new TypeError('Failed to fetch')
    })
    const onUnpaired = vi.fn()
    const invoke = createHttpInvoke(fn, onUnpaired)
    expect(await invoke('list', { bookId: 1 })).toEqual([1, 2])
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.credentials).toBe('same-origin')
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/json')
    expect(calls[0].init?.body).toBe('{"bookId":1}')
    expect(await invoke('unit')).toBeNull()
    const bytes = new Uint8Array([1, 2, 3, 4])
    expect(await invoke('chunk', bytes, { headers: { 'x-op-id': 'op-1', 'x-chunk-index': '0' } })).toEqual({ received: 4 })
    const raw = new Headers(calls[2].init?.headers)
    expect(raw.get('content-type')).toBe('application/octet-stream')
    expect(raw.get('x-op-id')).toBe('op-1')
    expect(calls[2].init?.body).toBe(bytes)
    await expect(invoke('bad', {})).rejects.toBe('invalid args `bookId` for command `bad`')
    await expect(invoke('missing', {})).rejects.toMatchObject({ code: 'not_found' })
    await expect(invoke('locked', {})).rejects.toMatchObject({ code: 'unpaired' })
    expect(onUnpaired).toHaveBeenCalledTimes(1)
    expect(await invoke('restart', {})).toBe('ok')
    expect(calls.filter(c => c.url === '/api/restart')).toHaveLength(2)
    const offline = await invoke('down', {}).catch(e => e as BackendError)
    expect(offline).toBeInstanceOf(BackendError)
    expect(offline).toMatchObject({ code: 'offline', retryable: true })
  })

  it('SSE:共享一个 EventSource,按事件名分发 JSON,退订即移除', async () => {
    const listeners = new Map<string, Set<(e: Event) => void>>()
    const source = {
      addEventListener: vi.fn((name: string, l: (e: Event) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name)!.add(l)
      }),
      removeEventListener: vi.fn((name: string, l: (e: Event) => void) => listeners.get(name)?.delete(l)),
    }
    const create = vi.fn(() => source)
    const listen = createSseListen(create as never)
    const seen: unknown[] = []
    const off = await listen('pomodoro_changed', e => seen.push(e.payload))
    await listen('map_job_progress', e => seen.push(e.payload))
    expect(create).toHaveBeenCalledTimes(1)
    const fire = (name: string, data: string) => listeners.get(name)?.forEach(l => l(Object.assign(new Event(name), { data })))
    fire('pomodoro_changed', '{"phase":"focus"}')
    fire('map_job_progress', 'plain')
    expect(seen).toEqual([{ phase: 'focus' }, 'plain'])
    off()
    fire('pomodoro_changed', '{"phase":"idle"}')
    expect(seen).toHaveLength(2)
  })

  it('探活与配对', async () => {
    const { fn, calls } = fakeFetch((url, init) => {
      if (url === '/api/ping') return json({ app: 'book-learner', version: '0.1.0', gitSha: 'abc', paired: false })
      const token = JSON.parse(String(init?.body)).token
      return new Response(null, { status: token === 'good' ? 204 : 401 })
    })
    expect(await pingServer(fn)).toEqual({ version: '0.1.0', gitSha: 'abc', paired: false })
    expect(await pairWithToken(' good ', fn)).toBe(true)
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ token: 'good' })
    expect(await pairWithToken('nope', fn)).toBe(false)
    const down = vi.fn(async () => { throw new TypeError('x') }) as unknown as typeof fetch
    await expect(pingServer(down)).rejects.toMatchObject({ code: 'offline' })
  })

  it('HttpBackend:沿用 Tauri 解码;封面走 /files;错误归一;手机本地打开 Key 页;不带路径导入模型提示去 Mac', async () => {
    const book = { id: 1, title: '活着', author: '余华', type: 'humanities', slug: 's', status: 'active', mapRevision: 1, importState: 'mapped', coverPath: '/data/books/1.cover.jpg' }
    const { fn } = fakeFetch(url => {
      if (url === '/api/library_list_books') return json([book])
      if (url === '/api/library_set_active_book') return json({ code: 'not_found', message: '未找到请求的数据', retryable: false, details: null }, 404)
      return json({ code: 'unauthorized' }, 401)
    })
    const opened: string[] = []
    const backend = new HttpBackend({ fetch: fn, openWindow: url => opened.push(url), createEventSource: () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }) as never })
    expect(backend.runtime).toBe('http')
    const [decoded] = await backend.listBooks()
    expect(decoded.coverUrl).toBe('/files/1.cover.jpg')
    await expect(backend.setActiveBook(9)).rejects.toMatchObject({ code: 'not_found', message: '未找到请求的数据' })
    await expect(backend.getSettings()).rejects.toMatchObject({ code: 'unpaired' })
    await backend.wereadOpenKeyPage()
    expect(opened).toEqual(['https://weread.qq.com/r/weread-skills'])
    await expect(backend.voiceImportModel(null)).rejects.toMatchObject({ code: 'not_implemented', message: '请在 Mac 上导入语音模型' })
  })
})
