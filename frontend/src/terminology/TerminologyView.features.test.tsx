// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
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
}))

import { getDomains, getTerms } from '../api/client'
import { TerminologyView } from './TerminologyView'

function user(policy: MeResponse['policy'], overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy,
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

const NO_FEATURES: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: [],
}

const WITH_CUSTOM_DOMAINS: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: ['custom_domains'],
}

const ADMIN_POLICY: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: ['custom_profiles', 'custom_domains'],
}

const privateDomain: Domain = { id: 2, name: 'Private Domain', description: '', is_global: false }

const term: Term = {
  id: 100,
  domain_id: 2,
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
  vi.mocked(getDomains).mockResolvedValue([privateDomain])
  vi.mocked(getTerms).mockResolvedValue([])
  useStore.setState({
    uiLocale: 'en',
    languages: FALLBACK_LANGUAGES,
    domains: [privateDomain],
    token: 'old-token',
    authStatus: 'authenticated',
  })
})

describe('TerminologyView create affordances (custom_domains feature gate)', () => {
  it('hides the add-domain row and the add-term row without the feature', async () => {
    vi.mocked(getTerms).mockResolvedValue([term])
    useStore.setState({ user: user(NO_FEATURES) })
    render(<TerminologyView />)

    await screen.findByText('widget')
    expect(screen.queryByPlaceholderText(en.newDomainPlaceholder)).toBeNull()
    expect(screen.queryByPlaceholderText(en.preferredPlaceholder)).toBeNull()

    // Existing terms stay editable — only the ADD affordance hides (M3
    // ownership convention: don't regress edit/delete for a private domain).
    screen.getByTitle(en.editTermTitle)
    screen.getByTitle(en.deleteTermTitle)
  })

  it('shows the add-domain row and the add-term row with the feature', async () => {
    vi.mocked(getTerms).mockResolvedValue([term])
    useStore.setState({ user: user(WITH_CUSTOM_DOMAINS) })
    render(<TerminologyView />)

    await screen.findByText('widget')
    screen.getByPlaceholderText(en.newDomainPlaceholder)
    screen.getByPlaceholderText(en.preferredPlaceholder)
  })

  it('admin-shaped user (is_admin true, both features) sees every create affordance', async () => {
    vi.mocked(getTerms).mockResolvedValue([term])
    useStore.setState({ user: user(ADMIN_POLICY, { is_admin: true }) })
    render(<TerminologyView />)

    await screen.findByText('widget')
    screen.getByPlaceholderText(en.newDomainPlaceholder)
    screen.getByPlaceholderText(en.preferredPlaceholder)
  })
})
