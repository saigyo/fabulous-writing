// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, type LoginResponse, type MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postLogin: vi.fn(),
  postLogout: vi.fn(),
  getMe: vi.fn(),
  getHealth: vi.fn(),
  postResetRequest: vi.fn(),
  postResetConfirm: vi.fn(),
}))
// Same reasoning as session.test.ts: documents.ts pulls in hydration.ts ->
// checking/controller.ts, which session.ts (imported for real below) only
// needs two exports from.
vi.mock('../documents/documents', () => ({
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))

import {
  getHealth,
  getMe,
  postLogin,
  postLogout,
  postResetConfirm,
  postResetRequest,
} from '../api/client'
import { logout } from './session'
import { LoginGate } from './LoginGate'

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
    usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
    limits: {
      max_document_chars: 200000,
      max_llm_document_chars: 200000,
      concurrent_llm_runs: 5,
    },
    allow_additional_admins: false,
    ...overrides,
  }
}

// The gate must not render App itself (that would pull in every view), so a
// plain sentinel element pins "not rendered" rather than "not visible".
function Sentinel() {
  return <div data-testid="app-sentinel">APP</div>
}

afterEach(() => {
  cleanup()
  // A test that pushed a reset/invite URL (window.history.pushState) must
  // not leak it into the next test — happy-dom's `window.location` is a
  // single object shared across every test in this file.
  window.history.replaceState(null, '', '/')
})

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  // No auth_features: individual tests override this (mockResolvedValueOnce
  // or a fresh mockResolvedValue) when they care what the mount effect's
  // getHealth() call resolves to.
  vi.mocked(getHealth).mockResolvedValue({ status: 'ok', name: '', version: 'dev' })
  useStore.setState({
    token: null,
    user: null,
    authStatus: 'unknown',
    sessionExpired: false,
    restoreFailed: false,
    authFeatures: null,
    uiLocale: 'en', // pin the catalog so message assertions are deterministic
  })
})

