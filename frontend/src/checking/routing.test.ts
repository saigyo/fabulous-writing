import { describe, expect, it } from 'vitest'
import type { ProviderInfo, RoutingTable } from '../types'
import { resolveModel } from './routing'

const providers: ProviderInfo[] = [
  { name: 'claude', available: true, models: ['claude-sonnet-5'], default_model: 'claude-sonnet-5' },
]

const routing: RoutingTable = {
  default_tier: 'balanced',
  tiers: ['quality', 'balanced', 'cheap', 'local'],
  languages: {
    de: {
      balanced: { provider: 'mistral', model: 'mistral-large-latest', available: true, reason: null },
      quality: { provider: 'claude', model: 'claude-opus-4-8', available: false, reason: 'missing ANTHROPIC_API_KEY' },
    },
  },
}

describe('resolveModel', () => {
  it('pinned mode returns the pair, model falling back to the provider default', () => {
    const result = resolveModel({
      tier: null, provider: 'claude', model: null, language: 'de', providers, routing,
    })
    expect(result).toEqual({ ok: true, provider: 'claude', model: 'claude-sonnet-5' })
  })

  it('tier mode resolves through the routing table', () => {
    const result = resolveModel({
      tier: 'balanced', provider: 'claude', model: null, language: 'de', providers, routing,
    })
    expect(result).toEqual({ ok: true, provider: 'mistral', model: 'mistral-large-latest' })
  })

  it('unavailable tier reports the reason', () => {
    const result = resolveModel({
      tier: 'quality', provider: 'claude', model: null, language: 'de', providers, routing,
    })
    expect(result).toEqual({ ok: false, reason: 'missing ANTHROPIC_API_KEY' })
  })

  it('missing tier or language reports not configured', () => {
    expect(
      resolveModel({ tier: 'cheap', provider: 'claude', model: null, language: 'de', providers, routing }),
    ).toEqual({ ok: false, reason: 'not configured' })
    expect(
      resolveModel({ tier: 'balanced', provider: 'claude', model: null, language: 'en', providers, routing }),
    ).toEqual({ ok: false, reason: 'not configured' })
  })

  it('missing routing table reports not configured', () => {
    expect(
      resolveModel({ tier: 'balanced', provider: 'claude', model: null, language: 'de', providers, routing: null }),
    ).toEqual({ ok: false, reason: 'not configured' })
  })
})
