import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { HttpError, MIN_PASSWORD_LENGTH, postPasswordChange } from '../api/client'
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick'
import { useMessages, type Messages } from '../i18n'
import { useStore } from '../state/store'
import { Dialog } from '../ui/Dialog'
import { Wordmark } from '../Wordmark'
import { mapWeakPasswordReasons } from './weakPassword'
import { expireSession, login, logout, sessionGeneration } from './session'

type Result = { kind: 'error' | 'success'; text: string } | null

// Literal backend ids from /auth/me mapped to product names; an unknown id
// (never expected) falls through verbatim rather than hiding the fact.
const DB_DISPLAY_NAMES: Record<string, string> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
}

function mapChangeError(err: unknown, m: Messages): string {
  if (err instanceof HttpError && err.code === 'wrong_current_password') {
    return m.passwordCurrentWrong
  }
  if (err instanceof HttpError && err.code === 'password_too_short') {
    return m.passwordTooShort(MIN_PASSWORD_LENGTH)
  }
  if (err instanceof HttpError && err.code === 'password_weak') return mapWeakPasswordReasons(err.reasons, m)
  // password_too_long, any unrecognised code, and a non-HttpError all fall
  // here — bare status 422 must not default to "too short", which would be
  // actively misleading for a multibyte password that tripped the byte
  // ceiling instead.
  return m.passwordFailed
}

/** The header's only entry point for changing a password and logging out
 * (Task 8). A circular badge (the account-menu-anchor's toggle) opens a
 * popover; "Change password" closes the popover and opens the password form
 * in its own modal dialog (B3) — see PasswordForm below for the completion
 * guards.
 *
 * hideActivity (B43 C1): the embed entry has no activity view to switch
 * into (EmbedApp never branches on activeView === 'activity' the way
 * App.tsx does), so "My activity" would be a dead menu item there —
 * suppressed rather than forking this component. Password change and
 * sign-out are unaffected: the embed's session is storage-partition-scoped
 * to its iframe, and AccountMenu is the only sign-out affordance in the
 * app, so those two must always be present. */
