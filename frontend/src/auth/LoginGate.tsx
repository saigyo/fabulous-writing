import { useEffect, useState, type ReactNode } from 'react'
import { getHealth } from '../api/client'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import { Wordmark } from '../Wordmark'
import { ForgotPasswordForm } from './ForgotPasswordForm'
import { LoginForm } from './LoginForm'
import { ResetPasswordForm } from './ResetPasswordForm'
import { restoreSession } from './session'

interface ResetParams {
  tokenHash: string
  type: 'recovery' | 'invite'
}

/** Reads a reset/invite link's params from the current URL's fragment,
 * once. Only "recovery"/"invite" are accepted `type` values — anything else
 * (missing param, typo, a stray fragment from something unrelated) is
 * treated as no link at all, and the gate falls through to the ordinary
 * login form. The fragment (not the query string) is deliberate: a URL
 * fragment is never sent in an HTTP request, so this one-time credential
 * cannot reach server access logs or leak via a `Referer` header. This
 * shape is only what the emailed link carries if the dashboard's email
 * templates were pointed at the app the way `docs/supabase-auth-setup.md`
 * §7 describes — otherwise the tokens arrive in Supabase's own stock
 * fragment shape, which this function does not recognize, and both flows
 * fail closed here, silently. */
function readResetParams(): ResetParams | null {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const tokenHash = params.get('token_hash')
  const type = params.get('type')
  if (!tokenHash || (type !== 'recovery' && type !== 'invite')) return null
  return { tokenHash, type }
}

/** Split shell shared by every visible pre-auth state (B4, #37): brand
 * pane (wordmark + tagline) beside the pane content. The gate's state
 * branching stays in LoginGate — this is layout only. */
function GateShell({ children }: { children: ReactNode }) {
  const m = useMessages()
  return (
    <div className="login-gate">
      <div className="login-split">
        <div className="login-brand">
          <Wordmark />
          <p className="login-tagline">{m.loginTagline}</p>
        </div>
        <div className="login-pane">{children}</div>
      </div>
    </div>
  )
}

/** Sits above the whole app shell. Renders `children` only once authStatus
 * reaches 'authenticated' — never mounted-but-hidden — so App's mount
 * effects (initDocuments, Header's provider/domain/language/routing
 * fetches) cannot fire while unauthenticated and produce a burst of 401s. */
export function LoginGate({ children }: { children: ReactNode }) {
  const authStatus = useStore((s) => s.authStatus)
  const restoreFailed = useStore((s) => s.restoreFailed)
  const setAuthFeatures = useStore((s) => s.setAuthFeatures)
  const m = useMessages()
  // Captured once, straight from the initial render — not in an effect —
  // so a link is available on the very first paint rather than flashing
  // the ordinary login form for one frame first.
  const [resetParams, setResetParams] = useState(readResetParams)
  // null = not showing ForgotPasswordForm; a string (possibly empty) is the
  // email LoginForm was showing when the link was clicked.
  const [forgotEmail, setForgotEmail] = useState<string | null>(null)

  useEffect(() => {
    // Empty deps: <StrictMode> double-invokes this in development, but
    // restoreSession() already dedups concurrent calls to one in-flight
    // /api/auth/me request (see session.ts) — no guard needed here.
    void restoreSession()
  }, [])

  useEffect(() => {
    // Unconditional, empty deps: this gate is mounted for the whole app
    // lifetime (never unmounted/remounted across auth transitions), so
    // gating this on authStatus would re-fire it on every login/logout for
    // no reason — one fetch per page load is enough. /api/health is public;
    // this is deliberately the one /api/* call an anonymous first visit now
    // issues (see client.ts's getHealth comment and Task 8's doc update).
    // Best-effort: a failed health check just means no reset/invite
    // affordance this load, not a broken gate.
    getHealth()
      .then((h) => h.auth_features && setAuthFeatures(h.auth_features))
      .catch(() => {})
  }, [setAuthFeatures])

  useEffect(() => {
    // Strips a burned token_hash/type pair from the URL's fragment right
    // after the params above are captured into state, so a reload of this
    // same tab does not resubmit it. Runs once, after the initial paint the
    // useState(readResetParams) initializer already covered.
    if (resetParams)
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resetParams is captured once via useState's lazy initializer and never changes after mount
  }, [])

  if (restoreFailed) {
    return (
      <GateShell>
        <div className="login-card">
          {/* role="alert": this text replaces the whole gate asynchronously
              (after the mount effect's restoreSession() fails), so without a
              live-region role assistive technology may never announce that
              loading failed. */}
          <p className="llm-error" role="alert">
            {m.connectionFailed}
          </p>
          <button
            type="button"
            className="login-submit"
            onClick={() => void restoreSession()}
          >
            {m.connectionRetry}
          </button>
        </div>
      </GateShell>
    )
  }

  // A recovery/invite link is an explicit intent to change the credential:
  // checked BEFORE 'authenticated' so a link opened in a tab that still
  // holds a valid stored token renders the reset form instead of silently
  // returning to the app with the link burned (finding 7, final review).
  // This also covers 'unknown' (restore still in flight) — the form does
  // not depend on auth state, so there is nothing to wait for.
  if (resetParams) {
    return (
      <GateShell>
        <ResetPasswordForm
          tokenHash={resetParams.tokenHash}
          type={resetParams.type}
          onDone={() => setResetParams(null)}
        />
      </GateShell>
    )
  }
  if (authStatus === 'authenticated') return <>{children}</>
  if (authStatus === 'anonymous') {
    return (
      <GateShell>
        {forgotEmail !== null ? (
          <ForgotPasswordForm email={forgotEmail} onBack={() => setForgotEmail(null)} />
        ) : (
          <LoginForm onForgot={setForgotEmail} />
        )}
      </GateShell>
    )
  }
  // 'unknown': the initial restore is still in flight. Render nothing —
  // not App (would fire its mount effects), not the login form (would
  // flash before flipping to authenticated on a valid stored token).
  return null
}
