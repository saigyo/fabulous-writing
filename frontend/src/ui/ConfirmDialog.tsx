import type { RefObject } from 'react'
import { useMessages } from '../i18n'
import { Dialog } from './Dialog'

/** Confirm face of Dialog (B3): message + Cancel / danger-styled confirm.
 * Cancel holds initial focus so Enter on a just-opened dialog never
 * destroys anything. Escape and backdrop cancel via Dialog's onClose. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  returnFocusTo,
}: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
  /** Forwarded to Dialog. Callers whose opener unmounts before this dialog
   * mounts (menu items) pass the persistent menu-toggle ref — without it,
   * focus would fall back to <body> on close. */
  returnFocusTo?: RefObject<HTMLElement | null>
}) {
  const m = useMessages()
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      returnFocusTo={returnFocusTo}
      className="confirm-dialog"
    >
      <p>{message}</p>
      <div className="confirm-dialog-buttons">
        {/* autoFocus: React focuses on mount, deterministic in happy-dom
            (the platform's autofocus-on-showModal is not). */}
        <button type="button" autoFocus onClick={onCancel}>
          {m.dialogCancel}
        </button>
        <button type="button" className="confirm-dialog-danger" onClick={onConfirm}>
          {confirmLabel ?? m.dialogConfirm}
        </button>
      </div>
    </Dialog>
  )
}
