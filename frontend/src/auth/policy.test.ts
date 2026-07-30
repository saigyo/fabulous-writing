import { describe, expect, test } from 'vitest'
import type { MeResponse } from '../api/client'
import {
  hasFeature,
  llmDisabled,
  modelAllowed,
  providerAllowed,
  tierAllowed,
} from './policy'

function user(policy: MeResponse['policy']): MeResponse {
  return {
    id: 2, email: 'u@example.com', display_name: null, tier: 'basic',
    is_admin: false, policy,
    usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
    limits: {
      max_document_chars: 200000,
      max_llm_document_chars: 200000,
      concurrent_llm_runs: 5,
    },
    allow_additional_admins: false,
  }
}

const FULL: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: ['custom_profiles', 'custom_domains'],
}
const RESTRICTED: MeResponse['policy'] = {
  llm: { tiers: ['cheap', 'local'], providers: ['ollama'], models: { ollama: ['llama3.1'] } },
  features: [],
}
const FLOOR: MeResponse['policy'] = {
  llm: { tiers: [], providers: [], models: null },
  features: [],
}

describe('policy helpers', () => {
  test('null user (session not restored) is unrestricted — gating is cosmetic', () => {
    expect(tierAllowed(null, 'quality')).toBe(true)
    expect(providerAllowed(null, 'claude')).toBe(true)
    expect(modelAllowed(null, 'claude', 'claude-opus-4-8')).toBe(true)
    expect(hasFeature(null, 'custom_profiles')).toBe(true)
    expect(llmDisabled(null)).toBe(false)
  })

  test('null dimensions mean unrestricted', () => {
    expect(tierAllowed(user(FULL), 'quality')).toBe(true)
    expect(llmDisabled(user(FULL))).toBe(false)
  })

  test('lists restrict', () => {
    const u = user(RESTRICTED)
    expect(tierAllowed(u, 'balanced')).toBe(false)
    expect(tierAllowed(u, 'cheap')).toBe(true)
    expect(providerAllowed(u, 'claude')).toBe(false)
    expect(modelAllowed(u, 'ollama', 'llama3.1')).toBe(true)
    expect(modelAllowed(u, 'ollama', 'qwen3:8b')).toBe(false)
    expect(modelAllowed(u, 'claude', 'claude-sonnet-5')).toBe(false) // provider disallowed ⇒ model too
    expect(hasFeature(u, 'custom_domains')).toBe(false)
  })

  test('floor is both lists empty, and only that', () => {
    expect(llmDisabled(user(FLOOR))).toBe(true)
    expect(llmDisabled(user(RESTRICTED))).toBe(false)
    const tiersOnlyEmpty: MeResponse['policy'] = {
      llm: { tiers: [], providers: ['ollama'], models: null }, features: [],
    }
    expect(llmDisabled(user(tiersOnlyEmpty))).toBe(false)
  })
})
