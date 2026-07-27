// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { Profile, ProviderInfo, RoutingTable } from '../types'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getRules: vi.fn().mockResolvedValue({ rules: [], errors: [], packs: [] }),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  resetProfile: vi.fn(),
}))

import { ProfilesView } from './ProfilesView'

function user(policy: MeResponse['policy'], overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy,
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

const UNRESTRICTED: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: [],
}

const RESTRICTED: MeResponse['policy'] = {
  llm: {
    tiers: ['cheap', 'local'],
    providers: ['ollama'],
    models: { ollama: ['llama3.1'] },
  },
  features: [],
}

const ADMIN_POLICY: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: ['custom_profiles', 'custom_domains'],
}

const providers: ProviderInfo[] = [
  {
    name: 'ollama',
    available: true,
    models: ['llama3.1', 'qwen3:8b'],
    default_model: 'llama3.1',
    allowed: true,
  },
]

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    language: 'en',
    name: 'A Profile',
    is_standard: false,
    categories_off: [],
    rule_exceptions: [],
    packs_on: [],
    domain_ids: [],
    llm_provider: 'ollama',
    llm_model: null,
    llm_tier: null,
    llm_instructions: '',
    example_text: '',
    is_global: false,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    uiLocale: 'en',
    language: 'en',
    domains: [],
    providers: [],
    routing: null,
    profileId: null,
    profiles: [],
  })
})

describe('ProfilesView create affordance (custom_profiles feature gate)', () => {
  it('hides the new-profile input and create button without the feature', () => {
    useStore.setState({ user: user({ llm: UNRESTRICTED.llm, features: [] }) })
    render(<ProfilesView />)

    expect(screen.queryByPlaceholderText(en.newProfilePlaceholder)).toBeNull()
    expect(screen.queryByTitle(en.createProfileTitle)).toBeNull()
  })

  it('shows both the input and create button with the feature', () => {
    useStore.setState({
      user: user({ llm: UNRESTRICTED.llm, features: ['custom_profiles'] }),
    })
    render(<ProfilesView />)

    screen.getByPlaceholderText(en.newProfilePlaceholder)
    screen.getByTitle(en.createProfileTitle)
  })

  it('admin-shaped user (is_admin true, both features) sees the create affordance', () => {
    useStore.setState({ user: user(ADMIN_POLICY, { is_admin: true }) })
    render(<ProfilesView />)

    screen.getByPlaceholderText(en.newProfilePlaceholder)
    screen.getByTitle(en.createProfileTitle)
  })
})

describe('ProfilesView editor LLM controls: readOnly combined with plan gating', () => {
  it('a read-only global profile keeps its LLM controls disabled for an UNRESTRICTED user', async () => {
    useStore.setState({
      user: user(UNRESTRICTED, { is_admin: false }),
      providers,
      profiles: [profile({ id: 10, name: 'Global', is_global: true })],
    })
    render(<ProfilesView />)

    const card = screen.getByDisplayValue('Global').closest('.profile-card') as HTMLElement
    for (const tierButton of within(card).getAllByRole('button', { name: /./ }).filter((b) =>
      b.className.includes('tier-option'),
    )) {
      expect((tierButton as HTMLButtonElement).disabled).toBe(true)
    }
    const providerSelect = within(card).getByDisplayValue('ollama') as HTMLSelectElement
    expect(providerSelect.disabled).toBe(true)
    for (const option of Array.from(providerSelect.options)) {
      expect(option.disabled).toBe(true)
    }
  })

  it("a private profile's off-plan tier/provider/model options are disabled for a RESTRICTED user", async () => {
    useStore.setState({
      user: user(RESTRICTED, { is_admin: false }),
      providers,
      profiles: [
        profile({ id: 11, name: 'Private', is_global: false, llm_provider: 'ollama', llm_model: null }),
      ],
    })
    render(<ProfilesView />)

    const card = screen.getByDisplayValue('Private').closest('.profile-card') as HTMLElement

    // Quality-tier buttons: 'quality' and 'balanced' are off-plan (RESTRICTED
    // allows only cheap/local) — disabled and carry the plan suffix; the
    // allowed ones stay enabled.
    const balancedButton = within(card).getByText(
      `${en.tierName('balanced')}${en.planSuffix}`,
    ) as HTMLButtonElement
    expect(balancedButton.disabled).toBe(true)
    const cheapButton = within(card).getByText(en.tierName('cheap')) as HTMLButtonElement
    expect(cheapButton.disabled).toBe(false)

    // Provider select: ollama is allowed and stays enabled (readOnly=false).
    const providerSelect = within(card).getByDisplayValue('ollama') as HTMLSelectElement
    expect(providerSelect.disabled).toBe(false)

    // Model select: llama3.1 (allowlisted) enabled, qwen3:8b (off-plan) disabled.
    const modelSelect = within(card).getByDisplayValue('llama3.1') as HTMLSelectElement
    const qwenOption = Array.from(modelSelect.options).find((o) => o.value === 'qwen3:8b')
    expect(qwenOption?.disabled).toBe(true)
    const llamaOption = Array.from(modelSelect.options).find((o) => o.value === 'llama3.1')
    expect(llamaOption?.disabled).toBe(false)
  })
})

describe('ProfilesView editor pin-to-direct-selection affordance (mirrors LlmSelector)', () => {
  const routingCheapAllowed: RoutingTable = {
    default_tier: 'balanced',
    tiers: ['quality', 'balanced', 'cheap', 'local'],
    languages: {
      en: {
        cheap: { provider: 'ollama', model: 'llama3.1', available: true, reason: null, allowed: true },
      },
    },
  }

  const routingCheapOffPlan: RoutingTable = {
    default_tier: 'balanced',
    tiers: ['quality', 'balanced', 'cheap', 'local'],
    languages: {
      en: {
        cheap: { provider: 'ollama', model: 'qwen3:8b', available: true, reason: null, allowed: true },
      },
    },
  }

  it('shows the pin button for a tier-routed pair on the direct-selection allowlist', () => {
    useStore.setState({
      user: user(RESTRICTED, { is_admin: false }),
      providers,
      routing: routingCheapAllowed,
      profiles: [
        profile({ id: 12, name: 'Tiered', is_global: false, llm_provider: null, llm_tier: 'cheap' }),
      ],
    })
    render(<ProfilesView />)

    const card = screen.getByDisplayValue('Tiered').closest('.profile-card') as HTMLElement
    within(card).getByTitle(en.pinThisModel)
  })

  it('hides the pin button for a tier-routed pair outside the direct-selection allowlist', () => {
    useStore.setState({
      user: user(RESTRICTED, { is_admin: false }),
      providers,
      routing: routingCheapOffPlan,
      profiles: [
        profile({ id: 13, name: 'TieredOffPlan', is_global: false, llm_provider: null, llm_tier: 'cheap' }),
      ],
    })
    render(<ProfilesView />)

    const card = screen.getByDisplayValue('TieredOffPlan').closest('.profile-card') as HTMLElement
    expect(within(card).queryByTitle(en.pinThisModel)).toBeNull()
  })
})
