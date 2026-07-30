// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminUser, MeResponse } from '../api/client'
import { HttpError } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'

// getAdminUsers/getAdminTiers/postAdminUser/patchAdminUser are mocked; every
// other export (HttpError, ADMIN_MIN_PASSWORD_LENGTH, ...) stays real via the
// importOriginal spread — same idiom App.test.tsx uses for Header.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getAdminUsers: vi.fn(),
  getAdminTiers: vi.fn(),
  postAdminUser: vi.fn(),
  patchAdminUser: vi.fn(),
}))
// sessionGeneration is mocked so the turnover tests below can move the
// generation mid-flight without going through a real login()/logout() (which
// pull in document-buffer and in-flight-check modules AdminView never
// touches). Every other test in this file leaves it at its default (a
// constant, like the real module before any login/logout), so the six
// `sessionGeneration()` guards in AdminView.tsx stay transparent everywhere
// except the two turnover tests that deliberately move it.
vi.mock('../auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/session')>()),
  sessionGeneration: vi.fn(() => 0),
}))

import { getAdminTiers, getAdminUsers, patchAdminUser, postAdminUser } from '../api/client'
import { sessionGeneration } from '../auth/session'
import { AdminView } from './AdminView'

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: true,
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

function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: true,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    external_id: null,
    password_changed_at: null,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks() only resets call history, not queued mockReturnValueOnce
  // sequences from a prior test's turnover setup — reset() clears those too,
  // then the plain default is reinstated.
  vi.mocked(sessionGeneration).mockReset().mockReturnValue(0)
  useStore.setState({
    token: 'tok',
    user: user(),
    authStatus: 'authenticated',
    uiLocale: 'en',
  })
})

