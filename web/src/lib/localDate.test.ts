import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEST_DATE_KEY, localCalendarDate } from './localDate'

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
  afterEach(() => {
    window.localStorage.removeItem(TEST_DATE_KEY)
    vi.unstubAllEnvs()
  })

  it('overrides "today" in DEV when the key holds a calendar day, but never an explicit date', () => {
    vi.stubEnv('DEV', true)
    window.localStorage.setItem(TEST_DATE_KEY, '2026-09-10')
    expect(localCalendarDate()).toBe('2026-09-10')
    expect(localCalendarDate(new Date(2026, 0, 2, 12))).toBe('2026-01-02')
  })

  it('ignores malformed values and is inert in production builds', () => {
    vi.stubEnv('DEV', true)
    window.localStorage.setItem(TEST_DATE_KEY, 'tomorrow')
    expect(localCalendarDate()).toBe(localCalendarDate(new Date()))

    vi.stubEnv('DEV', false)
    window.localStorage.setItem(TEST_DATE_KEY, '2026-09-10')
    expect(localCalendarDate()).toBe(localCalendarDate(new Date()))
  })
})