describe('LoginGate', () => {
  it('renders nothing while authStatus is unknown', async () => {
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    let resolveMe!: (u: MeResponse) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMe = resolve
        }),
    )
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    expect(screen.queryByTestId('app-sentinel')).toBeNull()
    expect(screen.queryByLabelText(en.signInEmail)).toBeNull()

    // Settle the in-flight request so it doesn't leak into the next test
    // (session.ts's restoreInFlight is module-level, shared across tests).
    resolveMe(user())
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))
  })

  it('shows the sessionExpired notice above the form when set, as a live-region alert', () => {
    useStore.setState({ authStatus: 'anonymous', sessionExpired: true })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.sessionExpired)
    screen.getByLabelText(en.signInEmail)
    expect(screen.queryByTestId('app-sentinel')).toBeNull()
    // Direct attribute assertion, no mutation verification needed: a
    // screen-reader user must be told why this form suddenly appeared.
    expect(screen.getByRole('alert').textContent).toBe(en.sessionExpired)
  })

  it('does not show the sessionExpired notice after a plain log-out', () => {
    useStore.setState({ authStatus: 'anonymous', sessionExpired: false })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    expect(screen.queryByText(en.sessionExpired)).toBeNull()
    screen.getByLabelText(en.signInEmail)
  })

  it('shows the connection message and a working retry button when restoreFailed is set', async () => {
    useStore.setState({ token: 'tok', authStatus: 'unknown', restoreFailed: true })
    vi.mocked(getMe).mockRejectedValue(new TypeError('offline'))
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    // The mount effect's own restoreSession() call.
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))
    screen.getByText(en.connectionFailed)
    expect(screen.queryByTestId('app-sentinel')).toBeNull()
    expect(screen.queryByLabelText(en.signInEmail)).toBeNull()
    // Direct attribute assertion, no mutation verification needed: this text
    // replaces the whole gate asynchronously, so assistive technology needs
    // a live-region role to announce that loading failed.
    expect(screen.getByRole('alert').textContent).toBe(en.connectionFailed)

    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: en.connectionRetry }))
    // Retry must call restoreSession() again, not just re-render the same state.
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(2))
  })

  it('shows the login form and not the children while anonymous', () => {
    useStore.setState({ authStatus: 'anonymous' })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByLabelText(en.signInEmail)
    screen.getByLabelText(en.signInPassword)
    expect(screen.queryByTestId('app-sentinel')).toBeNull()
  })

  it('renders the brand tagline on the anonymous gate (B4)', () => {
    useStore.setState({ authStatus: 'anonymous' })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.loginTagline)
  })

  it('renders the brand tagline on the connection-failed gate (B4)', async () => {
    // A stored token whose restore rejects with a network error (not a
    // 401) sets restoreFailed via runRestore()'s non-401 branch — the
    // gate then renders the connection-failed card inside the shell.
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    vi.mocked(getMe).mockRejectedValue(new TypeError('offline'))
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    await waitFor(() => screen.getByText(en.connectionFailed))
    screen.getByText(en.loginTagline)
  })

  it('renders the children and not the form while authenticated', async () => {
    useStore.setState({ token: 'tok', user: user(), authStatus: 'authenticated' })
    vi.mocked(getMe).mockResolvedValue(user())
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByTestId('app-sentinel')
    expect(screen.queryByLabelText(en.signInEmail)).toBeNull()
    // Let the mount effect's restoreSession() call settle before the test ends.
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))
  })

  it('submitting valid credentials calls login(), which flips the gate to authenticated', async () => {
    useStore.setState({ authStatus: 'anonymous' })
    vi.mocked(postLogin).mockResolvedValue({
      token: 'tok',
      refresh_token: null,
      expires_at: null,
      user: user(),
    })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.signInEmail), 'ada@example.com')
    await u.type(screen.getByLabelText(en.signInPassword), 'secret123')
    await u.click(screen.getByRole('button', { name: en.signInSubmit }))

    await waitFor(() =>
      expect(postLogin).toHaveBeenCalledWith('ada@example.com', 'secret123'),
    )
    await waitFor(() => screen.getByTestId('app-sentinel'))
  })

  it('a rejected login() shows the invalid-credentials message and leaves the form visible', async () => {
    useStore.setState({ authStatus: 'anonymous' })
    vi.mocked(postLogin).mockRejectedValue(new HttpError(401, 'Invalid email or password'))
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.signInEmail), 'ada@example.com')
    await u.type(screen.getByLabelText(en.signInPassword), 'wrong')
    await u.click(screen.getByRole('button', { name: en.signInSubmit }))

    await waitFor(() => screen.getByText(en.signInInvalid))
    screen.getByLabelText(en.signInEmail)
    expect(useStore.getState().authStatus).toBe('anonymous')
    // Direct attribute assertion, no mutation verification needed: a
    // screen-reader user must be told why sign-in failed.
    expect(screen.getByRole('alert').textContent).toBe(en.signInInvalid)
  })

  it('a rejected login() with a non-401 error shows the generic failure message', async () => {
    useStore.setState({ authStatus: 'anonymous' })
    vi.mocked(postLogin).mockRejectedValue(new HttpError(500, 'Internal error'))
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.signInEmail), 'ada@example.com')
    await u.type(screen.getByLabelText(en.signInPassword), 'whatever')
    await u.click(screen.getByRole('button', { name: en.signInSubmit }))

    await waitFor(() => screen.getByText(en.signInFailed))
  })

  it('a second sign-in attempt does not re-flash the stale sessionExpired notice while pending', async () => {
    // Pins the fix for LoginForm's `notice` fallback: setError(null) at the
    // start of a new submit used to let `notice` fall back to the old
    // sessionExpired message for the duration of the request, even though
    // this attempt has nothing to do with why the form appeared.
    useStore.setState({ authStatus: 'anonymous', sessionExpired: true })
    vi.mocked(postLogin).mockRejectedValueOnce(
      new HttpError(401, 'Invalid email or password'),
    )
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.sessionExpired)

    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.signInEmail), 'ada@example.com')
    await u.type(screen.getByLabelText(en.signInPassword), 'wrong')
    await u.click(screen.getByRole('button', { name: en.signInSubmit }))
    await waitFor(() => screen.getByText(en.signInInvalid))

    let resolveSecond!: (v: LoginResponse) => void
    vi.mocked(postLogin).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
    )
    await u.click(screen.getByRole('button', { name: en.signInSubmit }))
    // While the second attempt is pending: neither the first attempt's
    // error nor the original sessionExpired notice should be showing.
    expect(screen.queryByText(en.signInInvalid)).toBeNull()
    expect(screen.queryByText(en.sessionExpired)).toBeNull()

    resolveSecond({ token: 'tok', refresh_token: null, expires_at: null, user: user() })
    await waitFor(() => screen.getByTestId('app-sentinel'))
  })

  it('under StrictMode, mounting issues exactly one /api/auth/me request', async () => {
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    vi.mocked(getMe).mockResolvedValue(user())
    render(
      <StrictMode>
        <LoginGate>
          <Sentinel />
        </LoginGate>
      </StrictMode>,
    )
    await waitFor(() => screen.getByTestId('app-sentinel'))
    expect(getMe).toHaveBeenCalledTimes(1)
  })

  it('renders ResetPasswordForm when the URL carries a recovery link, and strips the URL after mount', () => {
    window.history.pushState({}, '', '/#token_hash=abc123&type=recovery')
    useStore.setState({ authStatus: 'anonymous' })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.resetHeading)
    expect(screen.queryByLabelText(en.signInEmail)).toBeNull()
    // Mutation pin (b): dropping the gate's history.replaceState() call
    // would leave this fragment in place.
    expect(window.location.hash).toBe('')
  })

  it('renders ResetPasswordForm instead of the children when the tab is already authenticated (finding 7)', () => {
    window.history.pushState({}, '', '/#token_hash=abc123&type=recovery')
    useStore.setState({ token: 'tok', user: user(), authStatus: 'authenticated' })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.resetHeading)
    // The recovery link must not be silently burned by falling through to
    // the already-authenticated app.
    expect(screen.queryByTestId('app-sentinel')).toBeNull()
  })

  it('ignores an unrecognised `type` value on the URL and shows the ordinary login form', () => {
    window.history.pushState({}, '', '/#token_hash=abc123&type=bogus')
    useStore.setState({ authStatus: 'anonymous' })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByLabelText(en.signInEmail)
    expect(screen.queryByText(en.resetHeading)).toBeNull()
  })

  it('a successful reset confirm shows the success message, then returns to sign-in via its button', async () => {
    window.history.pushState({}, '', '/#token_hash=abc123&type=recovery')
    useStore.setState({ authStatus: 'anonymous' })
    vi.mocked(postResetConfirm).mockResolvedValue(undefined)
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword123')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'newpassword123')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    await waitFor(() =>
      expect(postResetConfirm).toHaveBeenCalledWith('abc123', 'recovery', 'newpassword123'),
    )
    await waitFor(() => screen.getByText(en.resetSuccess))
    expect(screen.queryByTestId('app-sentinel')).toBeNull() // no auto-login

    await u.click(screen.getByRole('button', { name: en.resetBackToSignIn }))
    screen.getByLabelText(en.signInEmail)
  })

  it('a mismatched confirm shows resetMismatch without calling the API', async () => {
    window.history.pushState({}, '', '/#token_hash=abc123&type=recovery')
    useStore.setState({ authStatus: 'anonymous' })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword123')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'somethingelse')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    screen.getByText(en.resetMismatch)
    expect(postResetConfirm).not.toHaveBeenCalled()
  })

  it('a 422 invalid_or_expired_link on confirm shows resetLinkInvalid', async () => {
    window.history.pushState({}, '', '/#token_hash=abc123&type=invite')
    useStore.setState({ authStatus: 'anonymous' })
    vi.mocked(postResetConfirm).mockRejectedValue(
      new HttpError(422, 'POST /api/auth/reset-confirm failed: 422', 'invalid_or_expired_link'),
    )
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.inviteHeading) // type=invite picks the invite heading
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword123')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'newpassword123')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    await waitFor(() => screen.getByText(en.resetLinkInvalid))
  })

  it('a non-invalid-link error on confirm falls back to the neutral password-change message, not sign-in-failed (Copilot round 3)', async () => {
    window.history.pushState({}, '', '/#token_hash=abc123&type=recovery')
    useStore.setState({ authStatus: 'anonymous' })
    vi.mocked(postResetConfirm).mockRejectedValue(new HttpError(500, 'Internal error'))
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword123')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'newpassword123')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))

    await waitFor(() => screen.getByText(en.passwordFailed))
  })

  it('shows the forgot-password link when authFeatures.password_reset is true', () => {
    useStore.setState({
      authStatus: 'anonymous',
      authFeatures: { password_reset: true, invites: false },
    })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.forgotPassword)
  })

  it('hides the forgot-password link when authFeatures.password_reset is false', () => {
    // Mutation pin (a): with the `authFeatures?.password_reset` conditional
    // dropped from LoginForm, this direction fails while the test above
    // still passes — asserting both directions is what actually pins it.
    useStore.setState({
      authStatus: 'anonymous',
      authFeatures: { password_reset: false, invites: true },
    })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    expect(screen.queryByText(en.forgotPassword)).toBeNull()
  })

  it('also hides the forgot-password link before the health fetch has resolved', () => {
    useStore.setState({ authStatus: 'anonymous', authFeatures: null })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    expect(screen.queryByText(en.forgotPassword)).toBeNull()
  })

  it('clicking forgot-password prefills ForgotPasswordForm and shows the neutral sent message on success', async () => {
    useStore.setState({
      authStatus: 'anonymous',
      authFeatures: { password_reset: true, invites: false },
    })
    vi.mocked(postResetRequest).mockResolvedValue(undefined)
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.signInEmail), 'ada@example.com')
    await u.click(screen.getByText(en.forgotPassword))

    const emailInput = screen.getByLabelText(en.resetEmailLabel) as HTMLInputElement
    expect(emailInput.value).toBe('ada@example.com')

    await u.click(screen.getByRole('button', { name: en.resetRequestSubmit }))
    await waitFor(() => screen.getByText(en.resetRequestSent))
    expect(postResetRequest).toHaveBeenCalledWith('ada@example.com')
  })

  it('shows the same neutral sent message even when the reset request throws (enumeration-neutral)', async () => {
    useStore.setState({
      authStatus: 'anonymous',
      authFeatures: { password_reset: true, invites: false },
    })
    vi.mocked(postResetRequest).mockRejectedValue(new HttpError(500, 'boom'))
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.click(screen.getByText(en.forgotPassword))
    await u.type(screen.getByLabelText(en.resetEmailLabel), 'nobody@example.com')
    await u.click(screen.getByRole('button', { name: en.resetRequestSubmit }))

    await waitFor(() => screen.getByText(en.resetRequestSent))
  })

  it('the back link from ForgotPasswordForm returns to the ordinary login form', async () => {
    useStore.setState({
      authStatus: 'anonymous',
      authFeatures: { password_reset: true, invites: false },
    })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    const u = userEvent.setup()
    await u.click(screen.getByText(en.forgotPassword))
    screen.getByLabelText(en.resetEmailLabel)
    await u.click(screen.getByText(en.backToSignIn))
    screen.getByLabelText(en.signInEmail)
  })

  it('keeps the forgot-password affordance after logout (authFeatures survives resetSessionState)', async () => {
    // Mutation pin (c): removing 'authFeatures' from store.ts's
    // reset-exclusion union makes resetSessionState() null this field on
    // every logout, and this assertion fails.
    useStore.setState({
      token: 'tok',
      user: user(),
      authStatus: 'authenticated',
      authFeatures: { password_reset: true, invites: false },
    })
    // The gate's own restoreSession() mount effect also fires here (token is
    // set) — give it something to resolve to, or its loadUserPrefs(user.id)
    // throws on an undefined user and the resulting restoreFailed:true would
    // mask the very state this test means to exercise.
    vi.mocked(getMe).mockResolvedValue(user())
    vi.mocked(postLogout).mockResolvedValue(undefined)
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByTestId('app-sentinel')

    logout()

    await waitFor(() => screen.getByLabelText(en.signInEmail))
    screen.getByText(en.forgotPassword)
  })
})
