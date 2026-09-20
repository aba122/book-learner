/** 骨架占位(视觉改版第一批):加载时立刻出现;减弱动态时全局守卫会停掉脉冲,留静态灰块 */
export default function Skeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  const widths = ['w-11/12', 'w-4/5', 'w-2/3', 'w-3/4', 'w-1/2']
  return (
    <div aria-hidden className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`h-3 animate-pulse rounded-s bg-fill-active ${widths[i % widths.length]}`} />
      ))}
    </div>
  )
}
