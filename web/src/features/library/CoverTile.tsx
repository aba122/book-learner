import { useState, type ReactNode } from 'react'
import { spineColor } from './coverSignature'

/**
 * 封面瓦片(BL-031):有封面图就铺满显示(本地 EPUB 抽出的 asset URL,或微信读书的外链),
 * 没有 / 加载失败 → 退回「首字 + 书脊色条」签名。3:4 固定比例,超出裁切。
 */
export default function CoverTile({ title, coverUrl, className = '', children }: { title: string; coverUrl: string | null; className?: string; children?: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = coverUrl && failed !== coverUrl ? coverUrl : null
  return (
    <div className={`relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-m border border-sep bg-card shadow-card ${className}`}>
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          data-testid="book-cover"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailed(src)}
        />
      ) : (
        <>
          <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${spineColor(title)}`} />
          <span aria-hidden className="font-serif text-[44px] font-semibold text-label-2">{[...title][0]}</span>
        </>
      )}
      {children}
    </div>
  )
}
