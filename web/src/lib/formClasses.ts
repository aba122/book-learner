/** 表单控件共用类(视觉改版第一批):高 28,内嵌浅阴影;焦点用 3px 强调环(不再 outline-none 抹掉焦点指示) */
export const INPUT_CLASS =
  'rounded-s border border-sep bg-card text-label-1 shadow-[inset_0_1px_0_rgb(0_0_0/0.03)] placeholder:text-label-3 outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent/35 disabled:opacity-50 aria-invalid:border-weak'

export const INPUT_SIZE = {
  md: 'h-7 px-2.5 text-body',
  sm: 'h-6 px-2 text-callout',
} as const
