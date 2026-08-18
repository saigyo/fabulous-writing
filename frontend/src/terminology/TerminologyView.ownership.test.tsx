// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type { Domain, Term } from '../types'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getDomains: vi.fn(),
  getTerms: vi.fn().mockResolvedValue([]),
  createDomain: vi.fn(),
  deleteDomain: vi.fn(),
  updateDomain: vi.fn(),
  createTerm: vi.fn(),
  updateTerm: vi.fn(),
  deleteTerm: vi.fn(),
  // This file renders TerminologyView directly, not LoginGate, so nothing
  // here would actually call getHealth — mocked anyway (Task 7) so a real
  // fetch is never one accidental render away.
  getHealth: vi.fn(async () => ({ status: 'ok', name: '', version: 'dev' })),
  postLogin: vi.fn(),
  // Resolved once here (see App.domains-guard.test.tsx's comment): this
  // file's beforeEach uses clearAllMocks(), which preserves the
  // implementation, and every logout() below runs with a real token.
  postLogout: vi.fn().mockResolvedValue(undefined),
}))
// documents.ts pulls in hydration.ts -> checking/controller.ts; logout()
// (via auth/session.ts) only needs these two exports, so the module is
// replaced outright rather than partially mocked (matching session.test.ts).
vi.mock('../documents/documents', () => ({
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))

import { deleteTerm, getDomains, getTerms, postLogin, updateTerm } from '../api/client'
import { login, logout } from '../auth/session'
import { TerminologyView } from './TerminologyView'

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

const globalDomain: Domain = { id: 1, name: 'Global Domain', description: '', is_global: true }
const privateDomain: Domain = { id: 2, name: 'Private Domain', description: '', is_global: false }

const term: Term = {
  id: 100,
  domain_id: 1,
  language: 'en',
  preferred: 'widget',
  forbidden_variants: ['thingamajig'],
  definition: '',
  case_sensitive: false,
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getDomains).mockResolvedValue([globalDomain, privateDomain])
  vi.mocked(getTerms).mockResolvedValue([])
  useStore.setState({
    uiLocale: 'en',
    languages: FALLBACK_LANGUAGES,
    domains: [globalDomain, privateDomain],
    user: user({ is_admin: false }),
    token: 'old-token',
    authStatus: 'authenticated',
  })
})

describe('TerminologyView ownership affordances (non-admin)', () => {
  it('shows the built-in badge and hides rename/delete on a global domain row; double-click does not rename', async () => {
    render(<TerminologyView />)
    const globalRow = (await screen.findByText('Global Domain')).closest('.domain-row') as HTMLElement
    within(globalRow).getByText(en.globalBadge)
    expect(within(globalRow).queryByTitle(en.renameDomainTitle)).toBeNull()
    expect(within(globalRow).queryByTitle(en.deleteDomainTitle)).toBeNull()

    await userEvent.dblClick(within(globalRow).getByText('Global Domain'))
    expect(within(globalRow).queryByRole('textbox')).toBeNull()
  })

  it('keeps both buttons on a private domain row', async () => {
    render(<TerminologyView />)
    const privateRow = (await screen.findByText('Private Domain')).closest('.domain-row') as HTMLElement
    within(privateRow).getByTitle(en.renameDomainTitle)
    within(privateRow).getByTitle(en.deleteDomainTitle)
  })

  it('renders no add-term row and no per-term edit/delete buttons when a global domain is active', async () => {
    vi.mocked(getTerms).mockResolvedValue([term])
    render(<TerminologyView />)
    // The first domain (global) auto-selects as active.
    await screen.findByText('widget')
    expect(screen.queryByPlaceholderText(en.preferredPlaceholder)).toBeNull()
    expect(screen.queryByTitle(en.editTermTitle)).toBeNull()
    expect(screen.queryByTitle(en.deleteTermTitle)).toBeNull()
  })

  it('restores every control once is_admin flips to true, on the same fixtures', async () => {
    // An admin's /me policy already carries every feature (M4 §8) — the
    // add-term row is gated on custom_domains, not on is_admin itself.
    useStore.setState({
      user: user({
        is_admin: true,
        policy: {
          llm: { tiers: null, providers: null, models: null },
          features: ['custom_domains'],
        },
      }),
    })
    vi.mocked(getTerms).mockResolvedValue([term])
    render(<TerminologyView />)

    const globalRow = (await screen.findByText('Global Domain')).closest('.domain-row') as HTMLElement
    within(globalRow).getByTitle(en.renameDomainTitle)
    within(globalRow).getByTitle(en.deleteDomainTitle)

    await screen.findByText('widget')
    screen.getByPlaceholderText(en.preferredPlaceholder)
    screen.getByTitle(en.editTermTitle)
    screen.getByTitle(en.deleteTermTitle)
  })

  it('exits edit mode when the selected domain changes mid-edit, so the stale Save button cannot fire', async () => {
    // domains[0] is the global domain, so start on the private one to get
    // an editable row in the first place.
    vi.mocked(getTerms).mockResolvedValue([term])
    render(<TerminologyView />)

    const privateRow = (await screen.findByText('Private Domain')).closest('.domain-row') as HTMLElement
    await userEvent.click(within(privateRow).getByText('Private Domain'))
    await screen.findByText('widget')

    await userEvent.click(screen.getByTitle(en.editTermTitle))
    screen.getByDisplayValue('widget') // now editing: the row's input carries the term's value
    screen.getByTitle(en.saveEditTitle)

    // Switch to the global domain while still "editing" — terms haven't
    // been refetched yet, so without a reset the same edit row (and its
    // live Save button, wired to the private term's id) would still render.
    const globalRow = (await screen.findByText('Global Domain')).closest('.domain-row') as HTMLElement
    await userEvent.click(within(globalRow).getByText('Global Domain'))

    expect(screen.queryByTitle(en.saveEditTitle)).toBeNull()
    expect(screen.queryByDisplayValue('widget')).toBeNull()
    expect(updateTerm).not.toHaveBeenCalled()
  })
})

