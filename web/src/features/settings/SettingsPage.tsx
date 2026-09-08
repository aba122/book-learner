import { useCallback, useRef, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { AppSettings, Profile } from '../../types'

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: (id: string) => React.ReactNode
  hint?: string
}) {
  const id = `field-${label}`
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <label htmlFor={id} className="text-sm text-ink-2">
        {label}
      </label>
      <div className="flex flex-col items-end gap-1">
        {children(id)}
        {hint && <span role="alert" className="text-xs text-weak">{hint}</span>}
      </div>
    </div>
  )
}

const inputCls =
  'rounded-s border border-line bg-paper-1 px-3 py-1.5 text-sm text-ink-1 disabled:opacity-50'

type NumericField = 'pomodoroMinutes' | 'breakMinutes'
const NUMERIC_FIELDS: NumericField[] = ['pomodoroMinutes', 'breakMinutes']
const INVALID_HINT = '请输入正整数'

/** 数字字段以字符串草稿承载,避免清空即变 0(F10);仅正整数视为合法。 */
function parsePositiveInt(draft: string): number | null {
  return /^\d+$/.test(draft) && Number(draft) > 0 ? Number(draft) : null
}

interface LoadedSettings {
  settings: AppSettings
  version: number
}

/** 学习者画像(M2 T6):独立加载/保存;知识背景与个人情境可编辑,误区模式与已掌握概念由 AI 积累、只读展示 */
function ProfileSection() {
  const profile = useAsyncResource(useCallback(() => backend.profileGet(), []))
  if (profile.data === null) {
    return (
      <Card className="px-6 py-4">
        <h2 className="font-serif text-base font-semibold text-ink-1">学习者画像</h2>
        <div className="mt-3">
          {profile.error ? <AsyncError error={profile.error} onRetry={profile.reload} variant="compact" /> : <p className="text-sm text-ink-3">正在读取画像…</p>}
        </div>
      </Card>
    )
  }
  return <ProfileForm key={profile.version} initial={profile.data} />
}

