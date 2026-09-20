/** 开关(视觉改版第一批):role=switch,26×15 轨 + 13px 钮,选中用强调色 */
export default function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  className = '',
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[15px] w-[26px] shrink-0 cursor-pointer items-center rounded-full border border-sep-strong bg-sep-strong transition-colors duration-[var(--dur-fast)] aria-checked:border-accent aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      <span
        aria-hidden
        className={`absolute top-1/2 size-[13px] -translate-y-1/2 rounded-full bg-knob shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-[var(--dur-fast)] ${checked ? 'translate-x-[11px]' : 'translate-x-0'}`}
      />
    </button>
  )
}
