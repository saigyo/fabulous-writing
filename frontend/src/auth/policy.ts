import type { MeResponse } from '../api/client'
import type { Tier } from '../types'

/**
 * Gating helpers over the /me policy (spec §8). A null user (session not
 * yet restored) or a null dimension means unrestricted — this layer is
 * cosmetic; the backend enforces and degrades regardless (spec §6.2).
 * These helpers are the UI's single source of truth for plan gating; the
 * `allowed` flags on /api/routing and /api/providers serve API consumers.
 */
export function tierAllowed(user: MeResponse | null, tier: Tier): boolean {
  const allowed = user?.policy.llm.tiers
  return allowed == null || allowed.includes(tier)
}

export function providerAllowed(user: MeResponse | null, name: string): boolean {
  const allowed = user?.policy.llm.providers
  return allowed == null || allowed.includes(name)
}

export function modelAllowed(
  user: MeResponse | null,
  provider: string,
  model: string,
): boolean {
  if (!providerAllowed(user, provider)) return false
  const allow = user?.policy.llm.models?.[provider]
  return allow == null || allow.includes(model)
}

export function hasFeature(
  user: MeResponse | null,
  feature: 'custom_profiles' | 'custom_domains',
): boolean {
  return user == null || user.policy.features.includes(feature)
}

/** The §6.2 floor: both llm lists empty — the UI hides the LLM phase. */
export function llmDisabled(user: MeResponse | null): boolean {
  const llm = user?.policy.llm
  return llm != null && llm.tiers?.length === 0 && llm.providers?.length === 0
}
