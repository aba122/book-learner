/** 秒 → 「x 小时 y 分」/「y 分」;不到一分钟且大于 0 显示「不到 1 分」;0 显示「0 分」 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0 分'
  if (seconds < 60) return '不到 1 分'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m} 分`
  if (m === 0 || m === 60) return `${m === 60 ? h + 1 : h} 小时`
  return `${h} 小时 ${m} 分`
}
