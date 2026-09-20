/** 转圈(视觉改版第一批):必要反馈,标 data-motion-essential(减弱动态时只放慢不停止);有 label 时是 status */
export default function Spinner({ size = 16, label, className = '' }: { size?: 14 | 16 | 20; label?: string; className?: string }) {
  return (
    <span
      data-motion-essential
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`bl-spin inline-block shrink-0 rounded-full border-2 border-sep border-t-accent ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
