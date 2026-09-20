import { ICON_PATHS, type IconName, type IconPath } from './paths'

interface Props {
  name: IconName
  /** 数字为 px;默认 1em 跟随相邻文字 */
  size?: number | string
  /** 有 label 时作为独立图像(role=img);无 label 时视为装饰(aria-hidden) */
  label?: string
  strokeWidth?: 1.5 | 1.75 | 2
  className?: string
}

/**
 * 线性图标(SF Symbols 风格,自绘):`vector-effect: non-scaling-stroke` 让任何尺寸都保持 1.5px 物理笔画,
 * 与相邻 13px 系统字的字重匹配;颜色跟随 currentColor。
 */
export default function Icon({ name, size = '1em', label, strokeWidth = 1.5, className = '' }: Props) {
  const icon: IconPath = ICON_PATHS[name]
  return (
    <svg
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={icon.fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      className={`inline-block shrink-0 align-[-0.125em] ${className}`}
    >
      {icon.d.map(d => (
        <path key={d} d={d} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  )
}
