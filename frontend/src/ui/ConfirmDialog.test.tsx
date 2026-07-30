// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../i18n/en'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(cleanup)

function renderConfirm(overrides: { onConfirm?: () => void; onCancel?: () => void } = {}) {
  const onConfirm = overrides.onConfirm ?? vi.fn()
  const onCancel = overrides.onCancel ?? vi.fn()
  render(
    <ConfirmDialog
      title="Delete folder"
      message="Delete 'Drafts'?"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  )
  return { onConfirm, onCancel }
}

describe('ConfirmDialog', () => {
  it('starts with focus on Cancel (destructive-safe default)', () => {
    renderConfirm()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: en.dialogCancel }),
    )
  })

  it('confirm fires onConfirm only', () => {
    const { onConfirm, onCancel } = renderConfirm()
    fireEvent.click(screen.getByRole('button', { name: en.dialogConfirm }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancel button and Escape both fire onCancel', () => {
    const { onConfirm, onCancel } = renderConfirm()
    fireEvent.click(screen.getByRole('button', { name: en.dialogCancel }))
    const dialog = document.querySelector('dialog')
    if (!dialog) throw new Error('no dialog')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