describe('AdminView', () => {
  it('mount fetches users and tiers, renders one row per user', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 1, email: 'ada@example.com' }),
      adminUser({ id: 2, email: 'bea@example.com', is_admin: false }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic', 'pro'])

    render(<AdminView />)

    await screen.findByText('bea@example.com')
    expect(getAdminUsers).toHaveBeenCalledTimes(1)
    expect(getAdminTiers).toHaveBeenCalledTimes(1)
    expect(screen.getByText('ada@example.com')).toBeTruthy()
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + 2 users
  })

  it('load failure shows adminLoadFailed and no rows', async () => {
    vi.mocked(getAdminUsers).mockRejectedValue(new Error('network down'))
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])

    render(<AdminView />)

    await screen.findByText(en.adminLoadFailed)
    expect(screen.getAllByRole('row')).toHaveLength(1) // header only, no data rows
  })

  it('create submits the form payload and appends the returned user', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic', 'pro'])
    vi.mocked(postAdminUser).mockResolvedValue(
      adminUser({ id: 9, email: 'new@example.com', tier: 'pro' }),
    )
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('basic') // tiers loaded, select populated

    await u.type(screen.getByLabelText(en.adminEmail), 'new@example.com')
    await u.type(screen.getByLabelText(en.adminDisplayName), 'New User')
    await u.type(screen.getByLabelText(en.adminPassword), 'a-long-enough-password')
    await u.selectOptions(screen.getByLabelText(en.adminTier), 'pro')
    await u.click(screen.getByRole('button', { name: en.adminCreate }))

    await screen.findByText('new@example.com')
    expect(postAdminUser).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'a-long-enough-password',
      display_name: 'New User',
      tier: 'pro',
      is_admin: false,
    })
  })

  it('create pre-validates the 12-char password floor without calling the API', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('basic')

    await u.type(screen.getByLabelText(en.adminEmail), 'new@example.com')
    await u.type(screen.getByLabelText(en.adminPassword), 'short11')
    await u.click(screen.getByRole('button', { name: en.adminCreate }))

    await screen.findByText(en.passwordTooShort(12))
    expect(postAdminUser).not.toHaveBeenCalled()
  })

  it('create failure (422 duplicate email) surfaces the formatted error', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])
    vi.mocked(postAdminUser).mockRejectedValue(
      new HttpError(422, 'POST /api/admin/users failed: 422'),
    )
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('basic')

    await u.type(screen.getByLabelText(en.adminEmail), 'dup@example.com')
    await u.type(screen.getByLabelText(en.adminPassword), 'a-long-enough-password')
    await u.click(screen.getByRole('button', { name: en.adminCreate }))

    await screen.findByText(en.adminChangeFailed('POST /api/admin/users failed: 422'))
  })

  it('admin checkbox in the create form is disabled with a hint while allow_additional_admins is false', () => {
    useStore.setState({ user: user({ allow_additional_admins: false }) })
    vi.mocked(getAdminUsers).mockResolvedValue([])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])

    render(<AdminView />)

    const checkbox = screen.getByLabelText(en.adminIsAdmin) as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    expect(checkbox.closest('label')?.getAttribute('title')).toBe(en.adminGrantDisabledHint)
  })

  it('create stays disabled until tiers load, and a tiers failure keeps it disabled with the error shown', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([adminUser()])
    let rejectTiers!: (e: unknown) => void
    vi.mocked(getAdminTiers).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectTiers = reject
        }),
    )
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('ada@example.com') // users loaded already

    await u.type(screen.getByLabelText(en.adminEmail), 'new@example.com')
    await u.type(screen.getByLabelText(en.adminPassword), 'a-long-enough-password')
    const button = screen.getByRole('button', { name: en.adminCreate }) as HTMLButtonElement
    expect(button.disabled).toBe(true) // tiers not loaded yet

    // `button.removeAttribute('disabled')` does not make a click reach
    // `onClick` here: React suppresses its own synthetic dispatch for
    // interactive elements (button/input/select/textarea) whenever the
    // *props* it last rendered say `disabled: true`, regardless of what the
    // live DOM attribute says (react-dom's getListener special-cases
    // exactly this). Pulling the handler straight off the fiber and calling
    // it directly is what actually bypasses the button, the way a stray
    // Enter-key repeat or a programmatic dispatch could — and is the only
    // way to exercise create()'s own `!tiers` guard for real.
    const reactProps = Object.entries(button).find(([key]) =>
      key.startsWith('__reactProps$'),
    )?.[1] as { onClick?: () => void } | undefined
    reactProps?.onClick?.()
    expect(postAdminUser).not.toHaveBeenCalled()

    rejectTiers(new Error('tiers unavailable'))
    await screen.findByText(en.adminLoadFailed)
    expect(button.disabled).toBe(true)
  })

  it('create stays disabled while the user list is still loading even though tiers have loaded', async () => {
    let resolveUsers!: (list: AdminUser[]) => void
    vi.mocked(getAdminUsers).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUsers = resolve
        }),
    )
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('basic') // tiers loaded, select populated

    await u.type(screen.getByLabelText(en.adminEmail), 'new@example.com')
    await u.type(screen.getByLabelText(en.adminPassword), 'a-long-enough-password')
    const button = screen.getByRole('button', { name: en.adminCreate }) as HTMLButtonElement
    expect(button.disabled).toBe(true) // user list not loaded yet

    // Same fiber-props bypass as the !tiers guard test above: React won't
    // dispatch a synthetic click to a button it rendered as disabled, so
    // this is the only way to exercise create()'s own !usersLoaded guard.
    const reactProps = Object.entries(button).find(([key]) =>
      key.startsWith('__reactProps$'),
    )?.[1] as { onClick?: () => void } | undefined
    reactProps?.onClick?.()
    expect(postAdminUser).not.toHaveBeenCalled()

    resolveUsers([])
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it('changing a row tier PATCHes {tier} and updates the row', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 1, email: 'ada@example.com' }),
      adminUser({ id: 2, email: 'bea@example.com', tier: 'basic', is_admin: false }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic', 'pro'])
    vi.mocked(patchAdminUser).mockResolvedValue(
      adminUser({ id: 2, email: 'bea@example.com', tier: 'pro', is_admin: false }),
    )
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('bea@example.com')

    const select = screen.getByLabelText(`${en.adminTier}: bea@example.com`) as HTMLSelectElement
    await u.selectOptions(select, 'pro')

    expect(patchAdminUser).toHaveBeenCalledWith(2, { tier: 'pro' })
    await screen.findByDisplayValue('pro')
    expect(select.value).toBe('pro')
  })

  it('deactivating another user PATCHes {is_active:false}', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 1, email: 'ada@example.com' }),
      adminUser({ id: 2, email: 'bea@example.com', is_admin: false, is_active: true }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])
    vi.mocked(patchAdminUser).mockResolvedValue(
      adminUser({ id: 2, email: 'bea@example.com', is_admin: false, is_active: false }),
    )
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('bea@example.com')

    const checkbox = screen.getByLabelText(
      `${en.adminIsActive}: bea@example.com`,
    ) as HTMLInputElement
    await u.click(checkbox)

    expect(patchAdminUser).toHaveBeenCalledWith(2, { is_active: false })
    await screen.findByText('bea@example.com') // re-render after update
    expect(checkbox.checked).toBe(false)
    expect(checkbox.closest('tr')?.className).toBe('admin-inactive')
  })

  it('own row admin and active controls are disabled', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 1, email: 'ada@example.com', is_admin: true }),
      adminUser({ id: 2, email: 'bea@example.com', is_admin: true }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])

    render(<AdminView />)
    await screen.findByText('bea@example.com')

    const selfAdmin = screen.getByLabelText(
      `${en.adminIsAdmin}: ada@example.com`,
    ) as HTMLInputElement
    const selfActive = screen.getByLabelText(
      `${en.adminIsActive}: ada@example.com`,
    ) as HTMLInputElement
    const otherAdmin = screen.getByLabelText(
      `${en.adminIsAdmin}: bea@example.com`,
    ) as HTMLInputElement
    const otherActive = screen.getByLabelText(
      `${en.adminIsActive}: bea@example.com`,
    ) as HTMLInputElement

    expect(selfAdmin.disabled).toBe(true)
    expect(selfActive.disabled).toBe(true)
    expect(otherAdmin.disabled).toBe(false)
    expect(otherActive.disabled).toBe(false)
  })

  it('promote control is disabled while allow_additional_admins is false, demotion stays enabled', async () => {
    useStore.setState({ user: user({ id: 1, allow_additional_admins: false }) })
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 1, email: 'ada@example.com', is_admin: true }),
      adminUser({ id: 2, email: 'bea@example.com', is_admin: false }), // promote target
      adminUser({ id: 3, email: 'cid@example.com', is_admin: true }), // demote target
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])

    render(<AdminView />)
    await screen.findByText('cid@example.com')

    const promote = screen.getByLabelText(
      `${en.adminIsAdmin}: bea@example.com`,
    ) as HTMLInputElement
    const demote = screen.getByLabelText(
      `${en.adminIsAdmin}: cid@example.com`,
    ) as HTMLInputElement

    expect(promote.disabled).toBe(true)
    expect(demote.disabled).toBe(false)
  })

  it('password reset sends {password} after the 12-char pre-check, keeps the typed value on failure, clears it on success', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 2, email: 'bea@example.com' }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('bea@example.com')

    const passwordInput = screen.getByLabelText(
      `${en.adminResetPassword}: bea@example.com`,
    ) as HTMLInputElement
    const resetButton = screen.getByRole('button', { name: en.adminResetPassword })

    // Too short: pre-check blocks the call, field keeps the typed value.
    await u.type(passwordInput, 'short11')
    await u.click(resetButton)
    await screen.findByText(en.passwordTooShort(12))
    expect(patchAdminUser).not.toHaveBeenCalled()
    expect(passwordInput.value).toBe('short11')

    // Long enough, but the PATCH fails: value must survive under the error.
    await u.clear(passwordInput)
    await u.type(passwordInput, 'a-long-enough-password')
    vi.mocked(patchAdminUser).mockRejectedValueOnce(
      new HttpError(500, 'PATCH /api/admin/users/2 failed: 500'),
    )
    await u.click(resetButton)
    await screen.findByText(en.adminChangeFailed('PATCH /api/admin/users/2 failed: 500'))
    expect(passwordInput.value).toBe('a-long-enough-password')

    // Retry succeeds: field clears.
    vi.mocked(patchAdminUser).mockResolvedValueOnce(adminUser({ id: 2, email: 'bea@example.com' }))
    await u.click(resetButton)
    expect(patchAdminUser).toHaveBeenLastCalledWith(2, { password: 'a-long-enough-password' })
    await waitFor(() => expect(passwordInput.value).toBe(''))
  })

  it('reset button is disabled while the PATCH is in flight (no duplicate submission)', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 2, email: 'bea@example.com' }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])
    let resolvePatch!: (u: AdminUser) => void
    vi.mocked(patchAdminUser).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve
        }),
    )
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('bea@example.com')

    const passwordInput = screen.getByLabelText(
      `${en.adminResetPassword}: bea@example.com`,
    ) as HTMLInputElement
    const resetButton = screen.getByRole('button', {
      name: en.adminResetPassword,
    }) as HTMLButtonElement

    await u.type(passwordInput, 'a-long-enough-password')
    await u.click(resetButton)
    expect(resetButton.disabled).toBe(true)
    expect(patchAdminUser).toHaveBeenCalledTimes(1)

    // A second click while pending must not fire another PATCH. A plain
    // `fireEvent.click` here would prove nothing: React suppresses its own
    // synthetic dispatch for a disabled interactive element based on the
    // props it last rendered, so the disabled button already blocks the
    // click before resetPassword()'s own `if (resetPending) return` guard
    // ever runs. Pulling `onClick` off the fiber directly is what actually
    // bypasses the button and exercises that guard (see the analogous
    // `!tiers`-guard test above for the same technique and rationale).
    const reactProps = Object.entries(resetButton).find(([key]) =>
      key.startsWith('__reactProps$'),
    )?.[1] as { onClick?: () => void } | undefined
    reactProps?.onClick?.()
    expect(patchAdminUser).toHaveBeenCalledTimes(1)

    resolvePatch(adminUser({ id: 2, email: 'bea@example.com' }))
    await waitFor(() => expect(passwordInput.value).toBe(''))
    expect(resetButton.disabled).toBe(true) // empty field disables it again
  })

  it('display name edit PATCHes {display_name}, clearing it sends null', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 2, email: 'bea@example.com', display_name: 'Bea' }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])
    vi.mocked(patchAdminUser).mockResolvedValue(
      adminUser({ id: 2, email: 'bea@example.com', display_name: 'Beatrice' }),
    )
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('bea@example.com')

    const nameInput = screen.getByLabelText(
      `${en.adminDisplayName}: bea@example.com`,
    ) as HTMLInputElement
    expect(nameInput.value).toBe('Bea')

    await u.clear(nameInput)
    await u.type(nameInput, 'Beatrice')
    fireEvent.blur(nameInput)

    expect(patchAdminUser).toHaveBeenCalledWith(2, { display_name: 'Beatrice' })
    await screen.findByDisplayValue('Beatrice')

    vi.mocked(patchAdminUser).mockResolvedValueOnce(
      adminUser({ id: 2, email: 'bea@example.com', display_name: null }),
    )
    await u.clear(nameInput)
    fireEvent.blur(nameInput)

    expect(patchAdminUser).toHaveBeenLastCalledWith(2, { display_name: null })
    await waitFor(() => expect(nameInput.value).toBe(''))
  })

  it('a session turnover between the mount fetch and its resolution drops the response (no rows render)', async () => {
    // First call is the mount effect's capture (`gen`); every call after
    // that is one of the six `sessionGeneration() === gen` checks — moving
    // the generation there simulates a session change landing while both
    // requests are still in flight.
    vi.mocked(sessionGeneration).mockReturnValueOnce(1).mockReturnValue(2)
    vi.mocked(getAdminUsers).mockResolvedValue([adminUser({ email: 'ada@example.com' })])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])

    render(<AdminView />)

    await waitFor(() => expect(getAdminUsers).toHaveBeenCalledTimes(1))
    // Drain the .then chain before asserting (same shape as
    // App.domains-guard.test.tsx's mount-fetch turnover test): an immediate
    // check could pass merely because the fetch hasn't resolved yet, which
    // would stay green even with the guard deleted.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getAllByRole('row')).toHaveLength(1) // header only; setUsers was skipped
    expect(screen.queryByText('ada@example.com')).toBeNull()
  })

  it('a session turnover between a row save and its resolution drops the write (row unchanged, typed password kept)', async () => {
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser({ id: 2, email: 'bea@example.com' }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])
    vi.mocked(sessionGeneration).mockReturnValue(1) // stable through mount and the save's capture
    let resolvePatch!: (u: AdminUser) => void
    vi.mocked(patchAdminUser).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve
        }),
    )
    const u = userEvent.setup()

    render(<AdminView />)
    await screen.findByText('bea@example.com')

    const passwordInput = screen.getByLabelText(
      `${en.adminResetPassword}: bea@example.com`,
    ) as HTMLInputElement
    const resetButton = screen.getByRole('button', { name: en.adminResetPassword })

    await u.type(passwordInput, 'a-long-enough-password')
    await u.click(resetButton)
    expect(patchAdminUser).toHaveBeenCalledTimes(1)

    // Session turns over while the PATCH is in flight, then it resolves.
    vi.mocked(sessionGeneration).mockReturnValue(2)
    resolvePatch(adminUser({ id: 2, email: 'bea@example.com', password_changed_at: '2026-01-01T00:00:00Z' }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // save()'s own guard dropped the write: onSave resolved to `false`, so
    // resetPassword() never reached its `setNewPassword('')`.
    expect(passwordInput.value).toBe('a-long-enough-password')
    expect(screen.getByText('bea@example.com')).toBeTruthy() // row still present, untouched
  })

  it('replaces the own-row password reset with a hint', async () => {
    // store user (me) = the id-1 admin fixture, per the file's existing setup;
    // user list: self + one other row
    vi.mocked(getAdminUsers).mockResolvedValue([
      adminUser(),
      adminUser({ id: 2, email: 'bea@example.com' }),
    ])
    vi.mocked(getAdminTiers).mockResolvedValue(['basic'])

    render(<AdminView />)
    // render AdminView and await the list (file's existing pattern)
    expect(await screen.findByText(en.adminSelfResetHint)).toBeTruthy()
    // no reset controls on the own row
    expect(
      screen.queryByLabelText(`${en.adminResetPassword}: ada@example.com`),
    ).toBeNull()
    // the other row keeps its reset controls (disabled-ness follows
    // `!newPassword`, so assert presence of the button, not enabled state)
    const other = screen.getByLabelText(`${en.adminResetPassword}: bea@example.com`)
    const row = other.closest('td')!
    expect(
      within(row).getByRole('button', { name: en.adminResetPassword }),
    ).toBeTruthy()
  })
})
