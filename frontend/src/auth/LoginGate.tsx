import { useEffect, type ReactNode } from 'react'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import { Wordmark } from '../Wordmark'
import { LoginForm } from './LoginForm'
import { restoreSession } from './session'

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
  const m = useMessages()

  useEffect(() => {
    // Empty deps: <StrictMode> double-invokes this in development, but
    // restoreSession() already dedups concurrent calls to one in-flight
    // /api/auth/me request (see session.ts) — no guard needed here.
    void restoreSession()
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

  if (authStatus === 'authenticated') return <>{children}</>
  if (authStatus === 'anonymous') {
    return (
      <GateShell>
        <LoginForm />
      </GateShell>
    )
  }
  // 'unknown': the initial restore is still in flight. Render nothing —
  // not App (would fire its mount effects), not the login form (would
  // flash before flipping to authenticated on a valid stored token).
  return null
}
