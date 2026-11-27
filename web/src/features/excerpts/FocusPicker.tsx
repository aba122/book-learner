import Segmented from '../../components/Segmented'
import type { ExcerptFocus } from '../../types'
import { FOCUS_HINT, FOCUS_LABEL } from './focus'

/** 选书摘按什么挑:单选分段控件 + 一句说明 */
export default function FocusPicker({ value, onChange }: { value: ExcerptFocus; onChange: (next: ExcerptFocus) => void }) {
  return (
    <div>
      <Segmented<ExcerptFocus>
        aria-label="书摘整理方式"
        value={value}
        onChange={onChange}
        options={[
          { value: 'ideas', label: FOCUS_LABEL.ideas },
          { value: 'writing', label: FOCUS_LABEL.writing },
        ]}
      />
      <p className="mt-2 text-callout leading-relaxed text-label-2" data-testid="focus-hint">{FOCUS_HINT[value]}</p>
    </div>
  )
}
