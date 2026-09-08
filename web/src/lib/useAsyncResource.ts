import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { normalizeBackendError, type BackendError } from '../backend/errors'

/** 多步 fetcher 在 isCurrent()===false 时抛出,hook 静默丢弃(不算错误)。 */
export class StaleResult extends Error {
  constructor() {
    super('stale')
    this.name = 'StaleResult'
  }
}

export interface AsyncResource<T> {
  /** 最近一次成功结果;失败时保留旧快照 */
  data: T | null
  error: BackendError | null
  /** 首载或 reload 进行中 */
  loading: boolean
  /** 触发重载;晚到/卸载后结果被丢弃;返回是否成功发布 */
  reload: () => Promise<boolean>
}

/**
 * 读资源:generation 失效 + 卸载守卫 + 错误归一化。
 * fetcher 通过 ref 取最新引用,不要求稳定;仅在挂载时自动加载一次,其后由 reload 驱动。
 * 多步 fetcher(如 todayQueue→listBlocks)必须在每步之间检查 isCurrent(),
 * 为 false 时 `throw new StaleResult()`,否则卸载/重载后仍会发起后续请求。
 */
export function useAsyncResource<T>(
  fetcher: (isCurrent: () => boolean) => Promise<T>,
): AsyncResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<BackendError | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const mounted = useRef(false)
  const fetcherRef = useRef(fetcher)
  useLayoutEffect(() => {
    fetcherRef.current = fetcher
  }, [fetcher])

  const load = useCallback(async (): Promise<boolean> => {
    const gen = ++generation.current
    const isCurrent = () => mounted.current && gen === generation.current
    try {
      const next = await fetcherRef.current(isCurrent)
      if (!isCurrent()) return false
      setData(next)
      setError(null)
      setLoading(false)
      return true
    } catch (e) {
      if (e instanceof StaleResult) return false
      if (!isCurrent()) return false
      setError(normalizeBackendError(e))
      setLoading(false)
      return false
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load() // loading 初值已为 true,effect 内不做同步 setState
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [load])

  const reload = useCallback(() => {
    setLoading(true)
    setError(null)
    return load()
  }, [load])

  return { data, error, loading, reload }
}
