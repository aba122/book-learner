import { create } from 'zustand'
import { THEME_KEY } from './config'

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

/** 启动时从 localStorage 读回上次的模式(BL-003:夜读模式刷新/重开后失效);非法值回落 light。 */
function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
}
const initialTheme = readTheme()
applyTheme(initialTheme)

export const useSession = create<SessionState>(set => ({
  activeBookId: null,
  currentTaskId: null,
  theme: initialTheme,
  pendingNotice: null,
  setActiveBookId: activeBookId => set({ activeBookId }),
  setPendingNotice: pendingNotice => set({ pendingNotice }),
  setCurrentTaskId: currentTaskId => set({ currentTaskId }),
  setTheme: theme => {
    applyTheme(theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* 无持久化时只在本次生效 */
    }
    set({ theme })
  },
}))
