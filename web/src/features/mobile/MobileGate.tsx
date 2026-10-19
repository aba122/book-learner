import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { BackendError } from '../../backend/errors'
import { pairTokenFromHash, pairWithToken, pingServer, UNPAIRED_EVENT } from '../../backend/http'
import Button from '../../components/Button'
import Card from '../../components/Card'
import Input from '../../components/Input'
import Spinner from '../../components/Spinner'

type GateState = 'checking' | 'paired' | 'unpaired' | 'offline'

/**
 * 手机访问的配对门(BL-032 M2):只在页面由 Mac 攻书的 HTTP 服务分发时挂。
 * 启动时:地址带 `#pair=<令牌>`(Mac 设置页二维码)→ 先配对并清掉片段;再探活看是否已配对。
 * 已配对才渲染整个 app(避免各页首载先撞一串 401);之后任一请求 401(令牌被换)→ 回到配对页。
 */
export default function MobileGate({ children }: { children: ReactNode }) {
  // 探活(+ 二维码地址里的令牌先配对);失败 → offline,重试 = reload
  const probe = useAsyncResource(useCallback(async () => {
    let hashError: string | null = null
    const fromHash = pairTokenFromHash(globalThis.location?.hash ?? '')
    if (fromHash) {
      globalThis.history?.replaceState(null, '', `${location.pathname}${location.search}`)
      if (!(await pairWithToken(fromHash))) hashError = '二维码里的令牌已失效,请在 Mac 上重新生成'
    }
    const ping = await pingServer()
    return { paired: ping.paired, hashError }
  }, []))
  /** 手动配对成功 / 运行中被 401 踢回,覆盖探活结果 */
  const [override, setOverride] = useState<'paired' | 'unpaired' | null>(null)
  const [pairError, setPairError] = useState<string | null>(null)

  useEffect(() => {
    const onUnpaired = () => {
      setPairError('Mac 上的令牌换过了,请重新配对')
      setOverride('unpaired')
    }
    globalThis.addEventListener?.(UNPAIRED_EVENT, onUnpaired)
    return () => globalThis.removeEventListener?.(UNPAIRED_EVENT, onUnpaired)
  }, [])

  const state: GateState = override
    ?? (probe.loading ? 'checking' : probe.data ? (probe.data.paired ? 'paired' : 'unpaired') : 'offline')
  if (state === 'paired') return <>{children}</>
  return (
    <PairingPage
      state={state}
      error={pairError ?? probe.data?.hashError ?? null}
      onRetry={() => {
        setOverride(null)
        void probe.reload()
      }}
      onPaired={() => {
        setPairError(null)
        setOverride('paired')
      }}
      onPairError={setPairError}
    />
  )
}

function PairingPage({
  state,
  error,
  onRetry,
  onPaired,
  onPairError,
}: {
  state: Exclude<GateState, 'paired'>
  error: string | null
  onRetry: () => void
  onPaired: () => void
  onPairError: (message: string | null) => void
}) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!token.trim()) return
    setBusy(true)
    onPairError(null)
    try {
      if (await pairWithToken(token)) onPaired()
      else onPairError('令牌不对,请对照 Mac 上显示的令牌')
    } catch (e) {
      onPairError(e instanceof BackendError ? e.message : '配对失败,请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-window px-5 py-10" aria-label="连接 Mac 上的攻书">
      <Card className="w-full max-w-sm p-6">
        <h1 className="font-serif text-title2 font-semibold text-label-1">连接 Mac 上的攻书</h1>
        {state === 'checking' ? (
          <p className="mt-4 flex items-center gap-2 text-callout text-label-2" role="status">
            <Spinner size={14} />
            正在连接…
          </p>
        ) : state === 'offline' ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-callout leading-relaxed text-label-2" role="alert">
              连不上 Mac 上的攻书。确认它开着、没有休眠,手机和 Mac 登录的是同一个 Tailscale 账号。
            </p>
            <Button variant="primary" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : (
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={e => {
              e.preventDefault()
              void submit()
            }}
          >
            <p className="text-callout leading-relaxed text-label-2">
              在 Mac 的攻书里打开 设置 › 手机访问,点「显示配对二维码」,用手机相机扫一下即可。从主屏幕打开的攻书要单独配对:在 Mac 上点「复制令牌」,粘贴到这里。
            </p>
            <Input
              aria-label="配对令牌"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={token}
              placeholder="64 位令牌"
              onChange={e => setToken(e.target.value)}
              className="font-mono"
            />
            {error && (
              <p className="text-footnote text-weak" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={busy || !token.trim()}>
              {busy ? '连接中…' : '连接'}
            </Button>
          </form>
        )}
      </Card>
    </main>
  )
}