describe('TerminologyView terms fetch: latest-request-wins on domain switch', () => {
  it('clears rows immediately on switch and discards an out-of-order stale fetch from the previous domain', async () => {
    const privateA: Domain = { id: 2, name: 'Private A', description: '', is_global: false }
    const privateB: Domain = { id: 3, name: 'Private B', description: '', is_global: false }
    useStore.setState({ domains: [privateA, privateB] })
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB])

    const termA: Term = { ...term, id: 201, domain_id: privateA.id, preferred: 'alpha' }
    const termB: Term = { ...term, id: 202, domain_id: privateB.id, preferred: 'beta' }

    let resolveA!: (terms: Term[]) => void
    let resolveB!: (terms: Term[]) => void
    const fetchA = new Promise<Term[]>((resolve) => {
      resolveA = resolve
    })
    const fetchB = new Promise<Term[]>((resolve) => {
      resolveB = resolve
    })
    vi.mocked(getTerms).mockImplementation((domainId: number) => {
      if (domainId === privateA.id) return fetchA
      if (domainId === privateB.id) return fetchB
      return Promise.resolve([])
    })

    render(<TerminologyView />)
    // domains[0] (Private A) auto-selects as the active domain on mount;
    // its fetch is still in flight (deferred).
    await waitFor(() => expect(getTerms).toHaveBeenCalledWith(privateA.id))

    // Switch to Private B before A's fetch resolves.
    const rowB = (await screen.findByText('Private B')).closest('.domain-row') as HTMLElement
    await userEvent.click(within(rowB).getByText('Private B'))

    // Immediately after the switch — before either fetch has resolved — there
    // must be no interactive rows left over from the previous domain.
    expect(screen.queryByTitle(en.editTermTitle)).toBeNull()
    expect(screen.queryByText('alpha')).toBeNull()

    // B's fetch (the current selection) resolves first.
    resolveB([termB])
    await screen.findByText('beta')

    // A's fetch (now stale — selection has moved on) resolves after B's.
    // Out-of-order completion must not let it overwrite the current view.
    resolveA([termA])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('discards a stale onChanged refetch from a mutation started on the previous domain', async () => {
    // Reproduces the round-7 finding: a mutation's onChanged closure captures
    // the domain id at the time it was wired (render time), not at the time
    // it fires. If that mutation's own request (deleteTerm here) resolves
    // *after* the user has switched domains, its onChanged() call still
    // refetches the OLD domain — and that refetch takes a newer counter
    // value than the new domain's own in-flight/completed fetch, so it must
    // be rejected by domain identity, not just request ordering.
    const privateA: Domain = { id: 2, name: 'Private A', description: '', is_global: false }
    const privateB: Domain = { id: 3, name: 'Private B', description: '', is_global: false }
    useStore.setState({ domains: [privateA, privateB] })
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB])

    const termA: Term = { ...term, id: 201, domain_id: privateA.id, preferred: 'alpha' }
    const staleTermA: Term = { ...term, id: 301, domain_id: privateA.id, preferred: 'stale-alpha' }
    const termB: Term = { ...term, id: 202, domain_id: privateB.id, preferred: 'beta' }

    let resolveB!: (terms: Term[]) => void
    const fetchB = new Promise<Term[]>((resolve) => {
      resolveB = resolve
    })
    let resolveStaleA!: (terms: Term[]) => void
    const fetchStaleA = new Promise<Term[]>((resolve) => {
      resolveStaleA = resolve
    })
    let getTermsACalls = 0
    vi.mocked(getTerms).mockImplementation((domainId: number) => {
      if (domainId === privateA.id) {
        getTermsACalls += 1
        // First call: TerminologyView's mount-time fetch for the initial
        // domain. Resolves immediately so the row is on screen to delete.
        return getTermsACalls === 1 ? Promise.resolve([termA]) : fetchStaleA
      }
      if (domainId === privateB.id) return fetchB
      return Promise.resolve([])
    })

    let resolveDelete!: () => void
    vi.mocked(deleteTerm).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = () => resolve(undefined)
      }),
    )

    render(<TerminologyView />)
    // domains[0] (Private A) auto-selects; its initial fetch resolves eagerly.
    await screen.findByText('alpha')

    // Start a delete on the current domain (A). deleteTerm() is deferred, so
    // the mutation's onChanged() call (closing over domain A) has not fired
    // yet by the time the user switches domains below.
    await userEvent.click(screen.getByTitle(en.deleteTermTitle))

    // Switch to Private B before the delete resolves.
    const rowB = (await screen.findByText('Private B')).closest('.domain-row') as HTMLElement
    await userEvent.click(within(rowB).getByText('Private B'))

    // B's own switch-triggered fetch resolves and is displayed.
    resolveB([termB])
    await screen.findByText('beta')

    // Now the stale delete-on-A resolves: its onChanged() closure still
    // targets domain A, firing a refetch for A *after* B is the active
    // domain and after B's fetch already landed.
    resolveDelete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveStaleA([staleTermA])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The stale A refetch must never overwrite B's rows.
    expect(screen.queryByText('stale-alpha')).toBeNull()
    expect(screen.getByText('beta')).toBeTruthy()
    // The onChanged closure must be rejected at the START too (not merely
    // have its result discarded on completion): once the domain has moved
    // on, it must never even issue the redundant getTerms(A) call.
    expect(getTermsACalls).toBe(1)
  })
})

