import { useSyncExternalStore } from 'react'

/** 手机布局断点(BL-032 M3,docs/design/2026-10-02-mobile-phase1.md §4.4):视口 ≤ 767px,与 Tailwind 的 `max-md:` 一致 */
export const PHONE_QUERY = '(max-width: 767px)'
/** 无悬停的指针(触摸屏):悬停提示不出 */
export const NO_HOVER_QUERY = '(hover: none)'

function media(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
}

/** 订阅媒体查询(jsdom 无 matchMedia → 恒为 false,即桌面布局,既有用例不受影响) */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    onChange => {
      const mq = media(query)
      mq?.addEventListener('change', onChange)
      return () => mq?.removeEventListener('change', onChange)
    },
    () => media(query)?.matches ?? false,
    () => false,
  )
}

export const useIsPhone = () => useMediaQuery(PHONE_QUERY)
