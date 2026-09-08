import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { normalizeBackendError, type BackendError } from '../backend/errors'

export type OpKey = number | string
export type OpResult = 'ok' | 'failed' | 'ignored'

export interface BackendOperation<A extends unknown[]> {
  /** 执行写操作;同 key 进行中时立即返回 'ignored'(同步守卫,防双击) */
  run: (key: OpKey, ...args: A) => Promise<OpResult>
  /** 守卫中的 key(进行中,或已提交待刷新) */
  pending: ReadonlySet<OpKey>
  /** 逐 key 最近错误;不可重试错误也保留,供禁用态使用 */
  errors: ReadonlyMap<OpKey, BackendError>
  /** 用上次 args 重跑;无记录则 'ignored' */
  retry: (key: OpKey) => Promise<OpResult>
  clearError: (key: OpKey) => void
  /** 资源刷新成功后调用:conflict 等不可重试错误不得永久禁用 */
  clearAllErrors: () => void
  /** 刷新成功后释放全部"已提交待刷新"守卫 */
  releaseCommitted: () => void
}

export interface OperationOptions<A extends unknown[]> {
  /**
   * 写成功后调用(如刷新队列)。key 在 await 之前即标为 committed,
   * 因此并发的成功刷新可通过 releaseCommitted 提前释放;若其 reject,守卫**保持**直到 releaseCommitted。
   */
  onCommitted?: (key: OpKey, ...args: A) => Promise<unknown>
}

/**
 * 写操作 hook:按 key 同步守卫 + 逐 key generation + 逐 key 错误 + 卸载失效。
 * op/onCommitted 通过 ref 取最新引用,不要求稳定。
 */
export function useBackendOperation<A extends unknown[]>(
  op: (...args: A) => Promise<unknown>,
  options: OperationOptions<A> = {},
): BackendOperation<A> {
  const [pending, setPending] = useState<ReadonlySet<OpKey>>(() => new Set())
  const [errors, setErrors] = useState<ReadonlyMap<OpKey, BackendError>>(() => new Map())
  const pendingRef = useRef(new Set<OpKey>())
  const committedRef = useRef(new Set<OpKey>())
  const errorsRef = useRef(new Map<OpKey, BackendError>())
  const generations = useRef(new Map<OpKey, number>())
  const lastArgs = useRef(new Map<OpKey, A>())
  const mounted = useRef(false)
  const opRef = useRef(op)
  const onCommittedRef = useRef(options.onCommitted)
  useLayoutEffect(() => {
    opRef.current = op
    onCommittedRef.current = options.onCommitted
  })

  const publish = useCallback(() => {
    if (!mounted.current) return
    setPending(new Set(pendingRef.current))
    setErrors(new Map(errorsRef.current))
  }, [])

  const alive = (key: OpKey, gen: number) =>
    mounted.current && generations.current.get(key) === gen

  const run = useCallback(async (key: OpKey, ...args: A): Promise<OpResult> => {
    if (!mounted.current || pendingRef.current.has(key)) return 'ignored'
    const gen = (generations.current.get(key) ?? 0) + 1
    generations.current.set(key, gen)
    lastArgs.current.set(key, args)
    pendingRef.current.add(key)
    publish()
    try {
      await opRef.current(...args)
    } catch (e) {
      if (!alive(key, gen)) return 'ignored'
      pendingRef.current.delete(key)
      errorsRef.current.set(key, normalizeBackendError(e))
      publish()
      return 'failed'
    }
    if (!alive(key, gen)) return 'ignored'
    errorsRef.current.delete(key)
    const onCommitted = onCommittedRef.current
    if (!onCommitted) {
      pendingRef.current.delete(key)
      publish()
      return 'ok'
    }
    committedRef.current.add(key) // 先标记:并发成功刷新可提前释放
    publish()
    try {
      await onCommitted(key, ...args)
    } catch {
      // 写已成功,刷新失败:保持守卫,不记错误(避免误导为写失败)
      return alive(key, gen) ? 'ok' : 'ignored'
    }
    if (!alive(key, gen)) return 'ignored'
    committedRef.current.delete(key)
    pendingRef.current.delete(key)
    publish()
    return 'ok'
  }, [publish])

  const retry = useCallback((key: OpKey): Promise<OpResult> => {
    const args = lastArgs.current.get(key)
    if (!args) return Promise.resolve('ignored')
    return run(key, ...args)
  }, [run])

  const clearError = useCallback((key: OpKey) => {
    if (errorsRef.current.delete(key)) publish()
  }, [publish])

  const clearAllErrors = useCallback(() => {
    if (errorsRef.current.size === 0) return
    errorsRef.current.clear()
    publish()
  }, [publish])

  const releaseCommitted = useCallback(() => {
    if (committedRef.current.size === 0) return
    for (const key of committedRef.current) pendingRef.current.delete(key)
    committedRef.current.clear()
    publish()
  }, [publish])

  useEffect(() => {
    const pendingSet = pendingRef.current
    const committedSet = committedRef.current
    const errorMap = errorsRef.current
    const argsMap = lastArgs.current
    mounted.current = true
    return () => {
      mounted.current = false
      pendingSet.clear()
      committedSet.clear()
      errorMap.clear()
      // 不清 generations:React StrictMode(开发构建)会对同一实例模拟卸载→重挂载,refs 保留;
      // 若在此清掉代次,effect 里发起的在飞操作(如快问 opener)会在重挂载后被判"过期"而永远停在
      // "思考中"(2026-09-08 m1-e2e 在 tauri dev 下实测)。真正卸载后 mounted=false 已足以忽略晚到结果。
      argsMap.clear()
    }
  }, [])

  return { run, pending, errors, retry, clearError, clearAllErrors, releaseCommitted }
}