export function AccountMenu({ hideActivity = false }: { hideActivity?: boolean } = {}) {
  const m = useMessages()
  const user = useStore((s) => s.user)
  const appVersion = useStore((s) => s.appVersion)
  const setActivitySubject = useStore((s) => s.setActivitySubject)
  const setActiveView = useStore((s) => s.setActiveView)
  const [open, setOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLButtonElement>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
  }, [])

  useDismissOnOutsideClick(anchorRef, open, closeMenu)

  // useDismissOnOutsideClick only handles mousedown-outside. A document-level
  // listener (rather than an onKeyDown prop scoped to this subtree) is used
  // here for the same reason that hook listens on `document`: focus inside
  // this popover can move around before Escape is pressed, and a listener
  // scoped to the subtree could miss it. The password dialog handles its own
  // Escape and focus restore via returnFocusTo once it takes over.
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeMenu()
        badgeRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeMenu])

  // The dialog belongs to the session that opened it: the component stays
  // mounted across logout/expiry (rendering null), so a password dialog
  // left open by a mid-change 401 would otherwise reappear on re-login.
  useEffect(() => {
    if (!user) {
      setPasswordOpen(false)
      setAboutOpen(false)
    }
  }, [user])

  if (!user) return null

  const initial = user.email.charAt(0).toUpperCase()

  return (
    <div className="account-menu-anchor" ref={anchorRef}>
      <button
        ref={badgeRef}
        type="button"
        className="account-badge"
        aria-label={m.accountMenu}
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {initial}
      </button>
      {open && (
        <div className="account-menu">
          <div className="account-who">{user.email}</div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setPasswordOpen(true)
            }}
          >
            {m.accountChangePassword}
          </button>
          {!hideActivity && (
            <button
              type="button"
              onClick={() => {
                setActivitySubject('self')
                setActiveView('activity')
                setOpen(false)
              }}
            >
              {m.accountActivity}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setAboutOpen(true)
            }}
          >
            {m.accountAbout}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              logout()
            }}
          >
            {m.accountLogOut}
          </button>
        </div>
      )}
      {passwordOpen && (
        <Dialog
          title={m.accountChangePassword}
          onClose={() => setPasswordOpen(false)}
          returnFocusTo={badgeRef}
          className="account-password-dialog"
        >
          <PasswordForm email={user.email} onCancel={() => setPasswordOpen(false)} />
        </Dialog>
      )}
      {aboutOpen && (
        <Dialog
          title={m.accountAbout}
          onClose={() => setAboutOpen(false)}
          returnFocusTo={badgeRef}
          className="about-dialog"
        >
          <div className="about-content">
            <div aria-hidden="true">
              <Wordmark />
            </div>
            <dl className="about-facts">
              <div>
                <dt>{m.aboutVersion}</dt>
                <dd>{appVersion ?? '—'}</dd>
              </div>
              <div>
                <dt>{m.aboutDatabase}</dt>
                <dd>{DB_DISPLAY_NAMES[user.db_backend] ?? user.db_backend}</dd>
              </div>
              <div>
                <dt>{m.aboutSource}</dt>
                <dd>
                  <a
                    href="https://github.com/saigyo/fabulous-writing"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub
                  </a>
                </dd>
              </div>
            </dl>
            <p className="about-copyright">© 2026 Markus Ackermann</p>
          </div>
        </Dialog>
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
    // Belt-and-suspenders alongside the disabled submit button: a second
    // in-flight change (e.g. a stray Enter keypress the disabled attribute
    // hasn't visually caught up with yet) must not start a second, orphaned
    // completion racing the first one.
    if (pending) return

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
          // The silent re-login itself failed. Guard first: unlike
          // setResult below, expireSession() is a global store mutation, so
          // an orphaned handler from a session that has already moved on
          // (logged out, or logged back in as a fresh session while this
          // rejection was still in flight) must not reach across and expire
          // the *new*, unrelated session — only the session this completion
          // actually belongs to gets expired.
          if (sessionGeneration() !== startedAt) return
          // The password change already revoked the current token —
          // postLogin bypasses central 401 handling, so nothing else will
          // correct the store — leaving it `authenticated` would mean every
          // subsequent request 401s while the UI insists the user is signed
          // in. Run the expiry path instead of surfacing an error: the
          // change *did* succeed.
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

  // A stale result (from the previous attempt) must not linger while the
  // user is already retyping the field it refers to — clearing on the next
  // submit alone leaves a "wrong current password" message sitting next to
  // an input the user has already corrected.
  const editField =
    (setter: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
      setter(event.target.value)
      setResult(null)
    }

  return (
    <form onSubmit={handleSubmit}>
      <label className="login-field">
        {m.passwordCurrent}
        {/* autoFocus: opening this dialog unmounts the "Change password"
            menu item that had focus, which would otherwise drop focus to
            <body> and strand keyboard/screen-reader users. Same mechanism
            DocumentSidebar.tsx and TerminologyView.tsx already use for
            focus-on-mount elsewhere in this codebase. */}
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={editField(setCurrent)}
          autoFocus
          required
        />
      </label>
      <label className="login-field">
        {m.passwordNew}
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={editField(setNext)}
          required
        />
      </label>
      <label className="login-field">
        {m.passwordConfirm}
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={editField(setConfirm)}
          required
        />
      </label>
      {result && (
        // Inserted asynchronously once the request settles: an error needs
        // the assertive role so it interrupts and is announced immediately,
        // while the success confirmation only needs role="status" (polite) —
        // using "alert" for both would make the success message barge in
        // the same way a failure should.
        <p
          className={result.kind === 'error' ? 'llm-error' : 'all-clear'}
          role={result.kind === 'error' ? 'alert' : 'status'}
        >
          {result.text}
        </p>
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
