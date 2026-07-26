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

  it('shows the sessionExpired notice above the form when set', () => {
    useStore.setState({ authStatus: 'anonymous', sessionExpired: true })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.sessionExpired)
    screen.getByLabelText(en.signInEmail)
    expect(screen.queryByTestId('app-sentinel')).toBeNull()
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
