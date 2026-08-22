// @vitest-environment happy-dom
//
// Mirrors App.domains-guard.test.tsx's structure, for the sibling profiles
// effect in header/useHeaderData.ts (Copilot round 11): that effect used to
// re-run only on a language change, guarded against
// documents/autosave.ts's currentGeneration() — which login() never bumps.
// A direct A->B login with the SAME language therefore neither re-fired the
// fetch (profilesReady could stay false forever) nor blocked A's still
// in-flight, owner-scoped response from landing in B's store. The fix adds
// store.authGeneration to the effect's deps (the same key the catalog
// effect above it already depends on) and swaps the guard to
// auth/session.ts's sessionGeneration(), which login() does bump.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from './api/client'
import { useStore } from './state/store'
import type { Profile } from './types'

// Only the catalog fetches Header's mount effect fires are replaced —
// everything else in api/client stays real but unused by Header.
vi.mock('./api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/client')>()),
  getProviders: vi.fn().mockResolvedValue([]),
  getDomains: vi.fn().mockResolvedValue([]),
  getLanguages: vi.fn().mockResolvedValue([]),
  getRouting: vi.fn().mockResolvedValue(null),
  getProfiles: vi.fn().mockResolvedValue([]),
  // This file renders Header directly, not LoginGate, so nothing here would
  // actually call getHealth — mocked anyway (Task 7) so a real fetch is
  // never one accidental render away.
  getHealth: vi.fn(async () => ({ status: 'ok', name: '', version: 'dev' })),
  postLogin: vi.fn(),
  // Resolved once here: the file's beforeEach uses clearAllMocks() (not
  // resetAllMocks()), which clears call history but preserves this
  // implementation — every logout() in this file runs with a real token,
  // so an unresolved postLogout() would throw on the missing .catch().
  postLogout: vi.fn().mockResolvedValue(undefined),
}))
// documents.ts pulls in hydration.ts -> checking/controller.ts; logout()
// (via auth/session.ts) only needs these two exports, so the module is
// replaced outright rather than partially mocked (matching session.test.ts).
vi.mock('./documents/documents', () => ({
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))
vi.mock('./checking/controller', () => ({ runCheck: vi.fn() }))
vi.mock('./header/DomainMultiSelect', () => ({ DomainMultiSelect: () => null }))
vi.mock('./header/LlmSelector', () => ({ LlmSelector: () => null }))
vi.mock('./header/ProfileSelector', () => ({ ProfileSelector: () => null }))
vi.mock('./auth/AccountMenu', () => ({ AccountMenu: () => null }))

import * as client from './api/client'
import { login } from './auth/session'
import { Header } from './App'

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
    db_backend: 'sqlite',
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
    domain_ids: [],
    llm_provider: null,
    llm_model: null,
    llm_tier: null,
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
  useStore.setState({
    language: 'en',
    domainIds: [],
    provider: 'ollama',
    model: null,
    tier: 'balanced',
    profiles: [],
    profileId: null,
    profilesReady: false,
    lastProfileByLanguage: {},
    docMeta: null,
    uiLocale: 'en',
    token: 'old-token',
    user: user(),
    authStatus: 'authenticated',
    domains: [],
  })
})

describe('Header profiles-fetch re-fires on a direct A->B same-language login (Copilot round 11)', () => {
  it('issues and applies a replacement profiles fetch after a same-language A->B login, while the stale A-owned fetch stays discarded', async () => {
    let resolveFirst!: (profiles: Profile[]) => void
    const firstFetch = new Promise<Profile[]>((resolve) => {
      resolveFirst = resolve
    })
    let resolveSecond!: (profiles: Profile[]) => void
    const secondFetch = new Promise<Profile[]>((resolve) => {
      resolveSecond = resolve
    })
    let getProfilesCalls = 0
    vi.spyOn(client, 'getProfiles').mockImplementation(() => {
      getProfilesCalls += 1
      return getProfilesCalls === 1 ? firstFetch : secondFetch
    })
    // A different user (id 2), same language ('en') as beforeEach's state —
    // the exact shape of the A->B login this round's fix targets.
    vi.mocked(client.postLogin).mockResolvedValue({
      token: 'new-token',
      refresh_token: null,
      expires_at: null,
      user: user({ id: 2, email: 'bob@example.com' }),
    })

    render(<Header />) // mount fires the first (A-owned) fetch
    await waitFor(() => expect(getProfilesCalls).toBe(1))

    const loggedIn = await login('bob@example.com', 'password-123')
    expect(loggedIn).toBe(true)
    // A direct cross-user login resets profiles/profileId/profilesReady —
    // without this round's fix, nothing would ever re-settle profilesReady.
    expect(useStore.getState().profilesReady).toBe(false)

    // A replacement fetch must be issued for B's session even though the
    // language never changed.
    await waitFor(() => expect(getProfilesCalls).toBe(2))

    // A's still in-flight, owner-scoped response must stay discarded.
    resolveFirst([profile({ id: 9, name: 'Foreign' })])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().profiles).toEqual([])
    expect(useStore.getState().profilesReady).toBe(false)

    // B's own fetch settles readiness and populates B's profile list.
    resolveSecond([profile({ id: 3, name: 'Bob standard' })])
    await waitFor(() => expect(useStore.getState().profilesReady).toBe(true))
    expect(useStore.getState().profiles).toEqual([profile({ id: 3, name: 'Bob standard' })])
  })
})
