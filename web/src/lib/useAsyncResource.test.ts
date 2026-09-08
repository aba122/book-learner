import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendError } from '../backend/errors'
import { useAsyncResource } from './useAsyncResource'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

afterEach(() => vi.restoreAllMocks())

describe('useAsyncResource', () => {
  it('成功:发布 data,loading=false,error=null', async () => {
    const d = deferred<number>()
    const { result } = renderHook(() => useAsyncResource(() => d.promise))
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeNull()
    await act(async () => { d.resolve(42) })
    expect(result.current.data).toBe(42)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('失败:归一化为 BackendError,保留旧 data', async () => {
    let call = 0
    const fetcher = vi.fn(() => (++call === 1 ? Promise.resolve('old') : Promise.reject(new Error('boom'))))
    const { result } = renderHook(() => useAsyncResource(fetcher))
    await act(async () => {})
    expect(result.current.data).toBe('old')
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.reload() })
    expect(ok).toBe(false)
    expect(result.current.error).toBeInstanceOf(BackendError)
    expect(result.current.error?.code).toBe('unknown')
    expect(result.current.error?.message).toBe('boom')
    expect(result.current.data).toBe('old')
    expect(result.current.loading).toBe(false)
  })

  it('竞态:先发后至的旧结果被丢弃', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const queue = [first.promise, second.promise]
    const fetcher = vi.fn(() => queue.shift()!)
    const { result } = renderHook(() => useAsyncResource(fetcher))
    // 首载 = first;立刻 reload = second
    let p: Promise<boolean> | undefined
    await act(async () => { p = result.current.reload() })
    await act(async () => { second.resolve('second') })
    await act(async () => { first.resolve('first') })
    expect(await p).toBe(true)
    expect(result.current.data).toBe('second')
  })

  it('卸载后 resolve 不 setState、不抛', async () => {
    const d = deferred<string>()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useAsyncResource(() => d.promise))
    const snapshot = result.current
    unmount()
    await act(async () => { d.resolve('late') })
    expect(result.current).toBe(snapshot)
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('reload:成功返回 true,失败返回 false 且保留旧 data', async () => {
    // 惰性构造:提前 new 出来的 Promise.reject 在被 fetcher 取用前就是"未处理拒绝",
    // vitest 会计为 Unhandled Error 并以非零码退出(CI web 任务曾因此红)
    const answers = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error('x')),
      () => Promise.resolve(3),
    ]
    const fetcher = vi.fn(() => answers.shift()!())
    const { result } = renderHook(() => useAsyncResource(fetcher))
    await act(async () => {})
    expect(result.current.data).toBe(1)
    let r1: boolean | undefined
    await act(async () => { r1 = await result.current.reload() })
    expect(r1).toBe(false)
    expect(result.current.data).toBe(1)
    let r2: boolean | undefined
    await act(async () => { r2 = await result.current.reload() })
    expect(r2).toBe(true)
    expect(result.current.data).toBe(3)
    expect(result.current.error).toBeNull()
  })

  it('多步 fetcher:卸载后不再执行后续步骤(isCurrent)', async () => {
    const step1 = deferred<number>()
    const step2 = vi.fn(() => Promise.resolve('never'))
    const fetcher = async (isCurrent: () => boolean) => {
      const a = await step1.promise
      if (!isCurrent()) return null
      return `${a}:${await step2()}`
    }
    const { unmount } = renderHook(() => useAsyncResource(fetcher))
    unmount()
    await act(async () => { step1.resolve(1) })
    expect(step2).not.toHaveBeenCalled()
  })
})
