import type {
  Category,
  CheckStatus,
  Domain,
  Finding,
  Language,
  LanguageInfo,
  Profile,
  ProviderInfo,
  RoutingTable,
  RuleError,
  RuleInfo,
  Term,
} from '../types'

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export interface RuleConfig {
  categories_off: Category[]
  exceptions: string[]
}

export interface CheckRequest {
  text: string
  language: Language
  domain_ids: number[]
  checkers: string[]
  rule_config?: RuleConfig | null
  llm_provider?: string | null
  llm_model?: string | null
  llm_instructions?: string
}

export function postCheck(body: CheckRequest): Promise<CheckStatus> {
  return request('/api/checks', { method: 'POST', body: JSON.stringify(body) })
}

export interface CheckEventHandlers {
  onResult: (checker: string, findings: Finding[]) => void
  onError: (checker: string, error: string) => void
  onDone: () => void
  onProgress?: (tokens: number) => void
}

export function subscribeCheck(
  checkId: string,
  handlers: CheckEventHandlers,
): () => void {
  const source = new EventSource(`${BASE}/api/checks/${checkId}/events`)
  source.addEventListener('checker_result', (event) => {
    const data = JSON.parse((event as MessageEvent).data)
    handlers.onResult(data.checker, data.findings)
  })
  source.addEventListener('llm_progress', (event) => {
    const data = JSON.parse((event as MessageEvent).data)
    handlers.onProgress?.(data.tokens)
  })
  source.addEventListener('checker_error', (event) => {
    const data = JSON.parse((event as MessageEvent).data)
    handlers.onError(data.checker, data.error)
  })
  source.addEventListener('done', () => {
    source.close()
    handlers.onDone()
  })
  source.onerror = () => {
    source.close()
    handlers.onDone()
  }
  return () => source.close()
}

export interface SuggestionRequest {
  text: string
  span: { start: number; end: number }
  message: string
  language: Language
  scope?: 'span' | 'sentence'
  rule_id?: string | null
  llm_provider?: string | null
  llm_model?: string | null
  llm_instructions?: string
}

export interface SuggestionResponse {
  suggestions: string[]
  span: { start: number; end: number }
  original: string
  rejected: number
}

export const postSuggestions = (body: SuggestionRequest) =>
  request<SuggestionResponse>('/api/suggestions', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const getProviders = () => request<ProviderInfo[]>('/api/providers')

export const getRouting = () => request<RoutingTable>('/api/routing')

export const getLanguages = () => request<LanguageInfo[]>('/api/languages')

export interface RulesResponse {
  rules: RuleInfo[]
  errors: RuleError[]
}

export const getRules = (language: Language) =>
  request<RulesResponse>(`/api/rules?language=${language}`)

export const getDomains = () => request<Domain[]>('/api/domains')
export const createDomain = (name: string, description = '') =>
  request<Domain>('/api/domains', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  })
export const deleteDomain = (id: number) =>
  request<void>(`/api/domains/${id}`, { method: 'DELETE' })

export const getTerms = (domainId: number) =>
  request<Term[]>(`/api/domains/${domainId}/terms`)
export const createTerm = (domainId: number, term: Omit<Term, 'id' | 'domain_id'>) =>
  request<Term>(`/api/domains/${domainId}/terms`, {
    method: 'POST',
    body: JSON.stringify(term),
  })
export const updateTerm = (termId: number, term: Partial<Omit<Term, 'id' | 'domain_id'>>) =>
  request<Term>(`/api/terms/${termId}`, {
    method: 'PUT',
    body: JSON.stringify(term),
  })
export const deleteTerm = (termId: number) =>
  request<void>(`/api/terms/${termId}`, { method: 'DELETE' })

export type ProfilePayload = Omit<Profile, 'id' | 'is_standard'>

export const getProfiles = (language: Language) =>
  request<Profile[]>(`/api/profiles?language=${language}`)
export const createProfile = (payload: ProfilePayload) =>
  request<Profile>('/api/profiles', { method: 'POST', body: JSON.stringify(payload) })
export const updateProfile = (id: number, payload: Omit<ProfilePayload, 'language'>) =>
  request<Profile>(`/api/profiles/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
export const deleteProfile = (id: number) =>
  request<void>(`/api/profiles/${id}`, { method: 'DELETE' })
export const resetProfile = (id: number) =>
  request<Profile>(`/api/profiles/${id}/reset`, { method: 'POST' })
