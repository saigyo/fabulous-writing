import { useState, type FormEvent } from 'react'
import { HttpError, MIN_PASSWORD_LENGTH, postResetConfirm } from '../api/client'
import { useMessages } from '../i18n'

interface ResetPasswordFormProps {
  tokenHash: string
  type: 'recovery' | 'invite'
  // Returns the gate to LoginForm on success — deliberately not an
  // auto-login: the link only proves control of the mailbox at the moment
  // it was sent, not that this browser tab should inherit a session now.
  onDone: () => void
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
      .catch((err: unknown) => {
        setError(
          err instanceof HttpError && err.code === 'invalid_or_expired_link'
            ? m.resetLinkInvalid
            : m.signInFailed,
        )
      })
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
