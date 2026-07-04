import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TrackedFinding } from '../editor/findings'
import { FALLBACK_LANGUAGES } from '../languages'
import type { Domain, Language, LanguageInfo, ProviderInfo } from '../types'

export type CheckPhase = 'idle' | 'fast' | 'llm'
export type ActiveView = 'editor' | 'rules' | 'terminology'

interface AppState {
  language: Language
  domainId: number | null
  provider: string
  model: string | null
  llmAuto: boolean
  activeView: ActiveView
  tracked: TrackedFinding[]
  selectedId: string | null
  checkPhase: CheckPhase
  llmError: string | null
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
  setDomainId: (domainId: number | null) => void
  setProvider: (provider: string) => void
  setModel: (model: string | null) => void
  setLlmAuto: (llmAuto: boolean) => void
  setActiveView: (view: ActiveView) => void
  setTracked: (tracked: TrackedFinding[], selectedId: string | null) => void
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

function pruneByFinding<T>(
  map: Record<string, T>,
  tracked: TrackedFinding[],
): Record<string, T> {
  const alive = new Set(tracked.map((item) => item.finding.id))
  return Object.fromEntries(Object.entries(map).filter(([id]) => alive.has(id)))
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      language: 'en',
      domainId: null,
      provider: 'ollama',
      model: null,
      llmAuto: true,
      activeView: 'editor',
      tracked: [],
      selectedId: null,
      checkPhase: 'idle',
      llmError: null,
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
      setDomainId: (domainId) => set({ domainId }),
      setProvider: (provider) => set({ provider, model: null }),
      setModel: (model) => set({ model }),
      setLlmAuto: (llmAuto) => set({ llmAuto }),
      setActiveView: (activeView) => set({ activeView }),
      setTracked: (tracked, selectedId) =>
        set((state) => ({
          tracked,
          selectedId,
          // Cached LLM suggestions and rewrites die with their finding.
          extraSuggestions: pruneByFinding(state.extraSuggestions, tracked),
          suggestErrors: pruneByFinding(state.suggestErrors, tracked),
          rewrites: pruneByFinding(state.rewrites, tracked),
          rewriteErrors: pruneByFinding(state.rewriteErrors, tracked),
        })),
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
        domainId: state.domainId,
        provider: state.provider,
        model: state.model,
        llmAuto: state.llmAuto,
      }),
    },
  ),
)
