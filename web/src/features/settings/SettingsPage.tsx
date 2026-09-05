import { useCallback, useRef, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { AppSettings } from '../../types'

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
