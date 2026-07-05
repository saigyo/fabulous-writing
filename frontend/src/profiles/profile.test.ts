import { describe, expect, it } from 'vitest'
import type { Profile } from '../types'
import {
  applyProfileToHeader,
  effectiveRuleConfig,
  isProfileDirty,
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
    domain_ids: [2, 1],
    llm_provider: 'ollama',
    llm_model: null,
    llm_instructions: '',
    example_text: 'Example.',
    ...overrides,
  }
}

describe('applyProfileToHeader', () => {
  it('copies domains, provider, and model', () => {
    expect(applyProfileToHeader(profile({ llm_model: 'llama3.1' }))).toEqual({
      domainIds: [2, 1],
      provider: 'ollama',
      model: 'llama3.1',
    })
  })

  it('keeps the current provider when the profile has none', () => {
    const p = profile({ llm_provider: null })
    expect(applyProfileToHeader(p, 'claude')).toEqual({
      domainIds: [2, 1],
      provider: 'claude',
      model: null,
    })
  })
})

describe('isProfileDirty', () => {
  const header = { domainIds: [1, 2], provider: 'ollama', model: null }

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
    const p = profile({ categories_off: ['style'], rule_exceptions: ['a.b'] })
    expect(effectiveRuleConfig(p)).toEqual({
      categories_off: ['style'],
      exceptions: ['a.b'],
    })
  })

  it('is null without a profile', () => {
    expect(effectiveRuleConfig(null)).toBeNull()
  })
})

describe('isRuleActive', () => {
  it('mirrors the backend XOR semantics', () => {
    const p = profile({ categories_off: ['style'], rule_exceptions: ['style.a', 'grammar.b'] })
    expect(isRuleActive(p, 'style', 'style.a')).toBe(true) // off + exception -> on
    expect(isRuleActive(p, 'style', 'style.x')).toBe(false) // off -> off
    expect(isRuleActive(p, 'grammar', 'grammar.b')).toBe(false) // on + exception -> off
    expect(isRuleActive(p, 'grammar', 'grammar.y')).toBe(true) // on -> on
  })
})
