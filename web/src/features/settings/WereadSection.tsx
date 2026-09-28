import { useCallback, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Confirm from '../../components/Confirm'
import Field from '../../components/Field'
import Input from '../../components/Input'
import Skeleton from '../../components/Skeleton'
import Toggle from '../../components/Toggle'
import { formatDuration } from '../../lib/duration'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { WereadStatus } from '../../types'
import SettingsSection, { SettingsRow } from './SettingsSection'

export const WEREAD_KEY_PAGE = 'https://weread.qq.com/r/weread-skills'

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 设置 › 微信读书(BL-030,docs/design/2026-09-28-weread-sync.md):
 * 未连接 = 说明 + 打开官方获取页 + Key 密码框 + 连接并同步;已连接 = 状态行 / 立即同步 / 启动时自动同步 / 断开。
 * 失败原因来自 status.lastError(数据,不是异常):壳层会把异常消息替换成固定文案。
 */
export default function WereadSection() {
  const initial = useAsyncResource(useCallback(() => backend.wereadStatus(), []))
  const [current, setCurrent] = useState<WereadStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [purgeOpen, setPurgeOpen] = useState(false)
  const connectOp = useBackendOperation(async (key: string) => {
    const next = await backend.wereadConnect(key)
    setCurrent(next)
    if (next.connected) setKeyDraft('')
  })
  const syncOp = useBackendOperation(async () => setCurrent(await backend.wereadSync()))
  const autoOp = useBackendOperation(async (enabled: boolean) => setCurrent(await backend.wereadSetAutoSync(enabled)))
  const disconnectOp = useBackendOperation(async (purge: boolean) => {
    await backend.wereadDisconnect(purge)
    setCurrent(await backend.wereadStatus())
  })
  const openOp = useBackendOperation(async () => backend.wereadOpenKeyPage())
  const status = current ?? initial.data
  const busy = connectOp.pending.size > 0 || syncOp.pending.size > 0 || autoOp.pending.size > 0 || disconnectOp.pending.size > 0
  const opError = connectOp.errors.get('connect') ?? syncOp.errors.get('sync') ?? autoOp.errors.get('auto') ?? disconnectOp.errors.get('disconnect') ?? openOp.errors.get('open')

  return (
    <SettingsSection
      id="weread"
      title="微信读书"
      description="把微信读书的书架、进度与阅读时长同步进来(单向,只读你自己的数据;不上传本机内容,也不能写回)。"
      data-testid="weread-section"
    >
      {status === null ? (
        initial.error
          ? <div className="px-4 py-2"><AsyncError error={initial.error} onRetry={initial.reload} variant="compact" /></div>
          : <div aria-busy="true" className="px-4 py-3"><Skeleton lines={2} /></div>
      ) : !status.connected ? (
        <>
          <div className="flex flex-col gap-2 px-4 py-3">
            <p className="text-callout leading-relaxed text-label-2">
              在微信读书官方页面扫码生成 API Key(<code className="font-mono">wrk-</code> 开头),粘贴到下面即可。Key 只存在本机;同一页面可随时撤销。
            </p>
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={openOp.pending.has('open')} onClick={() => { openOp.clearError('open'); void openOp.run('open') }}>
                打开获取页面
              </Button>
              <code className="truncate font-mono text-footnote text-label-3">{WEREAD_KEY_PAGE}</code>
            </div>
          </div>
          <Field label="API Key" id="weread-key" className="px-4">
            {ctl => (
              <div className="flex items-center gap-2">
                <Input
                  {...ctl}
                  type="password"
                  autoComplete="off"
                  value={keyDraft}
                  placeholder="wrk-…"
                  onChange={e => setKeyDraft(e.target.value)}
                  className="w-72 font-mono"
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !keyDraft.trim()}
                  onClick={() => { connectOp.clearError('connect'); void connectOp.run('connect', keyDraft) }}
                >
                  {connectOp.pending.has('connect') ? '连接中…' : '连接并同步'}
                </Button>
              </div>
            )}
          </Field>
          {status.lastError && <p role="alert" className="px-4 pb-3 text-footnote text-weak" data-testid="weread-connect-error">{status.lastError}</p>}
          {opError && <div className="px-4 pb-3"><AsyncError error={opError} variant="compact" /></div>}
        </>
      ) : (
        <>
          <SettingsRow label="状态">
            <span className="text-callout text-label-2" data-testid="weread-status">
              电子书 {status.bookCount} 本 · 已关联 {status.linkedCount} 本
              {status.albumCount > 0 && ` · 专辑 ${status.albumCount}`}
              {status.totalSeconds > 0 && ` · 累计 ${formatDuration(status.totalSeconds)}`}
            </span>
          </SettingsRow>
          <SettingsRow label="上次同步">
            <span className={`text-callout ${status.lastSyncOk === false ? 'text-weak' : 'text-label-2'}`} data-testid="weread-last-sync">
              {status.syncing || syncOp.pending.has('sync')
                ? '同步中…'
                : status.lastSyncAt
                  ? `${fmtTime(status.lastSyncAt)} · ${status.lastSyncOk === false ? '失败' : '成功'}`
                  : '还没同步过'}
            </span>
            <Button size="sm" disabled={busy || status.syncing} onClick={() => { syncOp.clearError('sync'); void syncOp.run('sync') }}>
              {syncOp.pending.has('sync') ? '同步中…' : '立即同步'}
            </Button>
          </SettingsRow>
          {status.lastError && <p role="status" className="px-4 py-2 text-footnote text-weak" data-testid="weread-sync-error">{status.lastError}</p>}
          {status.upgradeMessage && (
            <p role="status" className="bg-review-soft/50 px-4 py-2 text-footnote text-label-1" data-testid="weread-upgrade">
              微信读书提示升级:{status.upgradeMessage}
            </p>
          )}
          <SettingsRow label="启动时自动同步">
            <Toggle
              label="启动时自动同步"
              checked={status.autoSync}
              disabled={busy}
              onChange={next => { autoOp.clearError('auto'); void autoOp.run('auto', next) }}
            />
          </SettingsRow>
          <SettingsRow label="断开连接">
            <Button size="sm" disabled={busy} onClick={() => { disconnectOp.clearError('disconnect'); void disconnectOp.run('disconnect', false) }}>
              断开(保留数据)
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setPurgeOpen(true)}>
              断开并清除数据
            </Button>
          </SettingsRow>
          {opError && <div className="px-4 pb-3"><AsyncError error={opError} variant="compact" /></div>}
          <Confirm
            open={purgeOpen}
            title="断开微信读书并清除已同步数据?"
            message="会删掉本机保存的 Key,以及已同步的书架、进度与阅读时长;本地 EPUB、高亮与本机计时不受影响。"
            confirmText="断开并清除"
            cancelText="取消"
            danger
            onConfirm={() => { setPurgeOpen(false); disconnectOp.clearError('disconnect'); void disconnectOp.run('disconnect', true) }}
            onCancel={() => setPurgeOpen(false)}
          />
        </>
      )}
    </SettingsSection>
  )
}