function ProfileForm({ initial }: { initial: Profile }) {
  const [form, setForm] = useState<Profile>(initial)
  const [saved, setSaved] = useState(false)
  const save = useBackendOperation((snapshot: Profile) => backend.profileSave(snapshot), {
    onCommitted: async () => setSaved(true),
  })
  const saving = save.pending.has('profile')
  const failure = save.errors.get('profile')
  const update = (patch: Partial<Profile>) => {
    setForm(cur => ({ ...cur, ...patch }))
    setSaved(false)
  }
  const submit = () => {
    if (saving) return
    save.clearError('profile')
    void save.run('profile', form)
  }
  const areaCls = 'w-full rounded-s border border-line bg-paper-1 px-3 py-2 text-sm leading-relaxed text-ink-1 outline-none focus:border-new'
  return (
    <Card className="px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-serif text-base font-semibold text-ink-1">学习者画像</h2>
          <p className="mt-0.5 text-xs text-ink-3">写进记忆库 profile.md,AI 讲授与出题时固定参考;方法论书的情境化引导依赖"个人情境"。</p>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-ok">画像已保存</span>}
          <Button variant="primary" onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存画像'}</Button>
        </div>
      </div>
      {failure && <div className="mt-3"><AsyncError error={failure} onRetry={submit} variant="compact" /></div>}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-ink-2">
          知识背景
          <textarea rows={4} className={areaCls} value={form.background} onChange={e => update({ background: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-ink-2">
          个人情境
          <textarea rows={4} className={areaCls} value={form.context} onChange={e => update({ context: e.target.value })} />
        </label>
        <div className="flex flex-col gap-1 text-sm text-ink-2">
          已掌握概念(AI 积累,只读)
          <pre className="whitespace-pre-wrap rounded-s bg-paper-3/50 px-3 py-2 text-xs leading-relaxed text-ink-3">{form.mastered || '(尚无)'}</pre>
        </div>
        <div className="flex flex-col gap-1 text-sm text-ink-2">
          误区模式(AI 观察,只读)
          <pre className="whitespace-pre-wrap rounded-s bg-paper-3/50 px-3 py-2 text-xs leading-relaxed text-ink-3">{form.pitfalls || '(尚无)'}</pre>
        </div>
      </div>
    </Card>
  )
}

/** 以 key=version 重挂载:后端新数据到达即丢弃本地编辑(与旧行为一致),且无需 effect 内 setState。 */
function SettingsForm({ initial }: { initial: AppSettings }) {
  const [form, setForm] = useState<AppSettings>(initial)
  const [drafts, setDrafts] = useState<Record<NumericField, string>>({
    pomodoroMinutes: String(initial.pomodoroMinutes),
    breakMinutes: String(initial.breakMinutes),
  })
  const [saved, setSaved] = useState(false)
  const formRevision = useRef(0)

  const save = useBackendOperation((snapshot: AppSettings) => backend.saveSettings(snapshot))
  const saving = save.pending.has('save')
  const saveError = save.errors.get('save')

  const invalid = NUMERIC_FIELDS.filter(f => parsePositiveInt(drafts[f]) === null)
  const canSave = invalid.length === 0 && !saving

  const update = (patch: Partial<AppSettings>) => {
    formRevision.current += 1
    setForm(cur => ({ ...cur, ...patch }))
    setSaved(false)
  }
  const updateNumeric = (field: NumericField, draft: string) => {
    setDrafts(cur => ({ ...cur, [field]: draft }))
    const n = parsePositiveInt(draft)
    if (n !== null) update({ [field]: n })
    else {
      formRevision.current += 1
      setSaved(false)
    }
  }

  const submit = async () => {
    if (!canSave) return
    const snapshot = { ...form }
    const revision = formRevision.current
    save.clearError('save')
    setSaved(false)
    const result = await save.run('save', snapshot)
    // 保存期间若又有编辑,不宣称"已保存"
    if (result === 'ok' && revision === formRevision.current) setSaved(true)
  }

  return (
    <>
      <PageHeader
        title="设置"
        subtitle="节奏、路径与同步"
        actions={
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-ok">已保存</span>}
            <Button variant="primary" onClick={submit} disabled={!canSave}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      />
      <div className="flex flex-col gap-6">
        {saveError && <AsyncError error={saveError} onRetry={submit} />}
        <Card className="divide-y divide-line px-6 py-2">
          <Field label="番茄钟(分钟)" hint={invalid.includes('pomodoroMinutes') ? INVALID_HINT : undefined}>
            {id => (
              <input
                id={id}
                type="number"
                min={1}
                value={drafts.pomodoroMinutes}
                onChange={e => updateNumeric('pomodoroMinutes', e.target.value)}
                className={`${inputCls} w-24 text-right`}
              />
            )}
          </Field>
          <Field label="休息(分钟)" hint={invalid.includes('breakMinutes') ? INVALID_HINT : undefined}>
            {id => (
              <input
                id={id}
                type="number"
                min={1}
                value={drafts.breakMinutes}
                onChange={e => updateNumeric('breakMinutes', e.target.value)}
                className={`${inputCls} w-24 text-right`}
              />
            )}
          </Field>
          <Field label="提醒时间">
            {id => (
              <input
                id={id}
                type="time"
                value={form.remindTime}
                onChange={e => update({ remindTime: e.target.value })}
                className={inputCls}
              />
            )}
          </Field>
          <Field label="晚间提醒(当日未完成时)">
            {id => (
              <input
                id={id}
                type="time"
                value={form.eveningRemindTime}
                onChange={e => update({ eveningRemindTime: e.target.value })}
                className={inputCls}
              />
            )}
          </Field>
        </Card>

        <Card className="divide-y divide-line px-6 py-2">
          <Field label="Obsidian 仓库路径">
            {id => (
              <input
                id={id}
                type="text"
                value={form.obsidianVault}
                onChange={e => update({ obsidianVault: e.target.value })}
                className={`${inputCls} w-72`}
              />
            )}
          </Field>
          <Field label="codex CLI 路径">
            {id => (
              <input
                id={id}
                type="text"
                disabled
                placeholder="Mac 阶段配置"
                title="AI 后端接入随 Tauri 壳在 Mac 阶段完成"
                className={`${inputCls} w-72`}
              />
            )}
          </Field>
          <Field label="whisper 模型">
            {id => (
              <input
                id={id}
                type="text"
                disabled
                placeholder="Mac 阶段配置"
                title="语音输入随 whisper 在 Mac 阶段接入"
                className={`${inputCls} w-72`}
              />
            )}
          </Field>
          <Field label="记忆库 git 远程">
            {id => (
              <input
                id={id}
                type="text"
                disabled
                placeholder="Mac 阶段配置"
                title="学习记忆库 git 备份在 Mac 阶段接入"
                className={`${inputCls} w-72`}
              />
            )}
          </Field>
        </Card>
        <ProfileSection />
      </div>
    </>
  )
}

export default function SettingsPage() {
  const version = useRef(0)
  const loaded = useAsyncResource(
    useCallback(async (): Promise<LoadedSettings> => ({
      settings: await backend.getSettings(),
      version: ++version.current,
    }), []),
  )

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      {loaded.data === null ? (
        <>
          <PageHeader
            title="设置"
            subtitle="节奏、路径与同步"
            actions={<Button variant="primary" disabled>保存</Button>}
          />
          {loaded.error
            ? <AsyncError error={loaded.error} onRetry={loaded.reload} />
            : <p className="text-sm text-ink-3">正在读取设置…</p>}
        </>
      ) : (
        <>
          {loaded.error && (
            <div className="mb-6">
              <AsyncError error={loaded.error} onRetry={loaded.reload} variant="compact" />
            </div>
          )}
          <SettingsForm key={loaded.data.version} initial={loaded.data.settings} />
        </>
      )}
    </div>
  )
}
