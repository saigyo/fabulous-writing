// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'

// Only postLogin is replaced: postPasswordChange, HttpError etc. stay real,
// so tests exercise the actual request()/fetch path (and can assert on the
// Authorization header) while the *re-login* leg is driven directly, the
// same seam session.test.ts and LoginGate.test.tsx already use.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postLogin: vi.fn(),
}))
// session.ts (imported transitively via login/logout/expireSession) pulls in
// documents.ts's full hydration chain; only these two exports are needed.
vi.mock('../documents/documents', () => ({
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))

import { postLogin } from '../api/client'
import * as sessionModule from './session'
import { AccountMenu } from './AccountMenu'

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

function noContent(): Response {
  return new Response(null, { status: 204 })
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function openMenu(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole('button', { name: en.accountMenu }))
}

async function openPasswordForm(u: ReturnType<typeof userEvent.setup>) {
  await openMenu(u)
  await u.click(screen.getByRole('button', { name: en.accountChangePassword }))
}

interface PasswordFormValues {
  current?: string
  next?: string
  confirm?: string
}

async function fillPasswordForm(
  u: ReturnType<typeof userEvent.setup>,
  { current = 'old-secret', next = 'new-secret1', confirm }: PasswordFormValues = {},
) {
  await u.type(screen.getByLabelText(en.passwordCurrent), current)
  await u.type(screen.getByLabelText(en.passwordNew), next)
  await u.type(screen.getByLabelText(en.passwordConfirm), confirm ?? next)
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  useStore.setState({
    token: 'tok',
    user: user(),
    authStatus: 'authenticated',
    sessionExpired: false,
    restoreFailed: false,
    uiLocale: 'en', // pins the catalog so message assertions are deterministic
  })
})

