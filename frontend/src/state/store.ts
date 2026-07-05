import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TrackedFinding } from '../editor/findings'
import { mapEquivalentIds } from '../findings/equivalence'
import type { Locale } from '../i18n/messages'
import { FALLBACK_LANGUAGES } from '../languages'
import type { Domain, Language, LanguageInfo, ProviderInfo, Severity } from '../types'

export type CheckPhase = 'idle' | 'fast' | 'llm'
export type ActiveView = 'editor' | 'rules' | 'terminology'

interface AppState {
  language: Language
  // UI display language; null = follow the browser locale.
  uiLocale: Locale | null
  domainId: number | null
  provider: string
  model: string | null
  llmAuto: boolean
  activeView: ActiveView
  tracked: TrackedFinding[]
  selectedId: string | null
  // Persists across checks and resolved findings by design; only explicit
  // clicks change it.
  severityFilter: Severity | null
  checkPhase: CheckPhase
  llmError: string | null
  // Live progress of the running LLM check (null outside the llm phase).
  llmStartedAt: number | null
  llmTokens: number | null
  providers: ProviderInfo[]
  domains: Domain[]
  languages: LanguageInfo[]
  extraSuggestions: Record<string, string[]>
  suggestPendingId: string | null
  suggestErrors: Record<string, string>
  rewrites: Record<string, Rewrite>
  rewritePendingId: string | null
  rewriteErrors: Record<string, string>

  setLanguage: (language: Language) => void
  setUiLocale: (uiLocale: Locale) => void
  setDomainId: (domainId: number | null) => void
  setProvider: (provider: string) => void
  setModel: (model: string | null) => void
  setLlmAuto: (llmAuto: boolean) => void
  setActiveView: (view: ActiveView) => void
  setTracked: (tracked: TrackedFinding[], selectedId: string | null) => void
  setSeverityFilter: (severityFilter: Severity | null) => void
  setCheckPhase: (phase: CheckPhase) => void
  setLlmError: (error: string | null) => void
  setProviders: (providers: ProviderInfo[]) => void
  setDomains: (domains: Domain[]) => void
  setLanguages: (languages: LanguageInfo[]) => void
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
      domainId: null,
      provider: 'ollama',
      model: null,
      llmAuto: true,
      activeView: 'editor',
      tracked: [],
      selectedId: null,
      severityFilter: null,
      checkPhase: 'idle',
      llmError: null,
      llmStartedAt: null,
      llmTokens: null,
      providers: [],
      domains: [],
      languages: FALLBACK_LANGUAGES,
      extraSuggestions: {},
      suggestPendingId: null,
      suggestErrors: {},
      rewrites: {},
      rewritePendingId: null,
      rewriteErrors: {},

      setLanguage: (language) => set({ language }),
      setUiLocale: (uiLocale) => set({ uiLocale }),
      setDomainId: (domainId) => set({ domainId }),
      setProvider: (provider) => set({ provider, model: null }),
      setModel: (model) => set({ model }),
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
      setCheckPhase: (checkPhase) => set({ checkPhase }),
      setLlmError: (llmError) => set({ llmError }),
      setProviders: (providers) => set({ providers }),
      setDomains: (domains) => set({ domains }),
      setLanguages: (languages) => set({ languages }),
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
      partialize: (state) => ({
        language: state.language,
        uiLocale: state.uiLocale,
        domainId: state.domainId,
        provider: state.provider,
        model: state.model,
        llmAuto: state.llmAuto,
      }),
    },
  ),
)
