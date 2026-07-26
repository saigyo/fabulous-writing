import { describe, expect, it } from 'vitest'
import type { Category, Profile, Tier } from '../types'
import {
  applyProfileToHeader,
  effectiveRuleConfig,
  isProfileDirty,
  resolveProfileModel,
  isRuleActive,
} from './profile'

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    language: 'en',
    name: 'Standard',
    is_standard: true,
    categories_off: [],
    rule_exceptions: [],
    packs_on: [],
    domain_ids: [2, 1],
    llm_provider: 'ollama',
    llm_model: null,
    llm_tier: null,
    llm_instructions: '',
    example_text: 'Example.',
    is_global: true,
    ...overrides,
  }
}

describe('applyProfileToHeader', () => {
  it('copies domains, provider, and model', () => {
    expect(applyProfileToHeader(profile({ llm_model: 'llama3.1' }))).toEqual({
      domainIds: [2, 1],
      tier: null,
      provider: 'ollama',
      model: 'llama3.1',
    })
  })

  it('leaves the header untouched when the profile has no LLM opinion', () => {
    const p = profile({ llm_provider: null })
    expect(applyProfileToHeader(p)).toEqual({
      domainIds: [2, 1],
    })
  })
})

describe('isProfileDirty', () => {
  const header = { domainIds: [1, 2], tier: null, provider: 'ollama', model: null }

  it('is clean when values match (domain order ignored)', () => {
    expect(isProfileDirty(profile(), header)).toBe(false)
  })

  it('is dirty on any difference', () => {
    expect(isProfileDirty(profile(), { ...header, domainIds: [1] })).toBe(true)
    expect(isProfileDirty(profile(), { ...header, provider: 'claude' })).toBe(true)
    expect(isProfileDirty(profile(), { ...header, model: 'x' })).toBe(true)
  })

  it('is dirty when the header has extra domains', () => {
    expect(isProfileDirty(profile(), { ...header, domainIds: [1, 2, 3] })).toBe(true)
  })

  it('a null profile provider matches any header provider', () => {
    expect(isProfileDirty(profile({ llm_provider: null }), header)).toBe(false)
  })
})

describe('effectiveRuleConfig', () => {
  it('maps the profile fields', () => {
    const p = profile({
      categories_off: ['style'],
      rule_exceptions: ['a.b'],
      packs_on: ['techdocs'],
    })
    expect(effectiveRuleConfig(p)).toEqual({
      categories_off: ['style'],
      exceptions: ['a.b'],
      packs_on: ['techdocs'],
    })
  })

  it('is null without a profile', () => {
    expect(effectiveRuleConfig(null)).toBeNull()
  })
})

describe('isRuleActive', () => {
  it('mirrors the backend XOR semantics', () => {
    const p = profile({ categories_off: ['style'], rule_exceptions: ['style.a', 'grammar.b'] })
    expect(isRuleActive(p, 'style', 'style.a', null)).toBe(true) // off + exception -> on
    expect(isRuleActive(p, 'style', 'style.x', null)).toBe(false) // off -> off
    expect(isRuleActive(p, 'grammar', 'grammar.b', null)).toBe(false) // on + exception -> off
    expect(isRuleActive(p, 'grammar', 'grammar.y', null)).toBe(true) // on -> on
  })
})

describe('pack-aware rule activation', () => {
  const base = {
    id: 1, language: 'en', name: 'P', is_standard: false,
    categories_off: [], rule_exceptions: [], packs_on: ['techdocs'],
    domain_ids: [], llm_provider: null, llm_model: null, llm_tier: null,
    llm_instructions: '', example_text: '', is_global: true,
  } as Profile

  it('keeps general rules on the XOR semantics', () => {
    expect(isRuleActive(base, 'style', 'style.plain', null)).toBe(true)
  })
  it('activates pack rules only when the pack is on', () => {
    expect(isRuleActive(base, 'style', 'style.docs', 'techdocs')).toBe(true)
    expect(isRuleActive(base, 'style', 'style.hype', 'marketing')).toBe(false)
  })
  it('lets exceptions invert pack membership', () => {
    const p = { ...base, rule_exceptions: ['style.docs', 'style.cherry'] }
    expect(isRuleActive(p, 'style', 'style.docs', 'techdocs')).toBe(false)
    expect(isRuleActive(p, 'style', 'style.cherry', 'marketing')).toBe(true)
  })
  it('lets the category toggle win over the pack', () => {
    const p = { ...base, categories_off: ['style' as Category] }
    expect(isRuleActive(p, 'style', 'style.docs', 'techdocs')).toBe(false)
  })
  it('carries packs_on into the effective rule config', () => {
    expect(effectiveRuleConfig(base)?.packs_on).toEqual(['techdocs'])
  })
})

