import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TrackedFinding } from '../editor/findings'
import { mapEquivalentIds } from '../findings/equivalence'
import type { SourceGroup } from '../findings/source'
import type { Locale } from '../i18n/messages'
import { FALLBACK_LANGUAGES } from '../languages'
import { applyProfileToHeader } from '../profiles/profile'
import type {
  Domain,
  Language,
  LanguageInfo,
  Profile,
  ProviderInfo,
  RoutingTable,
  Severity,
  Tier,
} from '../types'

export type CheckPhase = 'idle' | 'fast' | 'llm'
export type ActiveView = 'editor' | 'rules' | 'terminology' | 'profiles'

interface AppState {
  language: Language
  // UI display language; null = follow the browser locale.
  uiLocale: Locale | null
  domainIds: number[]
  provider: string
  model: string | null
  // null = pinned to provider/model; non-null = tier mode.
  tier: Tier | null
  llmAuto: boolean
  activeView: ActiveView
  tracked: TrackedFinding[]
  selectedId: string | null
  // Persists across checks and resolved findings by design; only explicit
  // clicks change it.
  severityFilter: Severity | null
  // Independent of severityFilter; both apply at once when set.
  sourceFilter: SourceGroup | null
  checkPhase: CheckPhase
  llmError: string | null
  // Live progress of the running LLM check (null outside the llm phase).
  llmStartedAt: number | null
  llmTokens: number | null
  providers: ProviderInfo[]
  routing: RoutingTable | null
  domains: Domain[]
  languages: LanguageInfo[]
  profiles: Profile[]
  profileId: number | null
  lastProfileByLanguage: Record<string, number>
  extraSuggestions: Record<string, string[]>
  suggestPendingId: string | null
  suggestErrors: Record<string, string>
  rewrites: Record<string, Rewrite>
  rewritePendingId: string | null
  rewriteErrors: Record<string, string>

  setLanguage: (language: Language) => void
  setUiLocale: (uiLocale: Locale) => void
  setDomainIds: (domainIds: number[]) => void
  setProvider: (provider: string) => void
  setModel: (model: string | null) => void
  setTier: (tier: Tier) => void
  // Pin an exact provider+model pair (e.g. adopting a tier's resolved pair).
  setPinned: (provider: string, model: string | null) => void
  setRouting: (routing: RoutingTable | null) => void
  setLlmAuto: (llmAuto: boolean) => void
  setActiveView: (view: ActiveView) => void
  setTracked: (tracked: TrackedFinding[], selectedId: string | null) => void
  setSeverityFilter: (severityFilter: Severity | null) => void
  setSourceFilter: (sourceFilter: SourceGroup | null) => void
  setCheckPhase: (phase: CheckPhase) => void
  setLlmError: (error: string | null) => void
  setProviders: (providers: ProviderInfo[]) => void
  setDomains: (domains: Domain[]) => void
  setLanguages: (languages: LanguageInfo[]) => void
  setProfiles: (profiles: Profile[]) => void
  selectProfile: (profile: Profile, apply: boolean) => void
  setSuggestPending: (findingId: string | null) => void
  setExtraSuggestions: (findingId: string, suggestions: string[]) => void
  setSuggestError: (findingId: string, error: string | null) => void
  setRewritePending: (findingId: string | null) => void
  setRewrite: (findingId: string, rewrite: Rewrite | null) => void
  setRewriteError: (findingId: string, error: string | null) => void
}

export interface Rewrite {
  original: string
  options: string[]
}

function withEntry<T>(
  map: Record<string, T>,
  key: string,
  value: T | null,
): Record<string, T> {
  const next = { ...map }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}

/**
 * Carry per-finding caches over to the new check results: entries move to
 * the equivalent finding's (fresh) id and die only when their finding has
 * no equivalent anymore.
 */
