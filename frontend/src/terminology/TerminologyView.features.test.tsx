// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type { Concept, Domain } from '../types'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getDomains: vi.fn(),
  getConcepts: vi.fn().mockResolvedValue([]),
  createDomain: vi.fn(),
  deleteDomain: vi.fn(),
  updateDomain: vi.fn(),
}))

import { getConcepts, getDomains } from '../api/client'
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

const concept: Concept = {
  id: 100,
  uid: 'c100',
  domain_ids: [2],
  is_global: false,
  revision: 1,
  created_at: null,
  created_by: null,
  modified_at: null,
  modified_by: null,
  sections: [
    {
      id: 1,
      language: 'en',
      definition: '',
      revision: 1,
      created_at: null,
      created_by: null,
      modified_at: null,
      modified_by: null,
      terms: [
        {
          id: 1,
          uid: 't1',
          text: 'widget',
          usage_status: 'preferred',
          process_status: 'active',
          status_reason: '',
          context: '',
          source: '',
          part_of_speech: null,
          case_sensitive: false,
          revision: 1,
          created_at: null,
          created_by: null,
          modified_at: null,
          modified_by: null,
        },
      ],
    },
  ],
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getDomains).mockResolvedValue([privateDomain])
  vi.mocked(getConcepts).mockResolvedValue([])
  useStore.setState({
    uiLocale: 'en',
    languages: FALLBACK_LANGUAGES,
    domains: [privateDomain],
    token: 'old-token',
    authStatus: 'authenticated',
  })
})

describe('TerminologyView create affordances (custom_domains feature gate)', () => {
  it('hides the add-domain row and the new-concept button without the feature', async () => {
    vi.mocked(getConcepts).mockResolvedValue([concept])
    useStore.setState({ user: user(NO_FEATURES) })
    render(<TerminologyView />)

    await screen.findByRole('button', { name: 'widget' })
    expect(screen.queryByPlaceholderText(en.newDomainPlaceholder)).toBeNull()
    expect(screen.queryByRole('button', { name: en.newConcept })).toBeNull()

    // Existing concepts stay openable — only the ADD affordance hides.
    screen.getByRole('button', { name: 'widget' })
  })

  it('shows the add-domain row and the new-concept button with the feature', async () => {
    vi.mocked(getConcepts).mockResolvedValue([concept])
    useStore.setState({ user: user(WITH_CUSTOM_DOMAINS) })
    render(<TerminologyView />)

    await screen.findByRole('button', { name: 'widget' })
    screen.getByPlaceholderText(en.newDomainPlaceholder)
    screen.getByRole('button', { name: en.newConcept })
  })

  it('admin-shaped user (is_admin true, both features) sees every create affordance', async () => {
    vi.mocked(getConcepts).mockResolvedValue([concept])
    useStore.setState({ user: user(ADMIN_POLICY, { is_admin: true }) })
    render(<TerminologyView />)

    await screen.findByRole('button', { name: 'widget' })
    screen.getByPlaceholderText(en.newDomainPlaceholder)
    screen.getByRole('button', { name: en.newConcept })
  })
})
