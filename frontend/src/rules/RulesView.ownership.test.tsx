// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type { Profile, RuleInfo } from '../types'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getRules: vi.fn(),
  updateProfile: vi.fn(),
}))

import { getRules, updateProfile } from '../api/client'
import { RulesView } from './RulesView'

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
    name: 'Global Profile',
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
    is_global: true,
    ...overrides,
  }
}

const rule: RuleInfo = {
  rule_id: 'grammar-001',
  language: 'en',
  category: 'grammar',
  level: 'warning',
  extends: 'existence',
  message: 'Example rule',
  requires_nlp: false,
  file: 'grammar-001.yaml',
  detail: {},
  pack: null,
  examples: { bad: [], good: [] },
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getRules).mockResolvedValue({ rules: [rule], errors: [], packs: [] })
  useStore.setState({
    uiLocale: 'en',
    language: 'en',
    languages: FALLBACK_LANGUAGES,
    rulesCollapsed: [],
  })
})

describe('RulesView ownership affordances (non-admin)', () => {
  beforeEach(() => {
    useStore.setState({ user: user({ is_admin: false }) })
  })

  it('renders the built-in badge and disables the category checkbox and rule toggle on a global profile', async () => {
    useStore.setState({ profiles: [profile()], profileId: 1 })
    render(<RulesView />)

    within(screen.getByText(en.editingRulesFor('Global Profile', 'English')).closest('p')!).getByText(
      en.globalBadge,
    )
    const categoryCheckbox = (await screen.findByTitle(
      en.categoryToggleTitle,
    )) as HTMLInputElement
    expect(categoryCheckbox.disabled).toBe(true)
    const ruleCheckbox = screen.getByTitle(en.ruleToggleTitle) as HTMLInputElement
    expect(ruleCheckbox.disabled).toBe(true)
  })

  it('leaves a private profile fully editable', async () => {
    useStore.setState({
      profiles: [profile({ id: 2, name: 'Private Profile', is_global: false })],
      profileId: 2,
    })
    render(<RulesView />)

    expect(
      screen.queryByText(en.globalBadge, {
        selector: '.rules-profile-banner .global-badge',
      }),
    ).toBeNull()
    const categoryCheckbox = (await screen.findByTitle(
      en.categoryToggleTitle,
    )) as HTMLInputElement
    expect(categoryCheckbox.disabled).toBe(false)
  })

  it('saveRuleSelection guard: a control that still reaches the handler does not call updateProfile on a global profile', async () => {
    // Pins the fix: even if a disabled control somehow still fires (a
    // future control that forgets `disabled`, or a stale ref bypassing it),
    // saveRuleSelection's own readOnly early-return is the belt that stops
    // the mutation. We force the DOM past the `disabled` attribute here so
    // the assertion actually exercises that guard rather than the
    // browser's native disabled-blocks-events behavior.
    useStore.setState({ profiles: [profile()], profileId: 1 })
    render(<RulesView />)

    const categoryCheckbox = (await screen.findByTitle(
      en.categoryToggleTitle,
    )) as HTMLInputElement
    expect(categoryCheckbox.disabled).toBe(true) // sanity: normally blocked
    categoryCheckbox.disabled = false
    fireEvent.click(categoryCheckbox)

    expect(updateProfile).not.toHaveBeenCalled()
  })
})

describe('RulesView ownership affordances (admin)', () => {
  it('leaves a global profile fully editable for an admin', async () => {
    useStore.setState({ user: user({ is_admin: true }), profiles: [profile()], profileId: 1 })
    render(<RulesView />)

    const categoryCheckbox = (await screen.findByTitle(
      en.categoryToggleTitle,
    )) as HTMLInputElement
    expect(categoryCheckbox.disabled).toBe(false)
  })
})
