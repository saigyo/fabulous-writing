import { useState, type FormEvent } from 'react'
import { HttpError } from '../api/client'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import { Wordmark } from '../Wordmark'
import { login } from './session'

/** The card shown while authStatus is 'anonymous'. login()'s own boolean
 * return (false = superseded by a session change in flight) is ignored
 * here on purpose: LoginGate re-renders off authStatus, so a superseded
 * attempt just leaves this form mounted rather than needing its own
 * handling. Only a rejected promise is this form's concern. */
export function LoginForm() {
  const m = useMessages()
  const sessionExpired = useStore((s) => s.sessionExpired)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const notice = error ?? (sessionExpired ? m.sessionExpired : null)

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
      <Wordmark />
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
          stale expiry notice once the user has tried again. */}
      {notice && <p className="llm-error">{notice}</p>}
      <button type="submit" className="login-submit" disabled={pending}>
        {pending ? m.signInPending : m.signInSubmit}
      </button>
    </form>
  )
}