describe('TerminologyView refreshDomains generation guard', () => {
  it('discards a refreshDomains fetch that resolves after a session turnover', async () => {
    let resolveFetch!: (domains: Domain[]) => void
    vi.mocked(getDomains).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )
    render(<TerminologyView />) // mount fires refreshDomains()
    await waitFor(() => expect(getDomains).toHaveBeenCalled())
    logout() // session ends while it is in flight; store's domains reset to []
    resolveFetch([{ id: 9, name: 'Foreign', description: '', is_global: false }])
    // Drain the .then chain before asserting — see App.domains-guard.test.tsx
    // for why a waitFor here would pass before the stale write even lands.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().domains).toEqual([]) // nothing landed
  })
})

describe('TerminologyView refreshDomains re-fires on same-user re-login (Copilot round-9 U2)', () => {
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
    vi.mocked(getDomains).mockImplementation(() => {
      getDomainsCalls += 1
      return getDomainsCalls === 1 ? firstFetch : secondFetch
    })
    // login() always returns a fresh `user` object (see auth/session.ts) —
    // a brand-new object literal here mirrors that, even though every field
    // is identical to the pre-login user (same-user re-login).
    vi.mocked(postLogin).mockResolvedValue({
      token: 'new-token',
      refresh_token: null,
      expires_at: null,
      user: user({ is_admin: false }),
    })

    render(<TerminologyView />) // mount fires the first (pre-login) refreshDomains()
    await waitFor(() => expect(getDomainsCalls).toBe(1))

    // The password-change flow (auth/AccountMenu.tsx handleSubmit) silently
    // re-authenticates the SAME user via login(email, newPassword) while
    // TerminologyView stays mounted — authStatus never leaves
    // 'authenticated', so LoginGate does not unmount/remount it.
    const reauthenticated = await login('ada@example.com', 'new-password-123')
    expect(reauthenticated).toBe(true)

    // A replacement fetch must be issued for the new session.
    await waitFor(() => expect(getDomainsCalls).toBe(2))

    // The pre-login fetch, still pending, must stay discarded when it lands.
    resolveFirst([{ id: 9, name: 'Foreign', description: '', is_global: false }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().domains).toEqual([globalDomain, privateDomain])

    // The replacement fetch's result IS applied — the domain picker must
    // not stay stuck on stale data for the rest of the session.
    const freshDomain: Domain = { id: 3, name: 'Fresh', description: '', is_global: true }
    resolveSecond([freshDomain])
    await waitFor(() => expect(useStore.getState().domains).toEqual([freshDomain]))
  })
})
