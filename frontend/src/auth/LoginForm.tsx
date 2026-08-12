import { useState, type FormEvent } from 'react'
import { HttpError } from '../api/client'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import { login } from './session'

interface LoginFormProps {
  // Hands the currently-typed email to the gate, which switches to
  // ForgotPasswordForm with it prefilled — only reachable when the link
  // below is rendered at all (authFeatures?.password_reset).
  onForgot: (email: string) => void
}

/** The card shown while authStatus is 'anonymous'. login()'s own boolean
 * return (false = superseded by a session change in flight) is ignored
 * here on purpose: LoginGate re-renders off authStatus, so a superseded
 * attempt just leaves this form mounted rather than needing its own
 * handling. Only a rejected promise is this form's concern. */
export function LoginForm({ onForgot }: LoginFormProps) {
  const m = useMessages()
  const sessionExpired = useStore((s) => s.sessionExpired)
  const authFeatures = useStore((s) => s.authFeatures)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `!pending` matters: without it, setError(null) below clears a previous
  // attempt's error and notice falls back to the stale sessionExpired
  // message for the duration of the new request — re-flashing "your session
  // expired" over a second attempt that has nothing to do with expiry.
  const notice = error ?? (sessionExpired && !pending ? m.sessionExpired : null)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    login(email, password)
      .catch((err: unknown) => {
        setError(
          err instanceof HttpError && err.status === 401
            ? m.signInInvalid
            : m.signInFailed,
        )
      })
      .finally(() => setPending(false))
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <label className="login-field">
        {m.signInEmail}
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label className="login-field">
        {m.signInPassword}
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {/* Same slot for both: a fresh submit error is more useful than a
          stale expiry notice once the user has tried again. role="alert"
          so a screen-reader user is told why sign-in failed, or why this
          form suddenly appeared (session expiry), without having to
          discover the text on their own. */}
      {notice && (
        <p className="llm-error" role="alert">
          {notice}
        </p>
      )}
      <button type="submit" className="login-submit" disabled={pending}>
        {pending ? m.signInPending : m.signInSubmit}
      </button>
      {authFeatures?.password_reset && (
        <button
          type="button"
          className="login-link"
          onClick={() => onForgot(email)}
        >
          {m.forgotPassword}
        </button>
      )}
    </form>
  )
}
