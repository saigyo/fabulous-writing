import { useState, type FormEvent } from 'react'
import { postResetRequest } from '../api/client'
import { useMessages } from '../i18n'

interface ForgotPasswordFormProps {
  // Prefilled from LoginForm's own email field (see its onForgot callback) —
  // not re-validated here, since the request is enumeration-neutral either
  // way.
  email: string
  onBack: () => void
}

/** Rendered by LoginGate in place of LoginForm once the user follows the
 * "Forgot your password?" link. Always shows the same neutral confirmation
 * regardless of whether postResetRequest resolves or rejects — the backend
 * itself never reveals whether an address has an account
 * (backend/app/api/auth.py), and surfacing a different message here would
 * undo that on the client. */
export function ForgotPasswordForm({ email: initialEmail, onBack }: ForgotPasswordFormProps) {
  const m = useMessages()
  const [email, setEmail] = useState(initialEmail)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    postResetRequest(email)
      .catch(() => {})
      .finally(() => {
        setPending(false)
        setSent(true)
      })
  }

  if (sent) {
    return (
      <div className="login-card">
        <p className="all-clear" role="status">
          {m.resetRequestSent}
        </p>
        <button type="button" className="login-link" onClick={onBack}>
          {m.backToSignIn}
        </button>
      </div>
    )
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <label className="login-field">
        {m.resetEmailLabel}
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <button type="submit" className="login-submit" disabled={pending}>
        {m.resetRequestSubmit}
      </button>
      <button type="button" className="login-link" onClick={onBack}>
        {m.backToSignIn}
      </button>
    </form>
  )
}
