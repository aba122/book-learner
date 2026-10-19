/**
 * 手机访问(BL-032 第一阶段 M2,docs/design/2026-10-02-mobile-phase1.md §4):
 * iPhone 上的 Safari 打开 Mac 攻书内置 HTTP 服务分发的同一份前端时用的后端。
 * 不另写一套:`HttpBackend` 就是 `TauriBackend` 换了三样注入——
 * 命令走 `POST /api/<command>`(壳层把它交给与 IPC 同一条分发路径)、受管文件走 `/files/<名>`、事件走 SSE `/events`。
 * 解码、出站校验、错误归一与壳层内完全相同。凭证是配对换来的 HttpOnly cookie(同源请求自动带)。
 */
import { BackendError } from './errors'
import { TauriBackend, type InvokeFn, type ListenFn, type UnlistenFn } from './tauri'

/** 壳层 HTTP 服务给 index.html 注入的标记:`<meta name="bl-runtime" content="http">` */
export const RUNTIME_META = 'bl-runtime'
/** 任一请求 401 时在 window 上派发:根组件据此回到配对页 */
export const UNPAIRED_EVENT = 'bl:unpaired'
/** 微信读书官方 Key 获取页(手机上直接在 Safari 里开,不再让 Mac 去开) */
const WEREAD_KEY_PAGE = 'https://weread.qq.com/r/weread-skills'

type FetchFn = typeof fetch

/** 当前页面是否由 Mac 攻书的 HTTP 服务分发(同步判断,模块初始化时就要选后端) */
export function isHttpRuntime(doc: Pick<Document, 'querySelector'> | undefined = globalThis.document): boolean {
  return doc?.querySelector?.(`meta[name="${RUNTIME_META}"]`)?.getAttribute('content') === 'http'
}

/** 受管文件绝对路径(壳层返回的 EPUB / 封面路径)→ `/files/<文件名>` */
export function fileUrl(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  return `/files/${encodeURIComponent(name)}`
}

const offline = () =>
  new BackendError({ code: 'offline', message: '连不上 Mac 上的攻书:确认它开着、没有休眠,再重试', retryable: true })

const unpaired = () => new BackendError({ code: 'unpaired', message: '需要重新配对', retryable: false })

/**
 * 命令调用:JSON 平铺参数 → `application/json`;`Uint8Array`/`ArrayBuffer`(导入分块、语音)→ `application/octet-stream`,
 * 元数据头照传。非 2xx 抛出响应体(契约拒绝对象或 tauri 的参数错误字符串),交给 `normalizeInvokeError`。
 * 401 → 派发 `UNPAIRED_EVENT`;503(服务刚重启,旧连接被拒)→ 换新连接重试一次;网络失败 → 可重试的 `offline`。
 */
export function createHttpInvoke(
  fetchImpl: FetchFn = (input, init) => globalThis.fetch(input, init),
  onUnpaired: () => void = () => globalThis.dispatchEvent?.(new Event(UNPAIRED_EVENT)),
): InvokeFn {
  const send = async (command: string, body: BodyInit, headers: Headers) => {
    try {
      return await fetchImpl(`/api/${command}`, { method: 'POST', body, headers, credentials: 'same-origin' })
    } catch {
      throw offline()
    }
  }
  const invokeHttp = async (command: string, args?: unknown, options?: { headers?: HeadersInit }): Promise<unknown> => {
    const headers = new Headers(options?.headers)
    let body: BodyInit
    if (args instanceof Uint8Array || args instanceof ArrayBuffer) {
      headers.set('content-type', 'application/octet-stream')
      body = args as BodyInit
    } else {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(args ?? {})
    }
    let response = await send(command, body, headers)
    if (response.status === 503) response = await send(command, body, headers)
    if (response.status === 401) {
      onUnpaired()
      throw unpaired()
    }
    const text = await response.text()
    let value: unknown = null
    if (text) {
      try {
        value = JSON.parse(text)
      } catch {
        value = text
      }
    }
    if (!response.ok) throw value
    return value
  }
  return invokeHttp as InvokeFn
}

/** 事件监听:进程内共享一个 `EventSource('/events')`(断线由浏览器自动重连),按事件名分发 */
export function createSseListen(
  createSource: () => Pick<EventSource, 'addEventListener' | 'removeEventListener'> = () => new EventSource('/events'),
): ListenFn {
  let source: Pick<EventSource, 'addEventListener' | 'removeEventListener'> | null = null
  return async (event, handler): Promise<UnlistenFn> => {
    source ??= createSource()
    const listener = (message: Event) => {
      const data = (message as MessageEvent<string>).data
      let payload: unknown = data
      try {
        payload = JSON.parse(data)
      } catch {
        // 非 JSON 原样给
      }
      handler({ payload })
    }
    source.addEventListener(event, listener)
    const current = source
    return () => current.removeEventListener(event, listener)
  }
}

export interface PingResult { version: string; gitSha: string; paired: boolean }

/** 免认证探活;`paired` = 当前浏览器带着有效 cookie */
export async function pingServer(fetchImpl: FetchFn = (input, init) => globalThis.fetch(input, init)): Promise<PingResult> {
  let response: Response
  try {
    response = await fetchImpl('/api/ping', { credentials: 'same-origin' })
  } catch {
    throw offline()
  }
  if (!response.ok) throw offline()
  const value = (await response.json()) as Partial<PingResult>
  return { version: String(value.version ?? ''), gitSha: String(value.gitSha ?? ''), paired: value.paired === true }
}

/** 用令牌换 cookie;令牌不对返回 false */
export async function pairWithToken(token: string, fetchImpl: FetchFn = (input, init) => globalThis.fetch(input, init)): Promise<boolean> {
  let response: Response
  try {
    response = await fetchImpl('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
      credentials: 'same-origin',
    })
  } catch {
    throw offline()
  }
  if (response.status === 401) return false
  if (!response.ok) throw offline()
  return true
}

/** `#pair=<令牌>`(Mac 设置页二维码里的地址)→ 令牌 */
export function pairTokenFromHash(hash: string): string | null {
  const match = /^#pair=([0-9a-fA-F]{16,128})$/.exec(hash.trim())
  return match ? match[1] : null
}

export interface HttpBackendOptions {
  fetch?: FetchFn
  createEventSource?: () => Pick<EventSource, 'addEventListener' | 'removeEventListener'>
  openWindow?: (url: string) => void
}

export class HttpBackend extends TauriBackend {
  override readonly runtime = 'http' as const
  private readonly openWindow: (url: string) => void

  constructor(options: HttpBackendOptions = {}) {
    super(createHttpInvoke(options.fetch), {
      convertFileSrc: fileUrl,
      listen: createSseListen(options.createEventSource),
    })
    this.openWindow = options.openWindow ?? (url => void globalThis.open?.(url, '_blank', 'noopener'))
  }

  /** 手机上直接在 Safari 里开官方 Key 页(不让 Mac 去开浏览器) */
  override async wereadOpenKeyPage(): Promise<void> {
    this.openWindow(WEREAD_KEY_PAGE)
  }

  /** 不带路径 = 让 Mac 弹原生文件选择框:手机上没意义,提示去 Mac 上做 */
  override async voiceImportModel(path: string | null) {
    if (path === null) {
      throw new BackendError({ code: 'not_implemented', message: '请在 Mac 上导入语音模型', retryable: false })
    }
    return super.voiceImportModel(path)
  }
}
