import type { RuleConfig } from '../api/client'
import type { Profile } from '../types'

export interface HeaderSettings {
  domainIds: number[]
  provider: string
  model: string | null
}

/** Values the header selectors take when this profile is selected. */
export function applyProfileToHeader(
  profile: Profile,
  currentProvider?: string,
): HeaderSettings {
  return {
    domainIds: [...profile.domain_ids],
    provider: profile.llm_provider ?? currentProvider ?? 'ollama',
    model: profile.llm_model,
  }
}

/** True when the header selectors differ from the stored profile. */
export function isProfileDirty(profile: Profile, header: HeaderSettings): boolean {
  const a = new Set(profile.domain_ids)
  const b = new Set(header.domainIds)
  if (a.size !== b.size || [...a].some((id) => !b.has(id))) return true
  // A null profile provider means "no preference recorded" — never dirty.
  if (profile.llm_provider !== null && profile.llm_provider !== header.provider)
    return true
  return (profile.llm_model ?? null) !== (header.model ?? null)
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
