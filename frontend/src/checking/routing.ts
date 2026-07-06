import type { Language, ProviderInfo, RoutingTable, Tier } from '../types'
import { effectiveModel } from './model'

export type Resolution =
  | { ok: true; provider: string; model: string | null }
  | { ok: false; reason: string }

/**
 * Resolve the header's LLM choice to a concrete provider+model. Pinned mode
 * (tier === null) uses the explicit pair; tier mode looks the language up in
 * the routing table. An unavailable or missing entry is an explicit failure
 * — the LLM check is skipped with the reason, never silently degraded.
 */
export function resolveModel(state: {
  tier: Tier | null
  provider: string
  model: string | null
  language: Language
  providers: ProviderInfo[]
  routing: RoutingTable | null
}): Resolution {
  if (state.tier === null) {
    return {
      ok: true,
      provider: state.provider,
      model: effectiveModel(state.model, state.provider, state.providers),
    }
  }
  const entry = state.routing?.languages[state.language]?.[state.tier]
  if (!entry) return { ok: false, reason: 'not configured' }
  if (!entry.available) return { ok: false, reason: entry.reason ?? 'unavailable' }
  return { ok: true, provider: entry.provider, model: entry.model }
}
