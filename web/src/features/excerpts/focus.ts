import type { ExcerptFocus } from '../../types'

/** 书摘整理方式(BL-037)的名字:书摘页每本书标题下、导入向导与整理对话框共用 */
export const FOCUS_LABEL: Record<ExcerptFocus, string> = { ideas: '抓观点', writing: '学写法' }

/** 每种方式一句说明(选的时候显示) */
export const FOCUS_HINT: Record<ExcerptFocus, string> = {
  ideas: '挑结论、核心论点和重要段落,标签按主题分。适合社科、方法、教材类的书。',
  writing: '挑写得好的描写、修辞、叙述和对话,标签按手法分。适合小说、散文等文学书。',
}
