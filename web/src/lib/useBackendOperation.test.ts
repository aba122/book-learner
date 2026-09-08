import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendError } from '../backend/errors'
import { useBackendOperation } from './useBackendOperation'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

afterEach(() => vi.restoreAllMocks())

describe('useBackendOperation', () => {
  it('同 key 双击:第二次 ignored,op 只调一次', async () => {
    const d = deferred()
    const op = vi.fn(() => d.promise)
    const { result } = renderHook(() => useBackendOperation(op))
    let r1: Promise<string> | undefined
    let r2: string | undefined
    await act(async () => {
      r1 = result.current.run(1)
      r2 = await result.current.run(1)
    })
    expect(r2).toBe('ignored')
    expect(op).toHaveBeenCalledTimes(1)
    expect(result.current.pending.has(1)).toBe(true)
    await act(async () => { d.resolve() })
    expect(await r1).toBe('ok')
    expect(result.current.pending.size).toBe(0)
  })

  it('不同 key 独立进行', async () => {
    const d1 = deferred(); const d2 = deferred()
    const op = vi.fn((k: number) => (k === 1 ? d1.promise : d2.promise))
    const { result } = renderHook(() => useBackendOperation(op))
    await act(async () => { void result.current.run(1, 1); void result.current.run(2, 2) })
    expect(result.current.pending.has(1) && result.current.pending.has(2)).toBe(true)
    await act(async () => { d1.resolve() })
    expect(result.current.pending.has(1)).toBe(false)
    expect(result.current.pending.has(2)).toBe(true)
    await act(async () => { d2.resolve() })
  })

  it('失败:逐 key 记录 BackendError 并释放守卫', async () => {
    const op = vi.fn(() => Promise.reject(new BackendError({ code: 'conflict', message: '冲突', retryable: false })))
    const { result } = renderHook(() => useBackendOperation(op))
    let r: string | undefined
    await act(async () => { r = await result.current.run('a') })
    expect(r).toBe('failed')
    expect(result.current.errors.get('a')?.code).toBe('conflict')
    expect(result.current.pending.has('a')).toBe(false)
  })

  it('成功清除该 key 的旧错误;clearAllErrors 清全部', async () => {
    let fail = true
    const op = vi.fn(() => (fail ? Promise.reject(new Error('x')) : Promise.resolve()))
    const { result } = renderHook(() => useBackendOperation(op))
    await act(async () => { await result.current.run('a'); await result.current.run('b') })
    expect(result.current.errors.size).toBe(2)
    fail = false
    await act(async () => { await result.current.run('a') })
    expect(result.current.errors.has('a')).toBe(false)
    expect(result.current.errors.has('b')).toBe(true)
    act(() => result.current.clearAllErrors())
    expect(result.current.errors.size).toBe(0)
  })

  it('onCommitted 拒绝 → 守卫保持(已提交待刷新),releaseCommitted 释放', async () => {
    const op = vi.fn(() => Promise.resolve())
    const onCommitted = vi.fn(() => Promise.reject(new Error('refresh failed')))
    const { result } = renderHook(() => useBackendOperation(op, { onCommitted }))
    let r: string | undefined
    await act(async () => { r = await result.current.run(5) })
    expect(r).toBe('ok')
    expect(result.current.pending.has(5)).toBe(true)
    expect(result.current.errors.has(5)).toBe(false)
    act(() => result.current.releaseCommitted())
    expect(result.current.pending.has(5)).toBe(false)
  })

  it('晚到的 onCommitted 结果不释放后续同 key 的新守卫(generation)', async () => {
    const commit1 = deferred()
    const op2 = deferred()
    let call = 0
    const op = vi.fn(() => (++call === 1 ? Promise.resolve() : op2.promise))
    const onCommitted = vi.fn(() => (call === 1 ? commit1.promise : Promise.resolve()))
    const { result } = renderHook(() => useBackendOperation(op, { onCommitted }))
    await act(async () => { void result.current.run(9) })          // op1 ok → committed,等待 commit1
    expect(result.current.pending.has(9)).toBe(true)
    act(() => result.current.releaseCommitted())                     // 外部刷新成功,提前释放
    expect(result.current.pending.has(9)).toBe(false)
    await act(async () => { void result.current.run(9) })          // 第二次 run 持新守卫
    expect(result.current.pending.has(9)).toBe(true)
    await act(async () => { commit1.resolve() })                     // 第一次的晚到提交完成
    expect(result.current.pending.has(9)).toBe(true)                 // 不得释放新守卫
    await act(async () => { op2.resolve() })
    expect(result.current.pending.has(9)).toBe(false)
  })

  it('卸载后结果 ignored 且无 setState', async () => {
    const d = deferred()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useBackendOperation(() => d.promise))
    let r: Promise<string> | undefined
    await act(async () => { r = result.current.run(1) })
    unmount()
    await act(async () => { d.resolve() })
    expect(await r).toBe('ignored')
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('retry 用上次 args 重跑;未知 key ignored', async () => {
    let fail = true
    const op = vi.fn((n: number) => (fail ? Promise.reject(new Error(`bad ${n}`)) : Promise.resolve()))
    const { result } = renderHook(() => useBackendOperation(op))
    await act(async () => { await result.current.run('k', 7) })
    expect(result.current.errors.get('k')?.message).toBe('bad 7')
    fail = false
    let r: string | undefined
    await act(async () => { r = await result.current.retry('k') })
    expect(r).toBe('ok')
    expect(op).toHaveBeenLastCalledWith(7)
    await act(async () => { r = await result.current.retry('nope') })
    expect(r).toBe('ignored')
  })
})
