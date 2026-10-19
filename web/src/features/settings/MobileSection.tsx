import { useCallback, useState } from 'react'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Confirm from '../../components/Confirm'
import Field from '../../components/Field'
import Input from '../../components/Input'
import QrCode from '../../components/QrCode'
import Segmented from '../../components/Segmented'
import Skeleton from '../../components/Skeleton'
import Toggle from '../../components/Toggle'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { MobileBind, MobileServerStatus } from '../../types'
import SettingsSection, { SettingsRow } from './SettingsSection'

const BIND_OPTIONS: { value: MobileBind; label: string }[] = [
  { value: 'loopback', label: '经 Tailscale' },
  { value: 'lan', label: '局域网' },
]

/**
 * 设置 › 手机访问(BL-032 第一阶段,docs/design/2026-10-02-mobile-phase1.md):
 * Mac 上:开关、端口、绑定方式、Tailscale 地址与一次性配置命令、配对二维码 / 复制令牌 / 换新令牌。
 * 手机上(页面经 HTTP 打开):只读——关服务/换端口会切断自己,配对在 Mac 上管理。
 * 失败原因来自 status.error(数据,不是异常)。
 */
export default function MobileSection() {
  const remote = backend.runtime === 'http'
  const initial = useAsyncResource(useCallback(() => backend.mobileServerStatus(), []))
  const [current, setCurrent] = useState<MobileServerStatus | null>(null)
  const [portDraft, setPortDraft] = useState<string | null>(null)
  const [bindDraft, setBindDraft] = useState<MobileBind | null>(null)
  const [showQr, setShowQr] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [copied, setCopied] = useState<'command' | 'token' | null>(null)
  const status = current ?? initial.data

  const setOp = useBackendOperation(async (enabled: boolean, port: number, bind: MobileBind) => {
    const next = await backend.mobileServerSet(enabled, port, bind)
    setCurrent(next)
    setPortDraft(null)
    setBindDraft(null)
  })
  const rotateOp = useBackendOperation(async () => {
    await backend.mobileServerRotateToken()
    setCurrent(await backend.mobileServerStatus())
    setShowQr(true)
  })
  const busy = setOp.pending.size > 0 || rotateOp.pending.size > 0
  const opError = setOp.errors.get('set') ?? rotateOp.errors.get('rotate')

  const port = portDraft ?? String(status?.port ?? 7340)
  const portValid = /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535
  const bind = bindDraft ?? status?.bind ?? 'loopback'
  const dirty = status !== null && (Number(port) !== status.port || bind !== status.bind)
  const apply = (enabled: boolean) => {
    if (!portValid) return
    setOp.clearError('set')
    void setOp.run('set', enabled, Number(port), bind)
  }
  const rotate = () => {
    setConfirmRotate(false)
    rotateOp.clearError('rotate')
    void rotateOp.run('rotate')
  }
  const copyText = (text: string, what: 'command' | 'token') => {
    void navigator.clipboard?.writeText?.(text)?.then(() => setCopied(what))
  }

  return (
    <SettingsSection
      id="mobile"
      title="手机访问"
      description="在 iPhone 上用 Safari 打开攻书,用的就是这台 Mac 上的这一份数据;Mac 需要开着且不休眠。"
      data-testid="mobile-section"
    >
      {status === null ? (
        initial.error
          ? <div className="px-4 py-2"><AsyncError error={initial.error} onRetry={initial.reload} variant="compact" /></div>
          : <div aria-busy="true" className="px-4 py-3"><Skeleton lines={2} /></div>
      ) : remote ? (
        <SettingsRow label="状态">
          <span className="text-callout text-label-2" data-testid="mobile-remote">已从手机连接;开关、端口与配对请在 Mac 上管理</span>
        </SettingsRow>
      ) : (
        <>
          <SettingsRow label="允许手机访问">
            <Toggle label="允许手机访问" checked={status.enabled} disabled={busy || (!status.enabled && !portValid)} onChange={next => apply(next)} />
          </SettingsRow>
          <SettingsRow label="状态">
            <span className={`text-callout ${status.error ? 'text-weak' : 'text-label-2'}`} data-testid="mobile-status">
              {status.error ?? (status.running ? `运行中 · ${status.localUrl}` : status.enabled ? '未运行' : '已关闭')}
            </span>
          </SettingsRow>
          <Field label="端口" id="mobile-port" className="px-4" error={portValid ? undefined : '端口需在 1024–65535 之间'}>
            {ctl => (
              <div className="flex items-center gap-2">
                <Segmented<MobileBind> aria-label="访问方式" size="sm" value={bind} onChange={setBindDraft} options={BIND_OPTIONS} />
                <Input {...ctl} type="number" min={1024} max={65535} value={port} onChange={e => setPortDraft(e.target.value)} className="w-24 text-right" />
                <Button size="sm" disabled={busy || !dirty || !portValid} onClick={() => apply(status.enabled)}>
                  应用
                </Button>
              </div>
            )}
          </Field>
          <div className="flex flex-col gap-2 px-4 py-3 text-callout leading-relaxed text-label-2" data-testid="mobile-access">
            {bind === 'lan' ? (
              <p>局域网模式:手机和 Mac 连同一个 Wi-Fi,在 Safari 打开 <code className="font-mono">{status.localUrl}</code>。没有 HTTPS,Safari 不给麦克风,语音输入不可用。</p>
            ) : status.tailscaleUrl ? (
              <>
                <p>
                  手机访问地址:<code className="font-mono text-label-1">{status.tailscaleUrl}</code>(手机上也装 Tailscale、登录同一账号;任何网络下可用)。
                </p>
                <p>首次使用前,在 Mac 的终端里执行一次(之后一直生效):</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-s bg-inset px-2 py-1 font-mono text-footnote text-label-1">{status.serveCommand}</code>
                  <Button size="sm" onClick={() => copyText(status.serveCommand, 'command')}>{copied === 'command' ? '已复制' : '复制'}</Button>
                </div>
              </>
            ) : (
              <p>
                没检测到 Tailscale。在 Mac 和 iPhone 上都装 Tailscale 并登录同一账号,手机就能在任何网络下用 HTTPS 访问(语音输入需要 HTTPS);或改用「局域网」。
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-body text-label-1">配对</div>
                <p className="mt-0.5 text-footnote leading-relaxed text-label-3">
                  手机 Safari 扫码即可打开并配好。「添加到主屏幕」后的攻书与 Safari 不共享登录,第一次打开要再配一次:点「复制令牌」(通用剪贴板会同步到 iPhone),在手机的配对页粘贴。
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {status.tokenSet ? (
                  <>
                    <Button size="sm" variant="primary" disabled={busy || !status.enabled} aria-expanded={showQr} onClick={() => setShowQr(v => !v)}>
                      {showQr ? '收起二维码' : '显示配对二维码'}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => setConfirmRotate(true)}>
                      {rotateOp.pending.has('rotate') ? '生成中…' : '换新令牌'}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="primary" disabled={busy || !status.enabled} onClick={rotate}>
                    {rotateOp.pending.has('rotate') ? '生成中…' : '生成配对二维码'}
                  </Button>
                )}
              </div>
            </div>
            {!status.enabled && <p className="text-footnote text-label-3">先打开「允许手机访问」。</p>}
            {showQr && status.enabled && status.pairUrl && status.token && (
              <div className="flex flex-col items-center gap-2 rounded-m bg-inset p-4" data-testid="mobile-pairing">
                <QrCode value={status.pairUrl} label="手机配对二维码" />
                <code className="max-w-full break-all text-center font-mono text-footnote text-label-1 select-all" data-testid="mobile-token">{status.token}</code>
                <Button size="sm" onClick={() => copyText(status.token!, 'token')}>{copied === 'token' ? '已复制' : '复制令牌'}</Button>
              </div>
            )}
          </div>
          {opError && <div className="px-4 pb-3"><AsyncError error={opError} variant="compact" /></div>}
          <Confirm
            open={confirmRotate}
            title="生成新的配对二维码?"
            message="旧令牌会立即失效,已经配对的手机需要重新扫码。"
            confirmText="生成新的"
            cancelText="取消"
            onConfirm={rotate}
            onCancel={() => setConfirmRotate(false)}
          />
        </>
      )}
    </SettingsSection>
  )
}