function migrateByFinding<T>(
  map: Record<string, T>,
  idMap: Record<string, string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(map)
      .filter(([id]) => id in idMap)
      .map(([id, value]) => [idMap[id], value]),
  )
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      language: 'en',
      uiLocale: null,
      domainIds: [],
      provider: 'ollama',
      model: null,
      tier: 'balanced',
      llmAuto: true,
      activeView: 'editor',
      tracked: [],
      selectedId: null,
      severityFilter: null,
      sourceFilter: null,
      checkPhase: 'idle',
      llmError: null,
      llmStartedAt: null,
      llmTokens: null,
      providers: [],
      routing: null,
      domains: [],
      languages: FALLBACK_LANGUAGES,
      profiles: [],
      profileId: null,
      lastProfileByLanguage: {},
      extraSuggestions: {},
      suggestPendingId: null,
      suggestErrors: {},
      rewrites: {},
      rewritePendingId: null,
      rewriteErrors: {},

      setLanguage: (language) => set({ language }),
      setUiLocale: (uiLocale) => set({ uiLocale }),
      setDomainIds: (domainIds) => set({ domainIds }),
      setProvider: (provider) => set({ provider, model: null, tier: null }),
      setModel: (model) => set({ model, tier: null }),
      setTier: (tier) => set({ tier }),
      setPinned: (provider, model) => set({ provider, model, tier: null }),
      setRouting: (routing) => set({ routing }),
      setLlmAuto: (llmAuto) => set({ llmAuto }),
      setActiveView: (activeView) => set({ activeView }),
      setTracked: (tracked, selectedId) =>
        set((state) => {
          const idMap = mapEquivalentIds(state.tracked, tracked)
          return {
            tracked,
            selectedId,
            extraSuggestions: migrateByFinding(state.extraSuggestions, idMap),
            suggestErrors: migrateByFinding(state.suggestErrors, idMap),
            rewrites: migrateByFinding(state.rewrites, idMap),
            rewriteErrors: migrateByFinding(state.rewriteErrors, idMap),
          }
        }),
      setSeverityFilter: (severityFilter) => set({ severityFilter }),
      setSourceFilter: (sourceFilter) => set({ sourceFilter }),
      setCheckPhase: (checkPhase) => set({ checkPhase }),
      setLlmError: (llmError) => set({ llmError }),
      setProviders: (providers) => set({ providers }),
      setDomains: (domains) => set({ domains }),
      setLanguages: (languages) => set({ languages }),
      setProfiles: (profiles) => set({ profiles }),
      // apply=true copies the profile's values into the header selectors.
      selectProfile: (profile, apply) =>
        set((state) => ({
          profileId: profile.id,
          lastProfileByLanguage: {
            ...state.lastProfileByLanguage,
            [profile.language]: profile.id,
          },
          ...(apply ? applyProfileToHeader(profile) : {}),
        })),
      setSuggestPending: (suggestPendingId) => set({ suggestPendingId }),
      setExtraSuggestions: (findingId, suggestions) =>
        set((state) => ({
          extraSuggestions: { ...state.extraSuggestions, [findingId]: suggestions },
        })),
      setSuggestError: (findingId, error) =>
        set((state) => ({
          suggestErrors: withEntry(state.suggestErrors, findingId, error),
        })),
      setRewritePending: (rewritePendingId) => set({ rewritePendingId }),
      setRewrite: (findingId, rewrite) =>
        set((state) => ({
          rewrites: withEntry(state.rewrites, findingId, rewrite),
        })),
      setRewriteError: (findingId, error) =>
        set((state) => ({
          rewriteErrors: withEntry(state.rewriteErrors, findingId, error),
        })),
    }),
    {
      name: 'fabulous-writing-settings',
      version: 1,
      // v0 predates tiers: those users had explicitly chosen provider/model,
      // so they stay pinned rather than silently switching models.
      migrate: (persisted, version) =>
        version === 0
          ? { ...(persisted as object), tier: null }
          : (persisted as object),
      partialize: (state) => ({
        language: state.language,
        uiLocale: state.uiLocale,
        domainIds: state.domainIds,
        provider: state.provider,
        model: state.model,
        tier: state.tier,
        llmAuto: state.llmAuto,
        lastProfileByLanguage: state.lastProfileByLanguage,
      }),
    },
  ),
)
