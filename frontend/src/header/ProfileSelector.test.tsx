// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { Profile } from '../types'
import { bumpGeneration, resetAutosaveForTests } from '../documents/autosave'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  updateProfile: vi.fn(),
}))

import type { MeResponse } from '../api/client'
import { updateProfile } from '../api/client'
import { ProfileSelector } from './ProfileSelector'

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

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    language: 'en',
    name: 'Standard',
    is_standard: true,
    categories_off: [],
    rule_exceptions: [],
    packs_on: [],
    domain_ids: [7],
    llm_provider: null,
    llm_model: null,
    llm_tier: 'quality',
    llm_instructions: '',
    example_text: '',
    is_global: true,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  resetAutosaveForTests()
  useStore.setState({
    // Admin by default: these tests exercise the generation guard, not
    // ownership, and the fixture profile is global — a non-admin would hit
    // the new readOnly gate (see the ownership describe block below).
    user: user({ is_admin: true }),
    profiles: [profile()],
    profileId: 1,
    // Differs from the stored profile's domain_ids ([7]) so isProfileDirty()
    // shows the Save-to-profile button.
    domainIds: [8],
    tier: 'quality',
    provider: 'ollama',
    model: null,
    uiLocale: 'en',
  })
})

describe('ProfileSelector saveOverrides generation guard', () => {
  it('writes the saved profile into the store when no session change occurred', async () => {
    vi.mocked(updateProfile).mockResolvedValue(profile({ domain_ids: [8] }))
    const u = userEvent.setup()
    render(<ProfileSelector />)
    await u.click(screen.getByTitle(en.saveToProfile))

    await waitFor(() =>
      expect(useStore.getState().profiles[0].domain_ids).toEqual([8]),
    )
  })

  it('discards a saveOverrides response that resolves after the session ended (logout/expiry mid-flight)', async () => {
    // Pins the fix: without the generation guard, this write also uses a
    // pre-await captured `profiles` array, so a session turnover mid-request
    // would clobber whatever the incoming session has since done with
    // `profiles` with the outgoing session's stale array.
    let resolveUpdate!: (p: Profile) => void
    vi.mocked(updateProfile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve
        }),
    )
    const u = userEvent.setup()
    render(<ProfileSelector />)
    await u.click(screen.getByTitle(en.saveToProfile))
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1))

    // Simulate the session ending while the request is in flight, and the
    // incoming session adding a second profile to the store.
    bumpGeneration()
    const incoming = [profile(), profile({ id: 2, name: 'Incoming' })]
    useStore.setState({ profiles: incoming })

    resolveUpdate(profile({ domain_ids: [8] }))
    await new Promise((r) => setTimeout(r, 0))

    expect(useStore.getState().profiles).toEqual(incoming)
  })
})

describe('ProfileSelector ownership affordances (non-admin)', () => {
  it('hides the save-to-profile control on a global profile but keeps reset available', async () => {
    useStore.setState({ user: user({ is_admin: false }) })
    render(<ProfileSelector />)

    expect(screen.queryByTitle(en.saveToProfile)).toBeNull()
    screen.getByTitle(en.resetToProfile)
  })

  it('surfaces a saveOverrides rejection instead of an unhandled rejection', async () => {
    // Pins the fix: saveOverrides used to be an un-caught `void`-called
    // async function — a rejection (e.g. a stale 403) vanished into an
    // unhandled promise rejection with no visible affordance.
    useStore.setState({
      user: user({ is_admin: true }),
      profiles: [profile({ is_global: false })],
    })
    vi.mocked(updateProfile).mockRejectedValueOnce(new Error('boom'))
    const u = userEvent.setup()
    render(<ProfileSelector />)
    await u.click(screen.getByTitle(en.saveToProfile))

    await waitFor(() =>
      expect(screen.getByTitle(en.profileChangeFailed('boom'))).toBeTruthy(),
    )
  })

  it('exposes the saveOverrides failure to assistive tech via role="alert"', async () => {
    // Pins the fix: the warning used to be surfaced only via a mouse-hover
    // `title`, so keyboard/screen-reader users got no notification at all.
    useStore.setState({
      user: user({ is_admin: true }),
      profiles: [profile({ is_global: false })],
    })
    vi.mocked(updateProfile).mockRejectedValueOnce(new Error('boom'))
    const u = userEvent.setup()
    render(<ProfileSelector />)
    await u.click(screen.getByTitle(en.saveToProfile))

    await waitFor(() =>
      expect(screen.getByRole('alert').getAttribute('aria-label')).toBe(
        en.profileChangeFailed('boom'),
      ),
    )
  })
})

describe('ProfileSelector option text disambiguation', () => {
  it('appends the built-in marker to a global profile option but not to a private one of the same name', () => {
    // Per-owner uniqueness allows a private profile to shadow a global name
    // (including "Standard") — the option text is the only thing that
    // distinguishes them since a <select> can't render the styled badge.
    useStore.setState({
      user: user({ is_admin: true }),
      profiles: [
        profile({ id: 1, name: 'Standard', is_global: true }),
        profile({ id: 2, name: 'Standard', is_global: false }),
      ],
      profileId: 1,
      domainIds: [7],
    })
    render(<ProfileSelector />)

    const globalOption = screen.getByText(`Standard — ${en.globalBadge}`, {
      selector: 'option',
    }) as HTMLOptionElement
    expect(globalOption.value).toBe('1')
    const privateOption = screen.getByText('Standard', {
      exact: true,
      selector: 'option',
    }) as HTMLOptionElement
    expect(privateOption.value).toBe('2')
  })
})
