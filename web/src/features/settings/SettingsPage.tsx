import { useEffect, useState } from 'react'
import { backend } from '../../backend'
import Button from '../../components/Button'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import type { AppSettings } from '../../types'

function Field({
  label,
  children,
}: {
  label: string
  children: (id: string) => React.ReactNode
}) {
  const id = `field-${label}`
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <label htmlFor={id} className="text-sm text-ink-2">
        {label}
      </label>
      {children(id)}
    </div>
  )
}

const inputCls =
  'rounded-s border border-line bg-paper-1 px-3 py-1.5 text-sm text-ink-1 disabled:opacity-50'

export default function SettingsPage() {
  const [form, setForm] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    backend.getSettings().then(setForm)
  }, [])

  const update = (patch: Partial<AppSettings>) => {
    setForm(cur => (cur ? { ...cur, ...patch } : cur))
    setSaved(false)
  }

  const save = async () => {
    if (!form) return
    await backend.saveSettings(form)
    setSaved(true)
  }

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader
        title="设置"
        subtitle="节奏、路径与同步"
        actions={
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-ok">已保存</span>}
            <Button variant="primary" onClick={save} disabled={!form}>
              保存
            </Button>
          </div>
        }
      />

      {form === null ? (
        <p className="text-sm text-ink-3">正在读取设置…</p>
      ) : (
        <div className="flex flex-col gap-6">
          <Card className="divide-y divide-line px-6 py-2">
            <Field label="番茄钟(分钟)">
              {id => (
                <input
                  id={id}
                  type="number"
                  min={1}
                  value={form.pomodoroMinutes}
                  onChange={e => update({ pomodoroMinutes: Number(e.target.value) })}
                  className={`${inputCls} w-24 text-right`}
                />
              )}
            </Field>
            <Field label="休息(分钟)">
              {id => (
                <input
                  id={id}
                  type="number"
                  min={1}
                  value={form.breakMinutes}
                  onChange={e => update({ breakMinutes: Number(e.target.value) })}
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
      )}
    </div>
  )
}
