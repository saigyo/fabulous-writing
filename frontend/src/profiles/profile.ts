import type { RuleConfig } from '../api/client'
import type { Category, Profile, Tier } from '../types'

export interface HeaderSettings {
  domainIds: number[]
  tier: Tier | null
  provider: string
  model: string | null
}

/**
 * Header values a profile selection implies. Pin wins over tier wins over
 * "no opinion" (both null: the header's LLM settings stay untouched).
 */
export function applyProfileToHeader(profile: Profile): {
  domainIds: number[]
  tier?: Tier | null
  provider?: string
  model?: string | null
} {
  const base = { domainIds: [...profile.domain_ids] }
  if (profile.llm_provider !== null) {
    return {
      ...base,
      tier: null,
      provider: profile.llm_provider,
      model: profile.llm_model,
    }
  }
  if (profile.llm_tier !== null) return { ...base, tier: profile.llm_tier }
  return base
}

/** True when the header selectors differ from the stored profile. */
export function isProfileDirty(profile: Profile, header: HeaderSettings): boolean {
  const a = new Set(profile.domain_ids)
  const b = new Set(header.domainIds)
  if (a.size !== b.size || [...a].some((id) => !b.has(id))) return true
  if (profile.llm_provider !== null) {
    return (
      header.tier !== null ||
      profile.llm_provider !== header.provider ||
      (profile.llm_model ?? null) !== (header.model ?? null)
    )
  }
  if (profile.llm_tier !== null) return header.tier !== profile.llm_tier
  // No LLM opinion recorded — the header's LLM settings are never dirty.
  return false
}

/** The currently selected profile, if it exists in the loaded list. */
export function activeProfile(state: {
  profiles: Profile[]
  profileId: number | null
}): Profile | null {
  return state.profiles.find((p) => p.id === state.profileId) ?? null
}

export function effectiveRuleConfig(profile: Profile | null): RuleConfig | null {
  if (!profile) return null
  return {
    categories_off: profile.categories_off,
    exceptions: profile.rule_exceptions,
  }
}

/** Mirrors the backend rule-activation semantics (XOR). */
export function isRuleActive(
  profile: Profile,
  category: Category,
  ruleId: string,
): boolean {
  return (
    !profile.categories_off.includes(category) !==
    profile.rule_exceptions.includes(ruleId)
  )
}
