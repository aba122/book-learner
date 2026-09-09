import { useCallback, useRef, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Card from '../../components/Card'
import PageHeader from '../../components/PageHeader'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import Confirm from '../../components/Confirm'
import { localCalendarDate } from '../../lib/localDate'
import type { AppSettings, BackupList, CodexBin, Profile } from '../../types'
import VoiceSection from './VoiceSection'

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

const formatBytes = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** 数据安全(M3 T5):SQLite 快照(每日首次启动/退出前自动,可手动)、登记恢复(下次启动生效)、记忆库 git 远程与推送 */
function DataSection() {
  const backups = useAsyncResource(useCallback(() => backend.backupList(), []))
  const remote = useAsyncResource(useCallback(() => backend.gitRemoteGet(), []))
  const [list, setList] = useState<BackupList | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null)
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [pushMessage, setPushMessage] = useState<string | null>(null)
  const snapshotOp = useBackendOperation(async () => { await backend.backupSnapshotNow(localCalendarDate()); setList(await backend.backupList()) })
  const restoreOp = useBackendOperation(async (name: string) => { setList(await backend.backupRestore(name)) })
  const cancelOp = useBackendOperation(async () => { setList(await backend.backupCancelRestore()) })
  const remoteOp = useBackendOperation(async (url: string) => { const r = await backend.gitRemoteSet(url); setUrlDraft(r.url ?? '') })
  const pushOp = useBackendOperation(async () => {
    const r = await backend.gitPushNow()
    setPushMessage(r.pushed ? '已推送到远程' : `推送失败:${r.error ?? '未知原因'}`)
  })
  const current = list ?? backups.data
  const currentUrl = urlDraft ?? remote.data?.url ?? ''
  const busy = snapshotOp.pending.size > 0 || restoreOp.pending.size > 0 || cancelOp.pending.size > 0
  const firstError = snapshotOp.errors.get('snapshot') ?? restoreOp.errors.get('restore') ?? cancelOp.errors.get('cancel')
  const remoteError = remoteOp.errors.get('remote')
  return (
    <Card className="px-6 py-4">
      <h2 className="font-serif text-base font-semibold text-ink-1">数据</h2>
      <p className="mt-0.5 text-xs text-ink-3">SQLite 每日首次启动与退出前自动快照(保留最近 7 份 + 近 3 个月各一份);恢复在下次启动时替换数据库,原库保留为 .replaced 文件。</p>
      <div className="mt-4 flex items-center justify-between">
        <h3 className="text-sm text-ink-2">快照</h3>
        <Button onClick={() => { snapshotOp.clearError('snapshot'); void snapshotOp.run('snapshot') }} disabled={busy}>{snapshotOp.pending.has('snapshot') ? '快照中…' : '立即快照'}</Button>
      </div>
      {firstError && <div className="mt-2"><AsyncError error={firstError} variant="compact" /></div>}
      {current === null ? (
        backups.error ? <div className="mt-2"><AsyncError error={backups.error} onRetry={backups.reload} variant="compact" /></div> : <p className="mt-2 text-sm text-ink-3">正在读取快照…</p>
      ) : (
        <>
          {current.pendingRestore && (
            <div role="status" className="mt-2 flex items-center justify-between rounded-m bg-review-soft px-3 py-2 text-xs text-ink-2">
              <span>已登记恢复 <code>{current.pendingRestore}</code>,下次启动 app 时生效。</span>
              <Button className="px-2 py-1 text-xs" disabled={busy} onClick={() => void cancelOp.run('cancel')}>取消恢复</Button>
            </div>
          )}
          {current.snapshots.length === 0 ? (
            <p className="mt-2 text-sm text-ink-3">还没有快照;首次启动或退出时会自动生成。</p>
          ) : (
            <ul className="mt-2 divide-y divide-line text-sm">
              {current.snapshots.map(s => (
                <li key={s.name} className="flex items-center justify-between py-2" data-testid="snapshot-row">
                  <span className="text-ink-1">{s.date}<span className="ml-2 text-xs text-ink-4">{formatBytes(s.bytes)}</span></span>
                  <Button className="px-2 py-1 text-xs" disabled={busy || current.pendingRestore === s.name} onClick={() => setRestoreTarget(s.name)}>恢复</Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="mt-5 border-t border-line pt-4">
        <h3 className="text-sm text-ink-2">记忆库 git 远程</h3>
        <p className="mt-0.5 text-xs text-ink-3">每次学习提交后自动推送(失败按退避重试);保存时会以 ls-remote 校验。凭据/known_hosts 请先在终端完成一次。</p>
        {remote.data === null && remote.error && <div className="mt-2"><AsyncError error={remote.error} onRetry={remote.reload} variant="compact" /></div>}
        <div className="mt-2 flex items-center gap-3">
          <input
            aria-label="记忆库 git 远程"
            type="text"
            value={currentUrl}
            placeholder="git@github.com:you/book-learner-memory.git"
            onChange={e => setUrlDraft(e.target.value)}
            className={`${inputCls} flex-1`}
          />
          <Button disabled={remoteOp.pending.has('remote')} onClick={() => { remoteOp.clearError('remote'); void remoteOp.run('remote', currentUrl) }}>{remoteOp.pending.has('remote') ? '校验中…' : '保存并校验'}</Button>
          <Button disabled={pushOp.pending.has('push') || !currentUrl.trim()} onClick={() => { setPushMessage(null); void pushOp.run('push') }}>{pushOp.pending.has('push') ? '推送中…' : '立即推送'}</Button>
        </div>
        {remoteError && <div className="mt-2"><AsyncError error={remoteError} variant="compact" /></div>}
        {pushMessage && <p role="status" className="mt-2 text-xs text-ink-2">{pushMessage}</p>}
      </div>
      <Confirm
        open={restoreTarget !== null}
        title="恢复到这份快照?"
        message={`下次启动时用 ${restoreTarget ?? ''} 替换当前数据库;当前库会保留为 .replaced 文件,记忆库文件会按恢复后的数据重生。`}
        confirmText="登记恢复"
        cancelText="取消"
        danger
        onConfirm={() => { const name = restoreTarget; setRestoreTarget(null); if (name) { restoreOp.clearError('restore'); void restoreOp.run('restore', name) } }}
        onCancel={() => setRestoreTarget(null)}
      />
    </Card>
  )
}

/** 诊断(测试阶段):版本 / git 提交 / 构建时间 / 数据与日志目录;报告问题时附上当天的 app.log.YYYY-MM-DD */
function DiagnosticsSection() {
  const info = useAsyncResource(useCallback(() => backend.appInfo(), []))
  const revealOp = useBackendOperation(async () => { await backend.appRevealLogs() })
  const data = info.data
  return (
    <Card className="px-6 py-4" data-testid="diagnostics-section">
      <h2 className="font-serif text-base font-semibold text-ink-1">诊断</h2>
      <p className="mt-0.5 text-xs text-ink-3">遇到问题时,把日志目录里当天的 <code>app.log.日期</code> 文件连同现象一起反馈。日志只记录操作与错误元数据,不含复述正文,保留 14 天。</p>
      {data === null ? (
        info.error ? <div className="mt-2"><AsyncError error={info.error} onRetry={info.reload} variant="compact" /></div> : <p className="mt-2 text-sm text-ink-3">正在读取版本信息…</p>
      ) : (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-ink-3">版本</dt><dd className="text-ink-1" data-testid="app-version">{data.version} · {data.gitSha} · 构建于 {data.builtAt}</dd>
          <dt className="text-ink-3">数据目录</dt><dd className="break-all text-ink-1"><code className="text-xs">{data.dataDir}</code></dd>
          <dt className="text-ink-3">日志目录</dt><dd className="break-all text-ink-1"><code className="text-xs">{data.logDir}</code></dd>
        </dl>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button disabled={revealOp.pending.has('reveal')} onClick={() => { revealOp.clearError('reveal'); void revealOp.run('reveal') }}>打开日志目录</Button>
        {revealOp.errors.get('reveal') && <AsyncError error={revealOp.errors.get('reveal')!} variant="compact" />}
      </div>
    </Card>
  )
}

/** codex 可执行路径(M3 T6):留空按 PATH / Homebrew / nvm 自动寻找;填绝对路径时保存即校验可执行 */
function CodexField() {
  const info = useAsyncResource(useCallback(() => backend.codexBinGet(), []))
  const [draft, setDraft] = useState<string | null>(null)
  const [saved, setSaved] = useState<CodexBin | null>(null)
  const saveOp = useBackendOperation(async (path: string | null) => {
    const next = await backend.codexBinSet(path)
    setSaved(next)
    setDraft(null)
  })
  const current = saved ?? info.data
  const value = draft ?? current?.path ?? ''
  const error = saveOp.errors.get('save')
  const hint = current === null
    ? (info.error ? undefined : '正在检测…')
    : current.error
      ? `当前找不到 codex:${current.error}`
      : `当前使用 ${current.resolved ?? '未知'}`
  return (
    <Field label="codex 可执行路径">
      {id => (
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <input
              id={id}
              type="text"
              value={value}
              placeholder="留空自动寻找,或填 /opt/homebrew/bin/codex"
              onChange={e => setDraft(e.target.value)}
              className={`${inputCls} w-72`}
            />
            <Button
              disabled={saveOp.pending.has('save') || draft === null}
              onClick={() => { saveOp.clearError('save'); void saveOp.run('save', value.trim() || null) }}
            >
              {saveOp.pending.has('save') ? '校验中…' : '保存路径'}
            </Button>
          </div>
          {error && <AsyncError error={error} variant="compact" />}
          {info.error && current === null && <AsyncError error={info.error} onRetry={info.reload} variant="compact" />}
          {!error && hint && <span data-testid="codex-status" className={`text-xs ${current?.error ? 'text-weak' : 'text-ink-4'}`}>{hint}</span>}
        </div>
      )}
    </Field>
  )
}

/** 学习者画像(M2 T6):独立加载/保存;知识背景与个人情境可编辑,误区模式与已掌握概念由 AI 积累、只读展示 */
function ProfileSection() {
  // 与设置表单同款:以加载代次为 key 重挂载表单,后端新数据到达即丢弃本地编辑
  const generation = useRef(0)
  const profile = useAsyncResource(useCallback(async () => ({
    profile: await backend.profileGet(),
    version: ++generation.current,
  }), []))
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
  return <ProfileForm key={profile.data.version} initial={profile.data.profile} />
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
          <CodexField />
        </Card>
        <VoiceSection />
        <ProfileSection />
        <DataSection />
        <DiagnosticsSection />
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
