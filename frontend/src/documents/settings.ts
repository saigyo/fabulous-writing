import type { DocumentSettingsPayload } from '../api/client'
import type { Language, Tier } from '../types'

/** The document-settings payload as derived from header state — the single
 * mapping used by autosave snapshots and document creation alike. */
export function settingsPayload(s: {
  language: Language
  profileId: number | null
  domainIds: number[]
  provider: string
  model: string | null
  tier: Tier | null
  llmAuto: boolean
}): DocumentSettingsPayload {
  return {
    language: s.language,
    profile_id: s.profileId,
    domain_ids: s.domainIds,
    llm_provider: s.tier === null ? s.provider : null,
    llm_model: s.tier === null ? s.model : null,
    llm_tier: s.tier,
    llm_auto: s.llmAuto,
  }
}
