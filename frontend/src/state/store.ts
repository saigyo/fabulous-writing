import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TrackedFinding } from '../editor/findings'
import type { Domain, Language, ProviderInfo } from '../types'

export type CheckPhase = 'idle' | 'fast' | 'llm'
export type ActiveView = 'editor' | 'terminology'

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

      setLanguage: (language) => set({ language }),
      setDomainId: (domainId) => set({ domainId }),
      setProvider: (provider) => set({ provider, model: null }),
      setModel: (model) => set({ model }),
      setLlmAuto: (llmAuto) => set({ llmAuto }),
      setActiveView: (activeView) => set({ activeView }),
      setTracked: (tracked, selectedId) => set({ tracked, selectedId }),
      setCheckPhase: (checkPhase) => set({ checkPhase }),
      setLlmError: (llmError) => set({ llmError }),
      setProviders: (providers) => set({ providers }),
      setDomains: (domains) => set({ domains }),
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
