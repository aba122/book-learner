import { create } from 'zustand'

export type Theme = 'light' | 'dark'

/** 仅跨页会话状态;领域数据一律走 backend 契约,不入 store。 */
interface SessionState {
  activeBookId: number | null
  currentTaskId: number | null
  theme: Theme
  setActiveBookId: (id: number | null) => void
  setCurrentTaskId: (id: number | null) => void
  setTheme: (t: Theme) => void
}

export const useSession = create<SessionState>(set => ({
  activeBookId: null,
  currentTaskId: null,
  theme: 'light',
  setActiveBookId: activeBookId => set({ activeBookId }),
  setCurrentTaskId: currentTaskId => set({ currentTaskId }),
  setTheme: theme => {
    document.documentElement.setAttribute('data-theme', theme)
    set({ theme })
  },
}))
