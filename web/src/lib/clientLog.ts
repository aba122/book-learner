import type { Backend } from '../backend/types'
import type { ClientLogLevel } from '../types'

/**
 * 前端事件 → app 日志(测试阶段诊断):window error / unhandledrejection / console.error / 路由切换
 * 经 `backend.logClientEvent` 落到 `<data_root>/logs/app.log.YYYY-MM-DD`(target=client)。
 * 约束:只记元数据与错误文本,不记用户正文;限流防刷屏;转发链路自身出错不再转发(防循环)。
 */
export const CLIENT_LOG_MAX_PER_MINUTE = 30
export const CLIENT_LOG_MAX_MESSAGE = 2000

export interface ClientLogger {
  log: (level: ClientLogLevel, message: string, context?: Record<string, unknown>) => void
  /** 卸载全局钩子(测试用) */
  dispose: () => void
}

function describe(reason: unknown): { message: string; context: Record<string, unknown> } {
  if (reason instanceof Error) {
    return { message: reason.message || reason.name, context: { name: reason.name, stack: (reason.stack ?? '').slice(0, CLIENT_LOG_MAX_MESSAGE) } }
  }
  if (typeof reason === 'string') return { message: reason, context: {} }
  try {
    return { message: JSON.stringify(reason).slice(0, CLIENT_LOG_MAX_MESSAGE), context: {} }
  } catch {
    return { message: String(reason), context: {} }
  }
}

export function createClientLogger(backend: Pick<Backend, 'logClientEvent'>, now: () => number = Date.now): ClientLogger {
  let windowStart = now()
  let count = 0
  let dropped = 0
  let forwarding = false
  const log: ClientLogger['log'] = (level, message, context) => {
    if (forwarding) return
    const t = now()
    if (t - windowStart >= 60_000) {
      if (dropped > 0) {
        void backend.logClientEvent('warn', `client log: ${dropped} 条事件因限流丢弃`).catch(() => {})
      }
      windowStart = t
      count = 0
      dropped = 0
    }
    if (count >= CLIENT_LOG_MAX_PER_MINUTE) {
      dropped += 1
      return
    }
    count += 1
    forwarding = true
    try {
      void backend.logClientEvent(level, String(message).slice(0, CLIENT_LOG_MAX_MESSAGE), context).catch(() => {})
    } finally {
      forwarding = false
    }
  }
  return { log, dispose: () => {} }
}

/** 安装全局钩子;返回的 dispose 可卸载(测试)。重复安装无害。 */
export function installClientLogging(backend: Pick<Backend, 'logClientEvent'>, target: Window & typeof globalThis = window): ClientLogger {
  const logger = createClientLogger(backend)
  const onError = (event: ErrorEvent) => {
    const { message, context } = describe(event.error ?? event.message)
    logger.log('error', message, { ...context, source: event.filename, line: event.lineno, col: event.colno, kind: 'window.error' })
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    const { message, context } = describe(event.reason)
    logger.log('error', message, { ...context, kind: 'unhandledrejection' })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  const originalError = console.error
  const patched = (...args: unknown[]) => {
    originalError.apply(console, args)
    const [first, ...rest] = args
    const { message, context } = describe(first)
    logger.log('error', message, { ...context, kind: 'console.error', extra: rest.map(r => describe(r).message).slice(0, 3) })
  }
  console.error = patched
  return {
    log: logger.log,
    dispose: () => {
      target.removeEventListener('error', onError)
      target.removeEventListener('unhandledrejection', onRejection)
      if (console.error === patched) console.error = originalError
    },
  }
}
