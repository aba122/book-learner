import { create } from 'zustand'

export type Theme = 'light' | 'dark'

/** 仅跨页会话状态;领域数据一律走 backend 契约,不入 store。 */
interface SessionState {
  activeBookId: number | null
  currentTaskId: number | null
  theme: Theme
  /** 一次性跨页提示(如:评估已保存但任务状态同步失败),由目标页展示后清除 */
  pendingNotice: string | null
  setActiveBookId: (id: number | null) => void
  setPendingNotice: (notice: string | null) => void
  setCurrentTaskId: (id: number | null) => void
  setTheme: (t: Theme) => void
}

export const useSession = create<SessionState>(set => ({
  activeBookId: null,
  currentTaskId: null,
  theme: 'light',
  pendingNotice: null,
  setActiveBookId: activeBookId => set({ activeBookId }),
  setPendingNotice: pendingNotice => set({ pendingNotice }),
  setCurrentTaskId: currentTaskId => set({ currentTaskId }),
  setTheme: theme => {
    document.documentElement.setAttribute('data-theme', theme)
    set({ theme })
  },
}))
