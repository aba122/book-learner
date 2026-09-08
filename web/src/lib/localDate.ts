/** DEV-only 受控测试日期(M8.0):`localStorage.setItem('bookLearner.testDate', 'YYYY-MM-DD')` 后刷新即生效;生产构建忽略 */
export const TEST_DATE_KEY = 'bookLearner.testDate'
const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 读 window.localStorage 而非裸 globalThis.localStorage:Node ≥ 25 的实验性全局在未开 --localstorage-file 时为 undefined,会遮住 jsdom */
function devTestDateOverride(): string | null {
  if (!import.meta.env.DEV) return null
  try {
    const value = (typeof window === 'undefined' ? undefined : window.localStorage)?.getItem(TEST_DATE_KEY)
    return value && CALENDAR_DAY_RE.test(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 本地日历日(YYYY-MM-DD)。所有 command 的 `date` 都由此提供,core 不读系统时间。
 * 不传参时(="今天")在 DEV 构建下可被受控测试日期覆盖;显式传入的日期不受影响。
 */
export function localCalendarDate(date?: Date): string {
  if (date === undefined) {
    const override = devTestDateOverride()
    if (override) return override
  }
  const actual = date ?? new Date()
  const year = actual.getFullYear()
  const month = String(actual.getMonth() + 1).padStart(2, '0')
  const day = String(actual.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
