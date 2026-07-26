import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { HttpError, MIN_PASSWORD_LENGTH, postPasswordChange } from '../api/client'
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick'
import { useMessages, type Messages } from '../i18n'
import { useStore } from '../state/store'
import { expireSession, login, logout, sessionGeneration } from './session'

type Result = { kind: 'error' | 'success'; text: string } | null

function mapChangeError(err: unknown, m: Messages): string {
  if (err instanceof HttpError && err.code === 'wrong_current_password') {
    return m.passwordCurrentWrong
  }
  if (err instanceof HttpError && err.code === 'password_too_short') {
    return m.passwordTooShort(MIN_PASSWORD_LENGTH)
  }
  // password_too_long, any unrecognised code, and a non-HttpError all fall
  // here — bare status 422 must not default to "too short", which would be
  // actively misleading for a multibyte password that tripped the byte
  // ceiling instead.
  return m.passwordFailed
}

/** The header's only entry point for changing a password and logging out
 * (Task 8). A circular badge (the account-menu-anchor's toggle) opens a
 * popover that starts on its menu view and can drill into a password form
 * in the same popover — see PasswordForm below for the completion guards. */
export function AccountMenu() {
  const m = useMessages()
  const user = useStore((s) => s.user)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'menu' | 'password'>('menu')
  const anchorRef = useRef<HTMLDivElement>(null)

  // Every path that leaves the popover resets `view` alongside it — the
  // same shape DocumentSidebar's closeMenu uses for its `moving` submenu —
  // so no caller has to separately remember to clear the password view.
  const closeMenu = useCallback(() => {
    setOpen(false)
    setView('menu')
  }, [])

  useDismissOnOutsideClick(anchorRef, open, closeMenu)

  // useDismissOnOutsideClick only handles mousedown-outside. A document-level
  // listener (rather than an onKeyDown prop scoped to this subtree) is used
  // here for the same reason that hook listens on `document`: clicking
  // "Change password" unmounts that button, and focus can fall back to
  // <body> — outside this subtree — so a listener that only fires while
  // focus is inside would miss Escape right after that click.
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeMenu])

  if (!user) return null

  const initial = user.email.charAt(0).toUpperCase()

  return (
    <div className="account-menu-anchor" ref={anchorRef}>
      <button
        type="button"
        className="account-badge"
        aria-label={m.accountMenu}
        onClick={() => {
          // Toggling the trigger always resets to the menu view too, not
          // just closing paths — so reopening after drilling into the
          // password form (without an explicit dismissal) still shows the
          // menu, mirroring DocumentSidebar's doc-menu-button handler.
          setOpen((wasOpen) => !wasOpen)
          setView('menu')
        }}
      >
        {initial}
      </button>
      {open && (
        <div className={view === 'menu' ? 'account-menu' : 'account-menu account-password-panel'}>
          {view === 'menu' ? (
            <>
              <div className="account-who">{user.email}</div>
              <button type="button" onClick={() => setView('password')}>
                {m.accountChangePassword}
              </button>
              <button
                type="button"
                onClick={() => {
                  closeMenu()
                  logout()
                }}
              >
                {m.accountLogOut}
              </button>
            </>
          ) : (
            <PasswordForm email={user.email} onCancel={closeMenu} />
          )}
        </div>
      )}
    </div>
  )
}

function PasswordForm({ email, onCancel }: { email: string; onCancel: () => void }) {
  const m = useMessages()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Result>(null)

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()

    if (next.length < MIN_PASSWORD_LENGTH) {
      setResult({ kind: 'error', text: m.passwordTooShort(MIN_PASSWORD_LENGTH) })
      return
    }
    if (next !== confirm) {
      setResult({ kind: 'error', text: m.passwordMismatch })
      return
    }

    setResult(null)
    setPending(true)
    // Read before sending: the popover stays dismissible while this request
    // is in flight, so a user can dismiss it, reopen and log out before the
    // 204 lands. Comparing the user id would miss logging out and back in
    // as the same person, which must also abandon this completion.
    const startedAt = sessionGeneration()

    void postPasswordChange(current, next)
      .then(async () => {
        // Guard #1 (first await point): the session may have moved while
        // the password request itself was in flight.
        if (sessionGeneration() !== startedAt) return

        let reauthenticated: boolean
        try {
          reauthenticated = await login(email, next)
        } catch {
          // The silent re-login itself failed. The password change already
          // revoked the current token — postLogin bypasses central 401
          // handling, so nothing else will correct the store — leaving it
          // `authenticated` would mean every subsequent request 401s while
          // the UI insists the user is signed in. Run the expiry path
          // instead of surfacing an error: the change *did* succeed.
          expireSession()
          return
        }

        // Guard #2 (second await point): login() itself discarded the
        // token rather than committing it if the session moved while
        // postLogin was in flight — show the success notice only when it
        // actually committed. Otherwise abandon silently: no re-login (it
        // already happened, and was discarded), no success message, no
        // error, because the session this completion belonged to is gone.
        if (!reauthenticated) return
        setResult({ kind: 'success', text: m.passwordChanged })
      })
      .catch((err: unknown) => {
        // A 401 here already ran through expireSession() inside
        // postPasswordChange's own request() call (it is deliberately not
        // exempt via keepSessionOn401), which bumped the generation before
        // this rejection ever reaches us — so that case is silently
        // abandoned by the check below, same as the success path, and the
        // gate's own session-expired notice is the only message shown.
        if (sessionGeneration() !== startedAt) return
        setResult({ kind: 'error', text: mapChangeError(err, m) })
      })
      .finally(() => setPending(false))
  }

  return (
    <form onSubmit={handleSubmit}>
      <label className="login-field">
        {m.passwordCurrent}
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </label>
      <label className="login-field">
        {m.passwordNew}
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </label>
      <label className="login-field">
        {m.passwordConfirm}
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </label>
      {result && (
        <p className={result.kind === 'error' ? 'llm-error' : 'all-clear'}>{result.text}</p>
      )}
      <div className="account-password-actions">
        <button type="button" className="account-password-cancel" onClick={onCancel}>
          {m.passwordCancel}
        </button>
        <button type="submit" className="account-password-submit" disabled={pending}>
          {m.passwordSubmit}
        </button>
      </div>
    </form>
  )
}
