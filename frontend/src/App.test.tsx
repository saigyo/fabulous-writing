// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bumpGeneration, resetAutosaveForTests } from './documents/autosave'
import {
  consumeProfileApplySuppression,
  setProfileApplySuppressed,
} from './documents/profileApply'
import { en } from './i18n/en'
import { useStore } from './state/store'
import type { Profile } from './types'
import type { MeResponse } from './api/client'

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
    is_global: true,
    ...overrides,
  }
}

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

const FLOOR_POLICY: MeResponse['policy'] = {
  llm: { tiers: [], providers: [], models: null },
  features: [],
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
    profilesReady: false,
    profileId: null,
    lastProfileByLanguage: {},
    docMeta: null,
    uiLocale: 'en',
    user: null,
    appVersion: null,
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

  it('a getProfiles rejection that lands after turnover does not consume the suppression the new session just armed', async () => {
    // The .catch() cleanup below the .then() exists so a FAILED fetch still
    // consumes the one-shot suppression (otherwise it strands and wrongly
    // suppresses the next legitimate apply) — but without its own generation
    // guard, a rejection arriving after a session turnover can consume a
    // suppression flag the *incoming* session has since armed for its own
    // document open, silently discarding it before that session's own
    // profile fetch ever gets to see it.
    vi.mocked(getProfiles).mockResolvedValueOnce([])
    render(<Header />)
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(1))

    let rejectProfiles!: (error: unknown) => void
    vi.mocked(getProfiles).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProfiles = reject
        }),
    )
    useStore.setState({ language: 'de' })
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(2))

    bumpGeneration() // the session that started this fetch has ended
    setProfileApplySuppressed(true) // the incoming session arms its own suppression

    rejectProfiles(new Error('network down'))
    await new Promise((r) => setTimeout(r, 0))

    expect(consumeProfileApplySuppression()).toBe(true)
  })

  it('discards a stale-language getProfiles response that resolves after a newer language switch', async () => {
    // Pins the fix for useHeaderData.ts's language-switch effect (Copilot
    // round 5): the generation guard above only protects against a SESSION
    // turnover, not a second language switch racing ahead of the first —
    // without per-effect-instance cancellation, a slow response for an OLD
    // language lands after a NEWER switch's fetch has already started,
    // still passes the (unchanged) generation guard, and overwrites the
    // newer switch's profiles/profilesReady with stale data.
    vi.mocked(getProfiles).mockResolvedValueOnce([])
    render(<Header />)
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(1))

    let resolveDe!: (p: Profile[]) => void
    vi.mocked(getProfiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDe = resolve
        }),
    )
    useStore.setState({ language: 'de' })
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(2))

    // 'fr's fetch never settles in this test — only that it superseded 'de'.
    vi.mocked(getProfiles).mockImplementationOnce(() => new Promise(() => {}))
    useStore.setState({ language: 'fr' })
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(3))

    // The stale 'de' response finally resolves — it must be ignored.
    resolveDe([profile({ language: 'de', domain_ids: [42] })])
    await new Promise((r) => setTimeout(r, 0))

    expect(useStore.getState().profiles).toHaveLength(0) // de's list never lands
    expect(useStore.getState().profileId).toBeNull() // de's selection never lands
    expect(useStore.getState().profilesReady).toBe(false) // fr's fetch is still pending
  })
})

// Copilot round 4: EmbedApp.tsx gates its connect-time check on
// store.profilesReady so a cold authenticated mount can't run the check
// before a profile's rule_config is known — these pin the three ways
// useHeaderData.ts drives that flag.
describe('Header profilesReady', () => {
  it('flips true once the profiles fetch resolves', async () => {
    vi.mocked(getProfiles).mockResolvedValue([profile()])
    render(<Header />)
    await waitFor(() => expect(useStore.getState().profilesReady).toBe(true))
  })

  it('flips true even when the profiles fetch fails', async () => {
    vi.mocked(getProfiles).mockRejectedValue(new Error('network down'))
    render(<Header />)
    await waitFor(() => expect(useStore.getState().profilesReady).toBe(true))
  })

  it('goes false again the instant a real language switch re-fires the fetch', async () => {
    vi.mocked(getProfiles).mockResolvedValueOnce([profile()])
    render(<Header />)
    await waitFor(() => expect(useStore.getState().profilesReady).toBe(true))

    let resolveProfiles!: (p: Profile[]) => void
    vi.mocked(getProfiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProfiles = resolve
        }),
    )
    useStore.setState({ language: 'de' })
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(2))
    expect(useStore.getState().profilesReady).toBe(false)

    resolveProfiles([profile({ language: 'de' })])
    await waitFor(() => expect(useStore.getState().profilesReady).toBe(true))
  })

  it('clears the previous language profiles on a language-switch fetch failure (Copilot round 5)', async () => {
    // Without this, a language-switch FAILURE left the previous language's
    // profiles sitting in the store while profilesReady (round 4) still
    // flipped true — letting the embed's connect-time check run
    // activeProfile() against the OLD language's rule config.
    vi.mocked(getProfiles).mockResolvedValueOnce([profile()])
    render(<Header />)
    await waitFor(() => expect(useStore.getState().profiles).toHaveLength(1))

    vi.mocked(getProfiles).mockRejectedValueOnce(new Error('network down'))
    useStore.setState({ language: 'de' })
    await waitFor(() => expect(useStore.getState().profilesReady).toBe(true))

    expect(useStore.getState().profiles).toHaveLength(0)
  })

  it('a profile-save setProfiles call during a pending language fetch does not flip readiness (Copilot round 6)', async () => {
    // Pins the fix: setProfiles used to flip profilesReady true as a side
    // effect, so a profile save (ProfileSelector.tsx's saveOverrides,
    // RulesView.tsx, ProfilesView.tsx) landing while a NEWER language's
    // profiles fetch was still in flight would prematurely re-settle
    // readiness — letting the embed's connect-time check run against the
    // previous language's profile before the new language's fetch actually
    // resolved.
    vi.mocked(getProfiles).mockResolvedValueOnce([profile()])
    render(<Header />)
    await waitFor(() => expect(useStore.getState().profilesReady).toBe(true))

    let resolveProfiles!: (p: Profile[]) => void
    vi.mocked(getProfiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProfiles = resolve
        }),
    )
    useStore.setState({ language: 'de' })
    await waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(2))
    expect(useStore.getState().profilesReady).toBe(false)

    // A profile-save write lands mid-flight — data-only, must not resettle
    // readiness while the language fetch is still pending.
    useStore.getState().setProfiles([profile({ domain_ids: [42] })])
    expect(useStore.getState().profilesReady).toBe(false)

    resolveProfiles([profile({ language: 'de' })])
    await waitFor(() => expect(useStore.getState().profilesReady).toBe(true))
  })
})

