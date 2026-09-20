/** 设置页分区清单(左列导航与分区 id 共用;单独成文件是为了 Fast Refresh 只导出组件的规则) */
export const SETTINGS_SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'ai', label: 'AI 与导出' },
  { id: 'voice', label: '语音' },
  { id: 'profile', label: '画像' },
  { id: 'data', label: '数据' },
  { id: 'diagnostics', label: '诊断' },
] as const
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

export const sectionDomId = (id: SettingsSectionId) => `settings-${id}`
