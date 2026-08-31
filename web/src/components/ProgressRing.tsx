export default function ProgressRing({
  value,
  size = 64,
  stroke = 5,
  color = 'var(--c-new)',
  label,
}: {
  /** 0–1 */
  value: number
  size?: number
  stroke?: number
  color?: string
  label?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(1, value))
  return (
    <svg
      width={size}
      height={size}
      role="img"
      aria-label={label ?? `进度 ${Math.round(clamped * 100)}%`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--paper-3)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 400ms ease' }}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fill="var(--ink-2)"
        style={{ font: `600 ${size / 4.6}px var(--font-sans)` }}
      >
        {label ?? `${Math.round(clamped * 100)}%`}
      </text>
    </svg>
  )
}
