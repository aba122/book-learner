import type { ReactNode } from 'react'
import Button from './Button'
import Dialog from './Dialog'

/**
 * 确认框:Dialog 的薄壳(props 不变)。破坏性操作默认焦点落在「取消」(HIG:默认键是安全键);
 * 取消被禁用(忙态)时不可 Esc/遮罩关闭。
 */
export default function Confirm({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  confirmDisabled = false,
  cancelDisabled = false,
  children,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  confirmDisabled?: boolean
  cancelDisabled?: boolean
  children?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog
      open={open}
      title={title}
      description={message}
      size="sm"
      dismissible={!cancelDisabled}
      onClose={onCancel}
      footer={
        <>
          <Button disabled={cancelDisabled} onClick={onCancel} data-autofocus={danger ? true : undefined}>
            {cancelText}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={confirmDisabled}
            onClick={onConfirm}
            data-autofocus={danger ? undefined : true}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  )
}