describe('Header LLM-phase gating', () => {
  it('carries no LLM affordance for a floor-policy user (no selector, no auto-check toggle)', async () => {
    vi.mocked(getProfiles).mockResolvedValue([])
    useStore.setState({ user: user({ policy: FLOOR_POLICY }) })
    render(<Header />)
    await waitFor(() => expect(getProfiles).toHaveBeenCalled())

    // LlmSelector is mocked to () => null at the top of this file; its own
    // floor case (rendering nothing) is covered directly by
    // header/LlmSelector.test.tsx. What this test actually pins is the
    // auto-check toggle, which App.tsx renders inline in Header and must
    // gate on the same llmDisabled(store.user) check.
    expect(screen.queryByTitle(en.autoTitle)).toBeNull()
  })
})

describe('Header quota indicator', () => {
  it('shows the tier label and used percent, with the per-window breakdown as title', async () => {
    vi.mocked(getProfiles).mockResolvedValue([])
    useStore.setState({
      user: user({ usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] } }),
    })
    render(<Header />)
    await waitFor(() => expect(getProfiles).toHaveBeenCalled())

    const indicator = screen.getByText('Basic · 0%')
    expect(indicator.getAttribute('title')).toBe(`${en.windowName('day')}: 0%`)
    // A `title` attribute alone is not exposed as an accessible name on a
    // non-focusable span -- assistive tech needs aria-label too.
    expect(
      screen.getByLabelText(`${en.quotaIndicatorTitle}: Basic · ${en.windowName('day')}: 0%`),
    ).toBe(indicator)
  })

  it('shows the tier label and the tightest window percentage', async () => {
    vi.mocked(getProfiles).mockResolvedValue([])
    useStore.setState({
      user: user({
        usage: {
          label: 'Basic',
          windows: [
            { window: 'day', used_percent: 30 },
            { window: 'month', used_percent: 70 },
          ],
        },
      }),
    })
    render(<Header />)
    await waitFor(() => expect(getProfiles).toHaveBeenCalled())

    const indicator = screen.getByText('Basic · 70%')
    expect(indicator.getAttribute('title')).toContain(`${en.windowName('day')}: 30%`)
    expect(indicator.getAttribute('title')).toContain(`${en.windowName('month')}: 70%`)
    expect(indicator.getAttribute('aria-label')).toContain(`${en.windowName('day')}: 30%`)
    expect(indicator.getAttribute('aria-label')).toContain(`${en.windowName('month')}: 70%`)
  })

  it('is absent for a floor-policy user (llmDisabled)', async () => {
    vi.mocked(getProfiles).mockResolvedValue([])
    useStore.setState({ user: user({ policy: FLOOR_POLICY }) })
    render(<Header />)
    await waitFor(() => expect(getProfiles).toHaveBeenCalled())

    // `title` is the per-window breakdown, never en.quotaIndicatorTitle
    // verbatim (Task 6) -- match the aria-label, which does start with it.
    expect(screen.queryByLabelText(new RegExp(en.quotaIndicatorTitle))).toBeNull()
  })

  it('is absent when logged out', async () => {
    vi.mocked(getProfiles).mockResolvedValue([])
    useStore.setState({ user: null })
    render(<Header />)
    await waitFor(() => expect(getProfiles).toHaveBeenCalled())

    expect(screen.queryByLabelText(new RegExp(en.quotaIndicatorTitle))).toBeNull()
  })
})

describe('Header dev instance badge', () => {
  it('shows the dev instance badge with the backend under the wordmark', () => {
    vi.mocked(getProfiles).mockResolvedValue([])
    useStore.setState({ user: user({ db_backend: 'postgres' }), appVersion: 'dev' })
    render(<Header />)
    screen.getByText('dev · postgres')
  })

  it('renders no instance badge on a release version', () => {
    vi.mocked(getProfiles).mockResolvedValue([])
    useStore.setState({ user: user({ db_backend: 'postgres' }), appVersion: '1.2.3' })
    render(<Header />)
    expect(screen.queryByText(/dev ·/)).toBeNull()
    expect(screen.queryByText('1.2.3')).toBeNull()
  })
})
