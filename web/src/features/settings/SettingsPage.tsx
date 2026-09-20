import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Confirm from '../../components/Confirm'
import Field from '../../components/Field'
import Input from '../../components/Input'
import PageHeader from '../../components/PageHeader'
import Segmented from '../../components/Segmented'
import Skeleton from '../../components/Skeleton'
import Textarea from '../../components/Textarea'
import Toolbar, { ToolbarSpacer } from '../../components/Toolbar'
import { localCalendarDate } from '../../lib/localDate'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import { useSession, type ThemePreference } from '../../store'
import type { AppSettings, BackupList, CodexBin, Profile } from '../../types'
import SettingsSection, { SettingsRow } from './SettingsSection'
import { SETTINGS_SECTIONS, sectionDomId, type SettingsSectionId } from './settingsSections'
import VoiceSection from './VoiceSection'

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

/** 左列分区导航(视觉改版第三批):点击滚到分区;滚动时由 IntersectionObserver 跟随(jsdom 无则只响应点击) */
function SectionNav({ active, onPick }: { active: SettingsSectionId; onPick: (id: SettingsSectionId) => void }) {
  return (
    <nav aria-label="设置分区" className="sticky top-0 hidden w-36 shrink-0 self-start @3xl:block">
      <ul className="flex flex-col gap-0.5">
        {SETTINGS_SECTIONS.map(s => (
          <li key={s.id}>
            <button
              type="button"
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => onPick(s.id)}
              className="flex h-7 w-full cursor-pointer items-center rounded-s px-2 text-body text-label-2 transition-colors duration-[var(--dur-fast)] hover:bg-fill-hover hover:text-label-1 aria-[current=true]:bg-fill-selected aria-[current=true]:text-label-1 aria-[current=true]:font-medium"
            >
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

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
    <SettingsSection
      id="data"
      title="数据"
      description="SQLite 每日首次启动与退出前自动快照(保留最近 7 份 + 近 3 个月各一份);恢复在下次启动时替换数据库,原库保留为 .replaced 文件。"
    >
      <SettingsRow label="快照">
        <Button size="sm" onClick={() => { snapshotOp.clearError('snapshot'); void snapshotOp.run('snapshot') }} disabled={busy}>{snapshotOp.pending.has('snapshot') ? '快照中…' : '立即快照'}</Button>
      </SettingsRow>
      {firstError && <div className="px-4 py-2"><AsyncError error={firstError} variant="compact" /></div>}
      {current === null ? (
        backups.error ? <div className="px-4 py-2"><AsyncError error={backups.error} onRetry={backups.reload} variant="compact" /></div> : <div aria-busy="true" className="px-4 py-3"><Skeleton lines={2} /></div>
      ) : (
        <>
          {current.pendingRestore && (
            <div role="status" className="flex items-center justify-between gap-3 bg-review-soft/50 px-4 py-2 text-callout text-label-1">
              <span>已登记恢复 <code className="font-mono">{current.pendingRestore}</code>,下次启动 app 时生效。</span>
              <Button size="sm" disabled={busy} onClick={() => void cancelOp.run('cancel')}>取消恢复</Button>
            </div>
          )}
          {current.snapshots.length === 0 ? (
            <p className="px-4 py-2.5 text-callout text-label-3">还没有快照;首次启动或退出时会自动生成。</p>
          ) : (
            <ul className="divide-y divide-sep">
              {current.snapshots.map(s => (
                <li key={s.name} className="flex min-h-[34px] items-center justify-between gap-4 px-4 py-1" data-testid="snapshot-row">
                  <span className="text-body text-label-1 tabular-nums">
                    {s.date}
                    <span className="ml-2 text-footnote text-label-3">{formatBytes(s.bytes)}</span>
                  </span>
                  <Button size="sm" disabled={busy || current.pendingRestore === s.name} onClick={() => setRestoreTarget(s.name)}>恢复</Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex flex-col gap-2 px-4 py-3">
        <div>
          <div className="text-body text-label-1">记忆库 git 远程</div>
          <p className="mt-0.5 text-footnote leading-relaxed text-label-3">每次学习提交后自动推送(失败按退避重试);保存时会以 ls-remote 校验。凭据/known_hosts 请先在终端完成一次。</p>
        </div>
        {remote.data === null && remote.error && <AsyncError error={remote.error} onRetry={remote.reload} variant="compact" />}
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            aria-label="记忆库 git 远程"
            type="text"
            value={currentUrl}
            placeholder="git@github.com:you/book-learner-memory.git"
            onChange={e => setUrlDraft(e.target.value)}
            className="min-w-0 flex-1 font-mono"
          />
          <Button size="sm" disabled={remoteOp.pending.has('remote')} onClick={() => { remoteOp.clearError('remote'); void remoteOp.run('remote', currentUrl) }}>{remoteOp.pending.has('remote') ? '校验中…' : '保存并校验'}</Button>
          <Button size="sm" disabled={pushOp.pending.has('push') || !currentUrl.trim()} onClick={() => { setPushMessage(null); void pushOp.run('push') }}>{pushOp.pending.has('push') ? '推送中…' : '立即推送'}</Button>
        </div>
        {remoteError && <AsyncError error={remoteError} variant="compact" />}
        {pushMessage && <p role="status" className="text-footnote text-label-2">{pushMessage}</p>}
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
    </SettingsSection>
  )
}

/** 诊断(测试阶段):版本 / git 提交 / 构建时间 / 数据与日志目录;报告问题时附上当天的 app.log.YYYY-MM-DD */
function DiagnosticsSection() {
  const info = useAsyncResource(useCallback(() => backend.appInfo(), []))
  const revealOp = useBackendOperation(async () => { await backend.appRevealLogs() })
  const data = info.data
  return (
    <SettingsSection
      id="diagnostics"
      title="诊断"
      description="遇到问题时,把日志目录里当天的 app.log.日期 文件连同现象一起反馈。日志只记录操作与错误元数据,不含复述正文,保留 14 天。"
      data-testid="diagnostics-section"
    >
      {data === null ? (
        info.error ? <div className="px-4 py-2"><AsyncError error={info.error} onRetry={info.reload} variant="compact" /></div> : <div aria-busy="true" className="px-4 py-3"><Skeleton lines={3} /></div>
      ) : (
        <dl className="divide-y divide-sep">
          <div className="flex min-h-[34px] items-center justify-between gap-6 px-4 py-1.5">
            <dt className="text-body text-label-2">版本</dt>
            <dd className="text-right text-body text-label-1" data-testid="app-version">{data.version} · {data.gitSha} · 构建于 {data.builtAt}</dd>
          </div>
          <div className="flex min-h-[34px] items-center justify-between gap-6 px-4 py-1.5">
            <dt className="shrink-0 text-body text-label-2">数据目录</dt>
            <dd className="min-w-0 text-right text-label-1"><code className="break-all font-mono text-footnote">{data.dataDir}</code></dd>
          </div>
          <div className="flex min-h-[34px] items-center justify-between gap-6 px-4 py-1.5">
            <dt className="shrink-0 text-body text-label-2">日志目录</dt>
            <dd className="min-w-0 text-right text-label-1"><code className="break-all font-mono text-footnote">{data.logDir}</code></dd>
          </div>
        </dl>
      )}
      <SettingsRow label="日志">
        {revealOp.errors.get('reveal') && <AsyncError error={revealOp.errors.get('reveal')!} variant="compact" />}
        <Button size="sm" disabled={revealOp.pending.has('reveal')} onClick={() => { revealOp.clearError('reveal'); void revealOp.run('reveal') }}>打开日志目录</Button>
      </SettingsRow>
    </SettingsSection>
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
    <Field label="codex 可执行路径" id="codex-bin" className="px-4">
      {ctl => (
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              {...ctl}
              type="text"
              value={value}
              placeholder="留空自动寻找,或填 /opt/homebrew/bin/codex"
              onChange={e => setDraft(e.target.value)}
              className="w-72 font-mono"
            />
            <Button
              size="sm"
              disabled={saveOp.pending.has('save') || draft === null}
              onClick={() => { saveOp.clearError('save'); void saveOp.run('save', value.trim() || null) }}
            >
              {saveOp.pending.has('save') ? '校验中…' : '保存路径'}
            </Button>
          </div>
          {error && <AsyncError error={error} variant="compact" />}
          {info.error && current === null && <AsyncError error={info.error} onRetry={info.reload} variant="compact" />}
          {!error && hint && <span data-testid="codex-status" className={`text-footnote ${current?.error ? 'text-weak' : 'text-label-3'}`}>{hint}</span>}
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
      <SettingsSection id="profile" title="学习者画像">
        <div className="px-4 py-3">
          {profile.error ? <AsyncError error={profile.error} onRetry={profile.reload} variant="compact" /> : <div aria-busy="true"><Skeleton lines={3} /></div>}
        </div>
      </SettingsSection>
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
  return (
    <SettingsSection
      id="profile"
      title="学习者画像"
      description="写进记忆库 profile.md,AI 讲授与出题时固定参考;方法论书的情境化引导依赖“个人情境”。"
      aside={
        <>
          {saved && <span className="text-footnote text-ok">画像已保存</span>}
          <Button size="sm" onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存画像'}</Button>
        </>
      }
    >
      {failure && <div className="px-4 py-2"><AsyncError error={failure} onRetry={submit} variant="compact" /></div>}
      <div className="grid grid-cols-1 gap-4 p-4 @2xl:grid-cols-2">
        <label className="flex flex-col gap-1 text-callout text-label-2">
          知识背景
          <Textarea rows={4} value={form.background} onChange={e => update({ background: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-callout text-label-2">
          个人情境
          <Textarea rows={4} value={form.context} onChange={e => update({ context: e.target.value })} />
        </label>
        <div className="flex flex-col gap-1 text-callout text-label-2">
          已掌握概念(AI 积累,只读)
          <pre className="whitespace-pre-wrap rounded-s bg-inset px-3 py-2 font-sans text-footnote leading-relaxed text-label-2">{form.mastered || '(尚无)'}</pre>
        </div>
        <div className="flex flex-col gap-1 text-callout text-label-2">
          误区模式(AI 观察,只读)
          <pre className="whitespace-pre-wrap rounded-s bg-inset px-3 py-2 font-sans text-footnote leading-relaxed text-label-2">{form.pitfalls || '(尚无)'}</pre>
        </div>
      </div>
    </SettingsSection>
  )
}

/** 外观(视觉改版第一批):跟随系统 / 浅色 / 深色,即时生效,不进保存快照(HIG:不做 app 级开关,手动覆盖放设置) */
function AppearanceRow() {
  const preference = useSession(s => s.themePreference)
  const setTheme = useSession(s => s.setTheme)
  return (
    <SettingsRow label="外观">
      <Segmented<ThemePreference>
        aria-label="外观"
        value={preference}
        onChange={setTheme}
        options={[
          { value: 'system', label: '跟随系统' },
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
        ]}
      />
    </SettingsRow>
  )
}

/** 页面骨架:工具栏带(右侧 已保存 + 保存)+ 滚动区(页头 + 左列分区导航 + 分区列表) */
function SettingsShell({ toolbar, children }: { toolbar: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="设置工具栏">
        <ToolbarSpacer />
        {toolbar}
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-y-auto @container" data-testid="settings-scroll">
        <div className="mx-auto w-full max-w-[56rem] px-8 pt-6 pb-16">
          <PageHeader title="设置" subtitle="节奏、路径与同步" />
          {children}
        </div>
      </div>
    </div>
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
  const [active, setActive] = useState<SettingsSectionId>('general')

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

  // 滚动跟随:哪个分区标题过了滚动区上沿 1/4 处,左列就点亮谁(jsdom 无 IntersectionObserver → 只响应点击)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const root = document.querySelector<HTMLElement>('[data-testid=settings-scroll]')
    const visible = new Map<string, number>()
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top)
          else visible.delete(e.target.id)
        }
        const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0]
        if (top) setActive(top[0].replace('settings-', '') as SettingsSectionId)
      },
      { root, rootMargin: '-25% 0px -60% 0px' },
    )
    for (const s of SETTINGS_SECTIONS) {
      const el = document.getElementById(sectionDomId(s.id))
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [])

  const pick = (id: SettingsSectionId) => {
    setActive(id)
    document.getElementById(sectionDomId(id))?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }

  return (
    <SettingsShell
      toolbar={
        <>
          {saved && <span className="text-footnote text-ok">已保存</span>}
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSave}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      {saveError && <div className="mb-6"><AsyncError error={saveError} onRetry={submit} /></div>}
      <div className="flex gap-8">
        <SectionNav active={active} onPick={pick} />
        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <SettingsSection id="general" title="通用" description="外观即时生效;节奏与提醒改完点右上「保存」。">
            <AppearanceRow />
            <Field label="番茄钟(分钟)" className="px-4" error={invalid.includes('pomodoroMinutes') ? INVALID_HINT : undefined}>
              {ctl => (
                <Input
                  {...ctl}
                  type="number"
                  min={1}
                  value={drafts.pomodoroMinutes}
                  onChange={e => updateNumeric('pomodoroMinutes', e.target.value)}
                  className="w-20 text-right"
                />
              )}
            </Field>
            <Field label="休息(分钟)" className="px-4" error={invalid.includes('breakMinutes') ? INVALID_HINT : undefined}>
              {ctl => (
                <Input
                  {...ctl}
                  type="number"
                  min={1}
                  value={drafts.breakMinutes}
                  onChange={e => updateNumeric('breakMinutes', e.target.value)}
                  className="w-20 text-right"
                />
              )}
            </Field>
            <Field label="提醒时间" className="px-4">
              {ctl => (
                <Input
                  {...ctl}
                  type="time"
                  value={form.remindTime}
                  onChange={e => update({ remindTime: e.target.value })}
                />
              )}
            </Field>
            <Field label="晚间提醒(当日未完成时)" className="px-4">
              {ctl => (
                <Input
                  {...ctl}
                  type="time"
                  value={form.eveningRemindTime}
                  onChange={e => update({ eveningRemindTime: e.target.value })}
                />
              )}
            </Field>
          </SettingsSection>

          <SettingsSection id="ai" title="AI 与导出" description="导出目标必须是已存在的 Obsidian 仓库目录;codex 路径留空即自动寻找。">
            <Field label="Obsidian 仓库路径" className="px-4">
              {ctl => (
                <Input
                  {...ctl}
                  type="text"
                  value={form.obsidianVault}
                  onChange={e => update({ obsidianVault: e.target.value })}
                  className="w-80 font-mono"
                />
              )}
            </Field>
            <CodexField />
          </SettingsSection>
          <VoiceSection />
          <ProfileSection />
          <DataSection />
          <DiagnosticsSection />
        </div>
      </div>
    </SettingsShell>
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

  if (loaded.data === null) {
    return (
      <SettingsShell toolbar={<Button variant="primary" size="sm" disabled>保存</Button>}>
        {loaded.error ? (
          <AsyncError error={loaded.error} onRetry={loaded.reload} />
        ) : (
          <div aria-busy="true" className="flex flex-col gap-8">
            {[0, 1, 2].map(i => (
              <div key={i} className="rounded-l border border-sep bg-card p-4">
                <Skeleton lines={3} />
              </div>
            ))}
          </div>
        )}
      </SettingsShell>
    )
  }
  return (
    <>
      {loaded.error && (
        <div className="px-8 pt-4">
          <AsyncError error={loaded.error} onRetry={loaded.reload} variant="compact" />
        </div>
      )}
      <SettingsForm key={loaded.data.version} initial={loaded.data.settings} />
    </>
  )
}
