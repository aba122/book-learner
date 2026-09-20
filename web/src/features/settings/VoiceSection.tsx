import { useCallback, useEffect, useState } from 'react'
import { listAudioInputs } from '../../audio/pcm'
import { backend } from '../../backend'
import AsyncError from '../../components/AsyncError'
import Button from '../../components/Button'
import Confirm from '../../components/Confirm'
import IconButton from '../../components/IconButton'
import Input from '../../components/Input'
import Select from '../../components/Select'
import Skeleton from '../../components/Skeleton'
import { VOICE_DEVICE_KEY } from '../../config'
import { useAsyncResource } from '../../lib/useAsyncResource'
import { useBackendOperation } from '../../lib/useBackendOperation'
import type { VoiceModel } from '../../types'
import SettingsSection from './SettingsSection'

const formatMb = (bytes: number) => `${Math.round(bytes / (1 << 20))} MB`

function readDevice(): string {
  try {
    return localStorage.getItem(VOICE_DEVICE_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * 设置页「语音」分区(M3 T3;视觉改版第三批改成分组列表):whisper 模型清单(导入/选择/删除;文件在壳层 models 目录)
 * 与输入设备选择(浏览器侧偏好)。模型只做手动导入:下载须走终端(app 不带 HTTP 客户端,也不继承 shell 代理)。
 */
export default function VoiceSection() {
  const models = useAsyncResource(useCallback(() => backend.voiceModels(), []))
  const [list, setList] = useState<VoiceModel[] | null>(null)
  const [pathDraft, setPathDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[] | null>(null)
  const [device, setDevice] = useState(readDevice)
  const importOp = useBackendOperation(async (path: string | null) => {
    const imported = await backend.voiceImportModel(path)
    if (imported) {
      setPathDraft('')
      setList(await backend.voiceModels())
    }
  })
  const selectOp = useBackendOperation(async (name: string) => setList(await backend.voiceSelectModel(name)))
  const deleteOp = useBackendOperation(async (name: string) => setList(await backend.voiceDeleteModel(name)))

  useEffect(() => {
    let alive = true
    listAudioInputs()
      .then(found => {
        if (alive) setDevices(found)
      })
      .catch(() => {
        if (alive) setDevices([])
      })
    return () => {
      alive = false
    }
  }, [])

  const current = list ?? models.data
  const busy = importOp.pending.size > 0 || selectOp.pending.size > 0 || deleteOp.pending.size > 0
  const error = importOp.errors.get('import') ?? selectOp.errors.get('select') ?? deleteOp.errors.get('delete')
  const chooseDevice = (value: string) => {
    setDevice(value)
    try {
      if (value) localStorage.setItem(VOICE_DEVICE_KEY, value)
      else localStorage.removeItem(VOICE_DEVICE_KEY)
    } catch {
      /* 无持久化时只在本次生效 */
    }
  }
  return (
    <SettingsSection
      id="voice"
      title="语音"
      description="复述可以用说的:本机 whisper 转写成文字后填入输入框,不上传。模型文件(ggml-*.bin)需自行下载后导入,推荐 large-v3-turbo-q5_0(中文效果好)。"
    >
      <div className="px-4 pt-3 pb-1">
        <h3 className="text-footnote font-medium text-label-3">whisper 模型</h3>
        {current === null ? (
          models.error ? (
            <div className="py-2"><AsyncError error={models.error} onRetry={models.reload} variant="compact" /></div>
          ) : (
            <div aria-busy="true" className="py-3"><Skeleton lines={3} /></div>
          )
        ) : (
          <ul className="divide-y divide-sep" aria-label="whisper 模型">
            {current.map(m => (
              <li key={m.name} className="flex min-h-11 items-center justify-between gap-4 py-1.5" data-testid="voice-model-row" data-present={m.present ? 'true' : 'false'}>
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 has-[input:disabled]:cursor-not-allowed">
                  <input
                    type="radio"
                    name="voice-model"
                    aria-label={`使用 ${m.name}`}
                    checked={m.selected}
                    disabled={!m.present || busy}
                    onChange={() => {
                      selectOp.clearError('select')
                      void selectOp.run('select', m.name)
                    }}
                    className="size-4 accent-accent"
                  />
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className={`text-body ${m.present ? 'text-label-1' : 'text-label-3'}`}>{m.name}</span>
                    <span className="text-footnote text-label-3">{m.note}</span>
                    <span className="text-footnote text-label-3">{m.present && m.bytes !== null ? formatMb(m.bytes) : '未导入'}</span>
                  </span>
                </label>
                {m.present && (
                  <IconButton icon="trash" size="sm" label={`删除模型 ${m.name}`} className="text-label-3" disabled={busy} onClick={() => setDeleteTarget(m.name)} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            aria-label="模型文件路径"
            type="text"
            value={pathDraft}
            placeholder="~/Downloads/ggml-large-v3-turbo-q5_0.bin"
            onChange={e => setPathDraft(e.target.value)}
            className="min-w-0 flex-1"
          />
          <Button
            size="sm"
            disabled={busy || !pathDraft.trim()}
            onClick={() => {
              importOp.clearError('import')
              void importOp.run('import', pathDraft.trim())
            }}
          >
            {importOp.pending.has('import') ? '导入中…' : '导入路径'}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              importOp.clearError('import')
              void importOp.run('import', null)
            }}
          >
            选择文件…
          </Button>
        </div>
        {error && <AsyncError error={error} variant="compact" />}
      </div>
      <div className="flex min-h-11 items-center justify-between gap-6 px-4 py-2">
        <label htmlFor="voice-device" className="text-body text-label-1">输入设备</label>
        <div className="flex flex-col items-end gap-1">
          <Select id="voice-device" value={device} onChange={e => chooseDevice(e.target.value)} className="w-64" disabled={devices === null}>
            <option value="">系统默认</option>
            {(devices ?? []).map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </Select>
          <span className="text-footnote text-label-3">{devices !== null && devices.length === 0 ? '未发现麦克风(首次录音授权后会列出名称)' : '首次录音会请求系统麦克风权限'}</span>
        </div>
      </div>
      <Confirm
        open={deleteTarget !== null}
        title="删除这个模型文件?"
        message={`将从 app 的模型目录删除 ${deleteTarget ?? ''},需要时可重新导入。`}
        confirmText="删除"
        cancelText="取消"
        danger
        onConfirm={() => {
          const name = deleteTarget
          setDeleteTarget(null)
          if (name) {
            deleteOp.clearError('delete')
            void deleteOp.run('delete', name)
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </SettingsSection>
  )
}
