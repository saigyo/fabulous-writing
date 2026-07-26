// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bumpGeneration, resetAutosaveForTests } from './documents/autosave'
import { useStore } from './state/store'
import type { Profile } from './types'

// Only the catalog fetches Header's mount effect fires, plus getProfiles
// (the effect under test), are replaced — everything else in api/client
// stays real but unused by Header.
vi.mock('./api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/client')>()),
  getProviders: vi.fn().mockResolvedValue([]),
  getDomains: vi.fn().mockResolvedValue([]),
  getLanguages: vi.fn().mockResolvedValue([]),
  getRouting: vi.fn().mockResolvedValue(null),
  getProfiles: vi.fn(),
}))
vi.mock('./checking/controller', () => ({ runCheck: vi.fn() }))
vi.mock('./header/DomainMultiSelect', () => ({ DomainMultiSelect: () => null }))
vi.mock('./header/LlmSelector', () => ({ LlmSelector: () => null }))
vi.mock('./header/ProfileSelector', () => ({ ProfileSelector: () => null }))
vi.mock('./auth/AccountMenu', () => ({ AccountMenu: () => null }))

import { getProfiles } from './api/client'
import { Header } from './App'

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
    language: 'en',
    domainIds: [],
    provider: 'ollama',
    model: null,
    tier: 'balanced',
    profiles: [],
    profileId: null,
    lastProfileByLanguage: {},
    docMeta: null,
    uiLocale: 'en',
  })
})

describe('Header profile-fetch generation guard', () => {
  it('applies the resolved profile list and selection when no session change occurred', async () => {
    vi.mocked(getProfiles).mockResolvedValue([profile()])
    render(<Header />)
    await waitFor(() => expect(useStore.getState().profiles).toHaveLength(1))
    // isSwitch is false on the very first fetch (no previous language to
    // switch from), so only the list and the remembered selection apply —
    // not the profile's header values (domainIds/tier/...), matching
    // applyHeaderProfileSelection()'s isSwitch-gated apply.
    expect(useStore.getState().profileId).toBe(1)
  })

  it('discards a getProfiles response that resolves after the session ended (logout/expiry mid-flight)', async () => {
    // Pins the fix for App.tsx's Header profile-fetch effect: without the
    // generation guard, user A's profile list and header selection
    // (domainIds/provider/model/tier) land in user B's store once A's
    // request finally resolves — even though B has since logged in.
    //
    // isSwitch must be true for this to exercise the risky branch
    // (applyHeaderProfileSelection actually applying domainIds/tier/...), so
    // this first lets the initial mount fetch settle, then triggers a real
    // language switch before capturing the in-flight request.
    vi.mocked(getProfiles).mockResolvedValueOnce([])
    render(<Header />)
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(1))

    let resolveProfiles!: (p: Profile[]) => void
    vi.mocked(getProfiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProfiles = resolve
        }),
    )
    useStore.setState({ language: 'de' })
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(2))

    // Simulate the session ending (logout/expireSession bumps this counter
    // via invalidateDocumentWork()) while user A's request is still pending,
    // and user B's own session setting a different domainIds selection.
    bumpGeneration()
    useStore.setState({ domainIds: [99] })

    resolveProfiles([profile({ is_standard: true, domain_ids: [42] })])
    await new Promise((r) => setTimeout(r, 0))

    expect(useStore.getState().profiles).toHaveLength(0) // A's list never lands
    expect(useStore.getState().profileId).toBeNull() // A's selection never lands
    expect(useStore.getState().domainIds).toEqual([99]) // B's own choice survives
  })
})
