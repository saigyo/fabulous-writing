// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postResetConfirm: vi.fn(),
}))

import { postResetConfirm } from '../api/client'
import { ResetPasswordForm } from './ResetPasswordForm'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ uiLocale: 'en' })
})

describe('ResetPasswordForm', () => {
  it('shows the recovery heading for type=recovery and the invite heading for type=invite', () => {
    const { unmount } = render(
      <ResetPasswordForm tokenHash="tok" type="recovery" onDone={() => {}} />,
    )
    screen.getByText(en.resetHeading)
    unmount()

    render(<ResetPasswordForm tokenHash="tok" type="invite" onDone={() => {}} />)
    screen.getByText(en.inviteHeading)
  })

  it('pre-validates the password floor without calling the API', async () => {
    render(<ResetPasswordForm tokenHash="tok" type="recovery" onDone={() => {}} />)
    const u = userEvent.setup()

    await u.type(screen.getByLabelText(en.resetNewPassword), 'short')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'short')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    screen.getByText(en.passwordTooShort(8))
    expect(postResetConfirm).not.toHaveBeenCalled()
  })

  it('a mismatch shows resetMismatch without calling the API', async () => {
    render(<ResetPasswordForm tokenHash="tok" type="recovery" onDone={() => {}} />)
    const u = userEvent.setup()

    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword1')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'newpassword2')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    screen.getByText(en.resetMismatch)
    expect(postResetConfirm).not.toHaveBeenCalled()
  })

  it('submits token_hash/type/new_password and shows success, then calls onDone from the button', async () => {
    vi.mocked(postResetConfirm).mockResolvedValue(undefined)
    const onDone = vi.fn()
    render(<ResetPasswordForm tokenHash="abc123" type="recovery" onDone={onDone} />)
    const u = userEvent.setup()

    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword1')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'newpassword1')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    await waitFor(() =>
      expect(postResetConfirm).toHaveBeenCalledWith('abc123', 'recovery', 'newpassword1'),
    )
    await waitFor(() => screen.getByText(en.resetSuccess))
    expect(onDone).not.toHaveBeenCalled() // only the explicit button triggers it

    await u.click(screen.getByRole('button', { name: en.resetBackToSignIn }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('a 422 invalid_or_expired_link shows resetLinkInvalid', async () => {
    vi.mocked(postResetConfirm).mockRejectedValue(
      new HttpError(422, 'POST /api/auth/reset-confirm failed: 422', 'invalid_or_expired_link'),
    )
    render(<ResetPasswordForm tokenHash="abc123" type="invite" onDone={() => {}} />)
    const u = userEvent.setup()

    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword1')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'newpassword1')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    await waitFor(() => screen.getByText(en.resetLinkInvalid))
  })

  it('any other error falls back to the generic sign-in-failed message', async () => {
    vi.mocked(postResetConfirm).mockRejectedValue(new HttpError(500, 'Internal error'))
    render(<ResetPasswordForm tokenHash="abc123" type="recovery" onDone={() => {}} />)
    const u = userEvent.setup()

    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword1')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'newpassword1')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    await waitFor(() => screen.getByText(en.signInFailed))
  })
})
