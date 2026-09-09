import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_LOG_MAX_PER_MINUTE, createClientLogger, installClientLogging } from './clientLog'

function sink() {
  const events: { level: string; message: string; context?: Record<string, unknown> }[] = []
  return {
    events,
    backend: { logClientEvent: vi.fn(async (level: 'error' | 'warn' | 'info', message: string, context?: Record<string, unknown>) => { events.push({ level, message, context }) }) },
  }
}

describe('前端事件转发到 app 日志', () => {
  let dispose: (() => void) | null = null
  afterEach(() => {
    dispose?.()
    dispose = null
  })

  it('window error / unhandledrejection / console.error 都转发,附带 kind 与堆栈;console.error 仍照常输出', async () => {
    const { events, backend } = sink()
    const original = console.error
    const spy = vi.fn()
    console.error = spy
    const logger = installClientLogging(backend)
    dispose = () => { logger.dispose(); console.error = original }
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('render boom'), filename: 'App.tsx', lineno: 12, colno: 3 }))
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: 'nope' }))
    console.error('[ipc] transport_error', { path: 'x' })
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(events.map(e => [e.level, e.message, e.context?.kind])).toEqual([
      ['error', 'render boom', 'window.error'],
      ['error', 'nope', 'unhandledrejection'],
      ['error', '[ipc] transport_error', 'console.error'],
    ])
    expect(events[0].context).toMatchObject({ source: 'App.tsx', line: 12, col: 3, name: 'Error' })
    expect(String(events[0].context?.stack)).toContain('render boom')
    logger.dispose()
    console.error('after dispose')
    expect(events).toHaveLength(3)
  })

  it('每分钟限流,窗口滚动后补一条丢弃计数;转发失败不抛', async () => {
    const { events, backend } = sink()
    let t = 0
    const logger = createClientLogger(backend, () => t)
    for (let i = 0; i < CLIENT_LOG_MAX_PER_MINUTE + 5; i += 1) logger.log('info', `e${i}`)
    await Promise.resolve()
    expect(events).toHaveLength(CLIENT_LOG_MAX_PER_MINUTE)
    t = 61_000
    logger.log('info', 'next window')
    await Promise.resolve()
    expect(events.at(-2)).toMatchObject({ level: 'warn', message: 'client log: 5 条事件因限流丢弃' })
    expect(events.at(-1)).toMatchObject({ level: 'info', message: 'next window' })

    const failing = createClientLogger({ logClientEvent: vi.fn(async () => { throw new Error('ipc down') }) })
    expect(() => failing.log('error', 'x')).not.toThrow()
  })

  it('长消息截断', async () => {
    const { events, backend } = sink()
    const logger = createClientLogger(backend)
    logger.log('warn', 'x'.repeat(5000))
    await Promise.resolve()
    expect(events[0].message).toHaveLength(2000)
  })
})
