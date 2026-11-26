import type { SpineChapter } from '../../types'
import { estimateMapMinutes, formatCharCount, formatEstimate } from './mapJob'

/**
 * 知识地图可选(BL-036):「要生成知识地图吗?」的说明——章数、字数、预计用时,以及不生成能做什么。
 * 导入向导抽完章节后、书架「生成知识地图」开始前共用;按钮由各自的对话框放在 footer。
 */
export default function MapChoice({ chapters }: { chapters: readonly SpineChapter[] }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="font-serif text-title3 text-label-1 tabular-nums" data-testid="map-estimate">
        {chapters.length} 章 · {formatCharCount(chapters)} · 生成地图{formatEstimate(estimateMapMinutes(chapters.length))}
      </p>
      <p className="text-body leading-relaxed text-label-2">
        知识地图把书拆成一个个知识块,用来做费曼讲授、排每日学习计划。生成时 AI 要逐章读一遍,这个窗口会一直显示进度,期间要开着攻书。
      </p>
      <p className="text-callout leading-relaxed text-label-3">
        不生成也能阅读、问书、做标记、整理书摘;以后想学了,在书架上这本书的「更多操作」里随时可以生成。
      </p>
    </div>
  )
}
