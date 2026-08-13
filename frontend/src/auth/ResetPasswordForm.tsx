import { useState, type FormEvent } from 'react'
import { HttpError, MIN_PASSWORD_LENGTH, postResetConfirm } from '../api/client'
import { useMessages, type Messages } from '../i18n'

interface ResetPasswordFormProps {
  tokenHash: string
  type: 'recovery' | 'invite'
  // Returns the gate to LoginForm on success — deliberately not an
  // auto-login: the link only proves control of the mailbox at the moment
  // it was sent, not that this browser tab should inherit a session now.
  onDone: () => void
}

// Mirrors AccountMenu.tsx's mapChangeError: `wrong_current_password` has no
// counterpart here (this flow never sees the old password), so only the two
// codes reset-confirm can actually raise are handled specifically.
// Copilot round 3: previously every non-`invalid_or_expired_link` error --
// including password_too_long and a 503 -- fell back to m.signInFailed, a
// message about a sign-in attempt that never happened on this screen.
function mapResetError(err: unknown, m: Messages): string {
  if (err instanceof HttpError) {
    if (err.code === 'invalid_or_expired_link') return m.resetLinkInvalid
    if (err.code === 'password_too_short') return m.passwordTooShort(MIN_PASSWORD_LENGTH)
  }
  // password_too_long, any other 422 code, a 503, and a network failure all
  // land here — the same neutral fallback AccountMenu's mapChangeError uses
  // for password_too_long, and one that never mentions signing in.
  return m.passwordFailed
}

/** Rendered by LoginGate in place of LoginForm while anonymous and the URL
 * carried a `token_hash`+`type` pair (captured once on mount, then stripped
 * from the URL — see LoginGate.tsx). Same recovery flow serves both a
 * password-reset link and an admin invite; only the heading and copy
 * differ. */
export function ResetPasswordForm({ tokenHash, type, onDone }: ResetPasswordFormProps) {
  const m = useMessages()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (pending) return
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(m.passwordTooShort(MIN_PASSWORD_LENGTH))
      return
    }
    if (password !== confirm) {
      setError(m.resetMismatch)
      return
    }
    setError(null)
    setPending(true)
    postResetConfirm(tokenHash, type, password)
      .then(() => setSuccess(true))
      .catch((err: unknown) => setError(mapResetError(err, m)))
      .finally(() => setPending(false))
  }

  if (success) {
    return (
      <div className="login-card">
        <p className="all-clear" role="status">
          {m.resetSuccess}
        </p>
        <button type="button" className="login-submit" onClick={onDone}>
          {m.resetBackToSignIn}
        </button>
      </div>
    )
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <h2>{type === 'invite' ? m.inviteHeading : m.resetHeading}</h2>
      <label className="login-field">
        {m.resetNewPassword}
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <label className="login-field">
        {m.resetRepeatPassword}
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </label>
      {error && (
        <p className="llm-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="login-submit" disabled={pending}>
        {m.resetSubmit}
      </button>
    </form>
  )
}