describe('tier-aware profile semantics', () => {
  const base = {
    id: 1, language: 'en' as const, name: 'P', is_standard: false,
    categories_off: [], rule_exceptions: [], packs_on: [], domain_ids: [],
    llm_instructions: '', example_text: '', is_global: true,
  }
  const pinnedProfile = { ...base, llm_provider: 'claude', llm_model: 'claude-sonnet-5', llm_tier: null }
  const tierProfile = { ...base, llm_provider: null, llm_model: null, llm_tier: 'quality' as const }
  const noOpinion = { ...base, llm_provider: null, llm_model: null, llm_tier: null }

  it('applyProfileToHeader: pin wins over tier', () => {
    expect(applyProfileToHeader({ ...pinnedProfile, llm_tier: 'cheap' })).toEqual({
      domainIds: [], tier: null, provider: 'claude', model: 'claude-sonnet-5',
    })
  })

  it('applyProfileToHeader: tier profile applies the tier only', () => {
    expect(applyProfileToHeader(tierProfile)).toEqual({ domainIds: [], tier: 'quality' })
  })

  it('applyProfileToHeader: no opinion leaves LLM fields untouched', () => {
    expect(applyProfileToHeader(noOpinion)).toEqual({ domainIds: [] })
  })

  it('isProfileDirty: tier profile vs matching header is clean', () => {
    expect(isProfileDirty(tierProfile, {
      domainIds: [], tier: 'quality', provider: 'ollama', model: null,
    })).toBe(false)
  })

  it('isProfileDirty: tier profile vs different tier or pinned header is dirty', () => {
    expect(isProfileDirty(tierProfile, {
      domainIds: [], tier: 'balanced', provider: 'ollama', model: null,
    })).toBe(true)
    expect(isProfileDirty(tierProfile, {
      domainIds: [], tier: null, provider: 'ollama', model: null,
    })).toBe(true)
  })

  it('isProfileDirty: pinned profile vs tier-mode header is dirty', () => {
    expect(isProfileDirty(pinnedProfile, {
      domainIds: [], tier: 'balanced', provider: 'claude', model: 'claude-sonnet-5',
    })).toBe(true)
  })

  it('isProfileDirty: no-opinion profile never dirty on LLM fields', () => {
    expect(isProfileDirty(noOpinion, {
      domainIds: [], tier: 'quality', provider: 'claude', model: 'x',
    })).toBe(false)
  })
})

describe('resolveProfileModel', () => {
  const providers = [
    { name: 'claude', available: true, models: ['claude-sonnet-5'], default_model: 'claude-sonnet-5' },
  ]
  const routing = {
    default_tier: 'balanced' as const,
    tiers: ['quality', 'balanced', 'cheap', 'local'] as Tier[],
    languages: {
      en: {
        balanced: {
          provider: 'claude', model: 'claude-sonnet-5', available: true, reason: null,
        },
        quality: {
          provider: 'deepseek', model: 'deepseek-v4-pro',
          available: false, reason: 'missing DEEPSEEK_API_KEY',
        },
      },
    },
  }

  it('pinned profile resolves to the pin, model falling back to the default', () => {
    const p = profile({ llm_provider: 'claude', llm_model: null, llm_tier: 'cheap' })
    expect(resolveProfileModel(p, providers, routing)).toEqual({
      ok: true, provider: 'claude', model: 'claude-sonnet-5',
    })
  })

  it('tier profile resolves through the routing table', () => {
    const p = profile({ llm_provider: null, llm_tier: 'balanced' })
    expect(resolveProfileModel(p, providers, routing)).toEqual({
      ok: true, provider: 'claude', model: 'claude-sonnet-5',
    })
  })

  it('unavailable tier reports the reason', () => {
    const p = profile({ llm_provider: null, llm_tier: 'quality' })
    expect(resolveProfileModel(p, providers, routing)).toEqual({
      ok: false, reason: 'missing DEEPSEEK_API_KEY',
    })
  })

  it('no-opinion profile resolves to null', () => {
    const p = profile({ llm_provider: null, llm_tier: null })
    expect(resolveProfileModel(p, providers, routing)).toBeNull()
  })
})
