import { useEffect } from 'react'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { backend } from './backend'
import FeynmanPage from './features/feynman/FeynmanPage'
import LibraryPage from './features/library/LibraryPage'
import MapPage from './features/map/MapPage'
import ReaderPage from './features/reader/ReaderPage'
import SettingsPage from './features/settings/SettingsPage'
import StatsPage from './features/stats/StatsPage'
import TodayPage from './features/today/TodayPage'
import { useSession } from './store'

function Sidebar() {
  const activeBookId = useSession(s => s.activeBookId)
  const theme = useSession(s => s.theme)
  const setTheme = useSession(s => s.setTheme)

  const items = [
    { to: '/', label: '今日学习', end: true },
    { to: '/library', label: '书架', end: true },
    { to: activeBookId ? `/map/${activeBookId}` : '/library', label: '知识地图', end: false },
    { to: '/stats', label: '统计', end: true },
    { to: '/settings', label: '设置', end: true },
  ]

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-paper-2/60 px-4 py-8">
      <div className="mb-10 px-4">
        <div className="font-serif text-[1.6rem] font-bold tracking-[0.35em] text-ink-1">攻书</div>
        <div className="mt-1 text-[11px] tracking-[0.18em] text-ink-4 uppercase">book-learner</div>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {items.map(item => (
          <NavLink key={item.label} to={item.to} end={item.end}>
            {({ isActive }) => (
              <span
                className={`flex items-center gap-3 rounded-m px-4 py-2.5 text-sm transition-colors duration-150 ${
                  isActive
                    ? 'bg-paper-3 font-medium text-ink-1'
                    : 'text-ink-3 hover:bg-paper-3/50 hover:text-ink-1'
                }`}
              >
                <span
                  aria-hidden
                  className={`h-4 w-0.5 rounded-full ${isActive ? 'bg-weak' : 'bg-transparent'}`}
                />
                {item.label}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <button
        className="mt-6 cursor-pointer rounded-m border border-line px-4 py-2 text-xs text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink-1"
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      >
        {theme === 'light' ? '◐ 夜读模式' : '◑ 日读模式'}
      </button>
    </aside>
  )
}

export default function App() {
  const setActiveBookId = useSession(s => s.setActiveBookId)

  useEffect(() => {
    backend.listBooks().then(books => {
      const active = books.find(b => b.status === 'active')
      if (active) setActiveBookId(active.id)
    })
  }, [setActiveBookId])

  return (
    <BrowserRouter>
      <div className="flex h-full">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/map/:bookId" element={<MapPage />} />
            <Route path="/reader/:blockId" element={<ReaderPage />} />
            <Route path="/feynman/:taskId" element={<FeynmanPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
