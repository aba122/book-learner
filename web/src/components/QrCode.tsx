import { encode } from 'uqr'

/**
 * 二维码(BL-032 手机配对):uqr 只做编码,模块矩阵自己画成一条 SVG path(不走 innerHTML)。
 * 固定白底黑码、四周留 2 格静区:深色主题下也是标准码,相机识别最稳。
 */
export default function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const { data, size: modules } = encode(value, { ecc: 'M', border: 2 })
  const cells: string[] = []
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) cells.push(`M${x} ${y}h1v1h-1z`)
    }),
  )
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      className="rounded-s"
      data-testid="qr-code"
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={cells.join('')} fill="#111111" />
    </svg>
  )
}
