// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from './api/client'
import { useStore } from './state/store'
import type { Domain } from './types'

// Only the catalog fetches Header's mount effect fires are replaced —
// everything else in api/client stays real but unused by Header.
vi.mock('./api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/client')>()),
  getProviders: vi.fn().mockResolvedValue([]),
  getDomains: vi.fn().mockResolvedValue([]),
  getLanguages: vi.fn().mockResolvedValue([]),
  getRouting: vi.fn().mockResolvedValue(null),
  getProfiles: vi.fn().mockResolvedValue([]),
  postLogin: vi.fn(),
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
import { login, logout } from './auth/session'
import { Header } from './App'

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
    lastProfileByLanguage: {},
    docMeta: null,
    uiLocale: 'en',
    token: 'old-token',
    user: user(),
    authStatus: 'authenticated',
    domains: [],
  })
})

describe('Header domains-fetch generation guard', () => {
  it('discards a domains fetch that resolves after a session turnover', async () => {
    let resolveFetch!: (domains: Domain[]) => void
    vi.spyOn(client, 'getDomains').mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )
    render(<Header />) // mount fires the fetch
    logout() // session ends while it is in flight
    resolveFetch([{ id: 9, name: 'Foreign', description: '', is_global: false }])
    // Drain the .then chain before asserting. logout() already resets
    // domains to [] synchronously, so a waitFor here would succeed on its
    // immediate first probe — before the resolved fetch's write runs — and
    // the test would stay green with the guard deleted.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().domains).toEqual([]) // nothing landed
  })
})

describe('Header domains-fetch re-fires on same-user re-login (Copilot round-9 U1)', () => {
  it('issues and applies a replacement domains fetch after the password-change silent re-login, while the stale pre-login fetch stays discarded', async () => {
    let resolveFirst!: (domains: Domain[]) => void
    const firstFetch = new Promise<Domain[]>((resolve) => {
      resolveFirst = resolve
    })
    let resolveSecond!: (domains: Domain[]) => void
    const secondFetch = new Promise<Domain[]>((resolve) => {
      resolveSecond = resolve
    })
    let getDomainsCalls = 0
    vi.spyOn(client, 'getDomains').mockImplementation(() => {
      getDomainsCalls += 1
      return getDomainsCalls === 1 ? firstFetch : secondFetch
    })
    // login() always returns a fresh `user` object (see auth/session.ts) —
    // a brand-new object literal here mirrors that, even though the id and
    // every field are identical to the pre-login user (same-user re-login).
    vi.mocked(client.postLogin).mockResolvedValue({ token: 'new-token', user: user() })

    render(<Header />) // mount fires the first (pre-login) fetch
    await waitFor(() => expect(getDomainsCalls).toBe(1))

    // The password-change flow (auth/AccountMenu.tsx handleSubmit) silently
    // re-authenticates the SAME user via login(email, newPassword) while
    // Header stays mounted — authStatus never leaves 'authenticated', so
    // LoginGate does not unmount/remount it.
    const reauthenticated = await login('ada@example.com', 'new-password-123')
    expect(reauthenticated).toBe(true)

    // A replacement fetch must be issued for the new session.
    await waitFor(() => expect(getDomainsCalls).toBe(2))

    // The pre-login fetch, still pending, must stay discarded when it lands.
    resolveFirst([{ id: 9, name: 'Foreign', description: '', is_global: false }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().domains).toEqual([])

    // The replacement fetch's result IS applied — the picker must not stay
    // empty for the rest of the session.
    resolveSecond([{ id: 3, name: 'Fresh', description: '', is_global: true }])
    await waitFor(() =>
      expect(useStore.getState().domains).toEqual([
        { id: 3, name: 'Fresh', description: '', is_global: true },
      ]),
    )
  })
})
