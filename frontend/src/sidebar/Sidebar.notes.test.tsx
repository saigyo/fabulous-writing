// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { EffectiveLlm } from '../types'
import { Sidebar } from './Sidebar'

function user(policy: MeResponse['policy']): MeResponse {
  return {
    id: 1,
    email: 'u@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy,
  }
}

const FLOOR: MeResponse['policy'] = {
  llm: { tiers: [], providers: [], models: null },
  features: [],
}

const FULL: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: ['custom_profiles', 'custom_domains'],
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  useStore.setState({
    uiLocale: 'en',
    tracked: [],
    selectedId: null,
    checkPhase: 'idle',
    llmError: null,
    llmEffective: null,
    severityFilter: null,
    sourceFilter: null,
    user: null,
  })
})

describe('Sidebar degradation/skip notes', () => {
  it('shows the llmDegraded note when a check ran but degraded', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'quality', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: true,
      skipped: null,
    }
    useStore.setState({ llmEffective })
    render(<Sidebar />)

    expect(
      screen.getByText(en.llmDegraded(en.tierName('balanced'), en.tierName('quality'))),
    ).toBeTruthy()
  })

  it('shows only the skip note when degraded AND skipped — nothing "ran"', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'quality', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: true,
      skipped: 'llm_unavailable',
    }
    useStore.setState({ llmEffective, user: user(FULL) })
    render(<Sidebar />)

    expect(
      screen.queryByText(en.llmDegraded(en.tierName('balanced'), en.tierName('quality'))),
    ).toBeNull()
    expect(screen.getByText(en.llmSkippedServer)).toBeTruthy()
  })

  it('shows llmNotIncluded when skipped for a floor-policy user', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'balanced', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: false,
      skipped: 'llm_unavailable',
    }
    useStore.setState({ llmEffective, user: user(FLOOR) })
    render(<Sidebar />)

    expect(screen.getByText(en.llmNotIncluded)).toBeTruthy()
  })

  it('shows llmSkippedServer when skipped for an unrestricted user', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'balanced', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: false,
      skipped: 'llm_unavailable',
    }
    useStore.setState({ llmEffective, user: user(FULL) })
    render(<Sidebar />)

    expect(screen.getByText(en.llmSkippedServer)).toBeTruthy()
  })
})
