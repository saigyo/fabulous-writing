import { describe, expect, it } from 'vitest'
import type { FolderDefaults } from '../api/client'
import { defaultsFromHeader, withLanguageDefault } from './FolderDefaultsDialog'

const empty: FolderDefaults = {
  default_language: null,
  default_profile_id: null,
  default_domain_ids: null,
  default_llm_provider: null,
  default_llm_model: null,
  default_llm_tier: null,
  default_llm_auto: null,
}

describe('withLanguageDefault', () => {
  it('changing the language drops the profile default', () => {
    const draft = { ...empty, default_language: 'en', default_profile_id: 3 } as FolderDefaults
    expect(withLanguageDefault(draft, 'de').default_profile_id).toBeNull()
    expect(withLanguageDefault(draft, 'de').default_language).toBe('de')
  })

  it('clearing the language drops the profile default', () => {
    const draft = { ...empty, default_language: 'en', default_profile_id: 3 } as FolderDefaults
    expect(withLanguageDefault(draft, null).default_profile_id).toBeNull()
    expect(withLanguageDefault(draft, null).default_language).toBeNull()
  })

  it('re-selecting the same language keeps the profile default', () => {
    const draft = { ...empty, default_language: 'en', default_profile_id: 3 } as FolderDefaults
    expect(withLanguageDefault(draft, 'en').default_profile_id).toBe(3)
  })
})

describe('defaultsFromHeader', () => {
  it('tier mode: tier set, pin fields null', () => {
    const d = defaultsFromHeader({
      language: 'de',
      profileId: 9,
      domainIds: [4],
      provider: 'ollama',
      model: 'llama3',
      tier: 'cheap',
      llmAuto: false,
    })
    expect(d).toEqual({
      default_language: 'de',
      default_profile_id: 9,
      default_domain_ids: [4],
      default_llm_provider: null,
      default_llm_model: null,
      default_llm_tier: 'cheap',
      default_llm_auto: false,
    })
  })

  it('pinned mode: provider/model set, tier null', () => {
    const d = defaultsFromHeader({
      language: 'en',
      profileId: null,
      domainIds: [],
      provider: 'openai',
      model: 'gpt-4o',
      tier: null,
      llmAuto: true,
    })
    expect(d.default_llm_provider).toBe('openai')
    expect(d.default_llm_model).toBe('gpt-4o')
    expect(d.default_llm_tier).toBeNull()
    expect(d.default_domain_ids).toEqual([])
  })
})
