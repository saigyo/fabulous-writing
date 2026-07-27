// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { MeResponse } from '../api/client'
import type { ProviderInfo, RoutingTable } from '../types'
import { LlmSelector } from './LlmSelector'

function user(policy: MeResponse['policy']): MeResponse {
  return {
    id: 1,
    email: 'u@example.com',
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

const FLOOR: MeResponse['policy'] = {
  llm: { tiers: [], providers: [], models: null },
  features: [],
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

const routing: RoutingTable = {
  default_tier: 'balanced',
  tiers: ['quality', 'balanced', 'cheap', 'local'],
  languages: {
    en: {
      // Deliberately also server-unavailable: this pins "plan beats offline"
      // — a tier that is both off-plan and offline must still show the
      // plan suffix (the actionable reason), not the offline one.
      balanced: {
        provider: 'claude',
        model: 'claude-sonnet-5',
        available: false,
        reason: 'not configured',
        allowed: false,
      },
      cheap: {
        provider: 'ollama',
        model: 'llama3.1',
        available: true,
        reason: null,
        allowed: true,
      },
      local: {
        provider: 'ollama',
        model: 'qwen3:8b',
        available: true,
        reason: null,
        allowed: true,
      },
    },
  },
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  useStore.setState({
    language: 'en',
    provider: 'ollama',
    model: null,
    tier: 'local',
    providers,
    routing,
    uiLocale: 'en',
  })
})

describe('LlmSelector plan gating', () => {
  it('disables a tier outside the plan allowlist and labels it with the plan suffix (plan beats offline)', () => {
    useStore.setState({ user: user(RESTRICTED) })
    render(<LlmSelector />)

    const option = screen.getByText(
      `${en.tierName('balanced')}${en.planSuffix}`,
      { selector: 'option' },
    ) as HTMLOptionElement
    expect(option.disabled).toBe(true)
  })

  it('leaves an allowed tier enabled', () => {
    useStore.setState({ user: user(RESTRICTED) })
    render(<LlmSelector />)

    const option = screen.getByText(en.tierName('local'), {
      selector: 'option',
    }) as HTMLOptionElement
    expect(option.disabled).toBe(false)
  })

  it('renders nothing for a floor-policy user', () => {
    useStore.setState({ user: user(FLOOR) })
    const { container } = render(<LlmSelector />)

    expect(container.firstChild).toBeNull()
  })

  it('hides the pin button for a tier-routed pair outside the direct-selection allowlist', async () => {
    // tier 'local' routes to ollama/qwen3:8b, but the RESTRICTED policy's
    // direct-model allowlist for ollama is only ['llama3.1'] — pinning would
    // offer a pair the dropdowns themselves mark off-plan.
    useStore.setState({ user: user(RESTRICTED) })
    render(<LlmSelector />)

    await userEvent.setup().click(screen.getByTitle(en.advancedTitle))

    expect(screen.queryByTitle(en.pinThisModel)).toBeNull()
  })
})