describe('AccountMenu', () => {
  it('shows the signed-in email and offers change-password and log-out', async () => {
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openMenu(u)
    screen.getByText('ada@example.com')
    screen.getByRole('button', { name: en.accountChangePassword })
    screen.getByRole('button', { name: en.accountLogOut })
  })

  it('log-out calls logout(), clearing auth state', async () => {
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openMenu(u)
    await u.click(screen.getByRole('button', { name: en.accountLogOut }))

    const state = useStore.getState()
    expect(state.authStatus).toBe('anonymous')
    expect(state.token).toBeNull()
    expect(state.user).toBeNull()
  })

  it('the change request carries the Authorization header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(noContent())
    vi.mocked(postLogin).mockResolvedValueOnce({ token: 'new-tok', user: user() })
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('a 422 wrong_current_password shows passwordCurrentWrong and does not log the user out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(422, { detail: { code: 'wrong_current_password' } }),
    )
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() => screen.getByText(en.passwordCurrentWrong))
    expect(useStore.getState().authStatus).toBe('authenticated')
    expect(postLogin).not.toHaveBeenCalled()
  })

  it('the form pre-validates against MIN_PASSWORD_LENGTH so the common case never reaches the server', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u, { next: 'short', confirm: 'short' })
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    screen.getByText(en.passwordTooShort(8))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a 422 password_too_short from the server shows passwordTooShort', async () => {
    // The client's own pre-validation would normally catch this, but the
    // server is the source of truth for the discriminator — this pins the
    // mapping end to end for whatever the server actually emits.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(422, { detail: { code: 'password_too_short' } }),
    )
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() => screen.getByText(en.passwordTooShort(8)))
  })

  it('a 422 with an unrecognised code shows the generic passwordFailed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(422, { detail: { code: 'something_new' } }),
    )
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() => screen.getByText(en.passwordFailed))
  })

  it('a 422 with bare status and no code shows passwordFailed, not passwordTooShort', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(422, {}))
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() => screen.getByText(en.passwordFailed))
    expect(screen.queryByText(en.passwordTooShort(8))).toBeNull()
  })

  it('a 401 from this endpoint ends the session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(401, {}))
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() => expect(useStore.getState().authStatus).toBe('anonymous'))
    expect(useStore.getState().sessionExpired).toBe(true)
    expect(postLogin).not.toHaveBeenCalled()
  })

  it('mismatched new/confirm shows passwordMismatch and sends no request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u, { next: 'new-secret1', confirm: 'new-secret2' })
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    screen.getByText(en.passwordMismatch)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a successful change leaves the user signed in and shows passwordChanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(noContent())
    vi.mocked(postLogin).mockResolvedValueOnce({ token: 'new-tok', user: user() })
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u, { next: 'new-secret1' })
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() =>
      expect(postLogin).toHaveBeenCalledWith('ada@example.com', 'new-secret1'),
    )
    await waitFor(() => screen.getByText(en.passwordChanged))
    const state = useStore.getState()
    expect(state.authStatus).toBe('authenticated')
    expect(state.token).toBe('new-tok')
  })

  it('when the silent re-login itself fails, expireSession() runs instead of showing an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(noContent())
    vi.mocked(postLogin).mockRejectedValueOnce(new Error('network down'))
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() => expect(useStore.getState().authStatus).toBe('anonymous'))
    expect(useStore.getState().sessionExpired).toBe(true)
    // Not surfaced as a form error — the change genuinely succeeded, so the
    // gate's session-expired notice is the only message, not passwordFailed.
    expect(screen.queryByText(en.passwordFailed)).toBeNull()
    expect(screen.queryByText(en.passwordChanged)).toBeNull()
  })

  it('logging out while the password request is pending abandons the completion silently', async () => {
    let resolveFetch!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))

    // Dismiss the popover, reopen it, and log out — all while the request
    // above is still in flight.
    fireEvent.mouseDown(document.body)
    await openMenu(u)
    await u.click(screen.getByRole('button', { name: en.accountLogOut }))
    expect(useStore.getState().authStatus).toBe('anonymous')

    // The in-flight request's 204 lands now, long after the user logged out.
    resolveFetch(noContent())
    await waitFor(() => expect(useStore.getState().authStatus).toBe('anonymous'))
    expect(postLogin).not.toHaveBeenCalled() // abandoned before ever re-authenticating
  })

  it('logging out while the silent re-login is pending abandons the completion silently', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(noContent())
    let resolvePostLogin!: (v: { token: string; user: MeResponse }) => void
    vi.mocked(postLogin).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePostLogin = resolve
        }),
    )
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u, { next: 'new-secret1' })
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))
    await waitFor(() =>
      expect(postLogin).toHaveBeenCalledWith('ada@example.com', 'new-secret1'),
    )

    // Dismiss the popover, reopen it, and log out — the 204 already landed,
    // but the silent re-login it triggered is still in flight.
    fireEvent.mouseDown(document.body)
    await openMenu(u)
    await u.click(screen.getByRole('button', { name: en.accountLogOut }))
    expect(useStore.getState().authStatus).toBe('anonymous')

    // login()'s own generation guard discards this rather than committing it.
    resolvePostLogin({ token: 'new-tok', user: user() })
    await waitFor(() => expect(postLogin).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0)) // let the resolved promise chain settle
    expect(useStore.getState().token).toBeNull()
    expect(useStore.getState().authStatus).toBe('anonymous')
    // Not just "no re-login" (already covered by the token/authStatus checks
    // above) — the abandoned completion must not surface passwordChanged
    // either, since the session it belonged to is gone.
    expect(screen.queryByText(en.passwordChanged)).toBeNull()
  })

  it('an outside click dismisses the popover; reopening shows the menu, not the password form', async () => {
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    screen.getByLabelText(en.passwordCurrent)

    fireEvent.mouseDown(document.body)
    expect(screen.queryByLabelText(en.passwordCurrent)).toBeNull()

    await openMenu(u)
    screen.getByRole('button', { name: en.accountChangePassword })
    expect(screen.queryByLabelText(en.passwordCurrent)).toBeNull()
  })

  it('Escape dismisses the popover; reopening shows the menu, not the password form', async () => {
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await u.click(screen.getByLabelText(en.passwordCurrent)) // focus inside the popover
    await u.keyboard('{Escape}')
    expect(screen.queryByLabelText(en.passwordCurrent)).toBeNull()

    await openMenu(u)
    screen.getByRole('button', { name: en.accountChangePassword })
    expect(screen.queryByLabelText(en.passwordCurrent)).toBeNull()
  })

  it('Cancel dismisses the popover; reopening shows the menu, not the password form', async () => {
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await u.click(screen.getByRole('button', { name: en.passwordCancel }))
    expect(screen.queryByLabelText(en.passwordCurrent)).toBeNull()

    await openMenu(u)
    screen.getByRole('button', { name: en.accountChangePassword })
    expect(screen.queryByLabelText(en.passwordCurrent)).toBeNull()
  })

  it('does not show passwordChanged when login() resolves false (session moved during the re-login itself)', async () => {
    // Pins guard #2 in isolation from login()'s own generation check (already
    // covered by session.test.ts and by the "pending" tests above): even
    // when login() resolves without throwing, a `false` result means the
    // session moved while it was in flight and the completion must still be
    // abandoned — no success message. Spying on session.ts's own `login`
    // lets this be asserted without a real logout/login round trip, which
    // would otherwise remount PasswordForm (clearing the form) and make the
    // very message this test is pinning impossible to observe either way.
    const loginSpy = vi.spyOn(sessionModule, 'login').mockResolvedValueOnce(false)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(noContent())
    const u = userEvent.setup()
    render(<AccountMenu />)
    await openPasswordForm(u)
    await fillPasswordForm(u, { next: 'new-secret1' })
    await u.click(screen.getByRole('button', { name: en.passwordSubmit }))

    await waitFor(() =>
      expect(loginSpy).toHaveBeenCalledWith('ada@example.com', 'new-secret1'),
    )
    // Give the resolved (not rejected) `false` a tick to flow through the
    // component's own .then() chain.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(en.passwordChanged)).toBeNull()
    expect(useStore.getState().authStatus).toBe('authenticated') // untouched — no expiry either
  })
})
