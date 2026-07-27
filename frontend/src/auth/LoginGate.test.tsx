// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, type MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postLogin: vi.fn(),
  getMe: vi.fn(),
}))
// Same reasoning as session.test.ts: documents.ts pulls in hydration.ts ->
// checking/controller.ts, which session.ts (imported for real below) only
// needs two exports from.
vi.mock('../documents/documents', () => ({
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))

import { getMe, postLogin } from '../api/client'
import { LoginGate } from './LoginGate'

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
    usage: { used_today: 0, limit: 500 },
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
})

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  useStore.setState({
    token: null,
    user: null,
    authStatus: 'unknown',
    sessionExpired: false,
    restoreFailed: false,
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
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', user: user() })
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

    let resolveSecond!: (v: { token: string; user: MeResponse }) => void
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

    resolveSecond({ token: 'tok', user: user() })
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
})
