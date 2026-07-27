// @vitest-environment happy-dom
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder, MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getProfiles: vi.fn().mockResolvedValue([]),
}))

import { FolderDefaultsDialog } from './FolderDefaultsDialog'

function user(policy: MeResponse['policy']): MeResponse {
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
  }
}

const RESTRICTED: MeResponse['policy'] = {
  llm: {
    tiers: ['cheap', 'local'],
    providers: ['ollama'],
    models: { ollama: ['llama3.1'] },
  },
  features: [],
}

const folder: Folder = {
  id: 1,
  name: 'Blog',
  created_at: '',
  default_language: 'en',
  default_profile_id: null,
  default_domain_ids: null,
  default_llm_provider: null,
  default_llm_model: null,
  default_llm_tier: null,
  default_llm_auto: null,
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    uiLocale: 'en',
    languages: FALLBACK_LANGUAGES,
    domains: [],
  })
})

describe('FolderDefaultsDialog quality-tier options: plan gating', () => {
  it('disables an off-plan tier option with the plan suffix; leaves an allowed one enabled', async () => {
    useStore.setState({ user: user(RESTRICTED) })
    render(<FolderDefaultsDialog folder={folder} onClose={() => {}} />)

    const llmSelect = document.querySelector('.fd-llm') as HTMLSelectElement
    const balancedOption = within(llmSelect).getByText(
      `${en.tierName('balanced')}${en.planSuffix}`,
      { selector: 'option' },
    ) as HTMLOptionElement
    expect(balancedOption.disabled).toBe(true)

    const cheapOption = within(llmSelect).getByText(en.tierName('cheap'), {
      selector: 'option',
    }) as HTMLOptionElement
    expect(cheapOption.disabled).toBe(false)
  })

  it('leaves the "none" entry policy-neutral (never disabled, no plan suffix)', async () => {
    useStore.setState({ user: user(RESTRICTED) })
    render(<FolderDefaultsDialog folder={folder} onClose={() => {}} />)

    const llmSelect = document.querySelector('.fd-llm') as HTMLSelectElement
    const noneOption = within(llmSelect).getByText(en.folderDefaultsNone, {
      selector: 'option',
    }) as HTMLOptionElement
    expect(noneOption.disabled).toBe(false)
  })
})
