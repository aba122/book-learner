import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEST_DATE_KEY, addCalendarDays, localCalendarDate } from './localDate'

describe('localCalendarDate', () => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  it('formats a date from its local calendar fields in any host time zone', () => {
    const localDate = new Date(2026, 0, 2, 12)

    expect(localCalendarDate(localDate)).toBe(
      `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`,
    )
  })

  it.runIf(timeZone === 'Asia/Shanghai')('uses Shanghai day when UTC is still the previous day', () => {
    const instant = new Date('2026-03-08T16:30:00.000Z')

    expect(instant.toISOString().slice(0, 10)).toBe('2026-03-08')
    expect(localCalendarDate(instant)).toBe('2026-03-09')
  })

  it.runIf(timeZone === 'America/Los_Angeles')(
    'uses the Los Angeles DST transition day after UTC crosses midnight',
    () => {
      const instant = new Date('2026-03-09T06:30:00.000Z')

      expect(instant.toISOString().slice(0, 10)).toBe('2026-03-09')
      expect(localCalendarDate(instant)).toBe('2026-03-08')
    },
  )
})

describe('calendar-day consumers', () => {
  it.each([
    '../features/today/TodayPage.tsx',
    '../features/map/MapPage.tsx',
    '../features/feynman/FeynmanPage.tsx',
  ])('%s does not derive a day through UTC', sourcePath => {
    const source = readFileSync(fileURLToPath(new URL(sourcePath, import.meta.url)), 'utf8')
    expect(source).not.toContain('toISOString().slice(0, 10)')
  })
})

describe('DEV-only controlled test date (M8.0)', () => {
  // 不依赖运行环境的 localStorage:Node ≥ 25 的实验性全局在未开 --localstorage-file 时为 undefined,
  // 且会遮住 vitest jsdom 的实现(window 即 globalThis);用内存 Storage 注入
  const memory = new Map<string, string>()
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value) },
    removeItem: (key: string) => { memory.delete(key) },
  }
  afterEach(() => {
    memory.clear()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('overrides "today" in DEV when the key holds a calendar day, but never an explicit date', () => {
    vi.stubGlobal('localStorage', storage)
    vi.stubEnv('DEV', true)
    storage.setItem(TEST_DATE_KEY, '2026-09-10')
    expect(localCalendarDate()).toBe('2026-09-10')
    expect(localCalendarDate(new Date(2026, 0, 2, 12))).toBe('2026-01-02')
  })

  it('ignores malformed values, a missing storage, and is inert in production builds', () => {
    vi.stubGlobal('localStorage', storage)
    vi.stubEnv('DEV', true)
    storage.setItem(TEST_DATE_KEY, 'tomorrow')
    expect(localCalendarDate()).toBe(localCalendarDate(new Date()))

    storage.setItem(TEST_DATE_KEY, '2026-09-10')
    vi.stubEnv('DEV', false)
    expect(localCalendarDate()).toBe(localCalendarDate(new Date()))

    vi.stubEnv('DEV', true)
    vi.stubGlobal('localStorage', undefined)
    expect(localCalendarDate()).toBe(localCalendarDate(new Date()))
  })
})

describe('addCalendarDays', () => {
  it('crosses month and year ends by calendar fields', () => {
    expect(addCalendarDays('2026-09-08', 2)).toBe('2026-09-10')
    expect(addCalendarDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addCalendarDays('2026-09-08', 0)).toBe('2026-09-08')
  })
})
