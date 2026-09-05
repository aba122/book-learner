import type { MapProgress } from '../../types'

/** 地图作业进度 → 导入向导文案(纯函数,便于页面与测试共用) */
export function progressLabel(p: MapProgress): string {
  switch (p.stage) {
    case 'chapter':
      return `正在分析第 ${p.index + 1}/${p.total} 章:${p.title}`
    case 'merging':
      return '正在整合知识地图…'
    case 'done':
      return `已生成 ${p.blocks} 个知识块`
  }
}
