import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localCalendarDate } from './localDate'

describe('localCalendarDate', () => {
  it('formats the local calendar day when it differs from the UTC day', () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const expectedByTimeZone: Record<string, string[]> = {
      'Asia/Shanghai': ['2026-03-08', '2026-03-09'],
      'America/Los_Angeles': ['2026-03-07', '2026-03-08'],
    }
    const expected = expectedByTimeZone[timeZone]

    expect(expected).toBeDefined()
    expect([
      localCalendarDate(new Date('2026-03-08T00:30:00.000Z')),
      localCalendarDate(new Date('2026-03-08T16:30:00.000Z')),
    ]).toEqual(expected)
  })

  it('uses the local day on a daylight-saving transition date', () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const expectedByTimeZone: Record<string, string> = {
      'Asia/Shanghai': '2026-03-08',
      'America/Los_Angeles': '2026-03-08',
    }

    expect(localCalendarDate(new Date('2026-03-08T09:30:00.000Z')))
      .toBe(expectedByTimeZone[timeZone])
  })
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
