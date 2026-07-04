import type {
  CheckStatus,
  Domain,
  Finding,
  Language,
  LanguageInfo,
  ProviderInfo,
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

export interface CheckRequest {
  text: string
  language: Language
  domain_id?: number | null
  checkers: string[]
  llm_provider?: string | null
  llm_model?: string | null
}

export function postCheck(body: CheckRequest): Promise<CheckStatus> {
  return request('/api/checks', { method: 'POST', body: JSON.stringify(body) })
}

export interface CheckEventHandlers {
  onResult: (checker: string, findings: Finding[]) => void
  onError: (checker: string, error: string) => void
  onDone: () => void
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
  llm_provider?: string | null
  llm_model?: string | null
}

export interface SuggestionResponse {
  suggestions: string[]
  span: { start: number; end: number }
  original: string
}

export const postSuggestions = (body: SuggestionRequest) =>
  request<SuggestionResponse>('/api/suggestions', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const getProviders = () => request<ProviderInfo[]>('/api/providers')

export const getLanguages = () => request<LanguageInfo[]>('/api/languages')

export const getDemoText = (language: Language) =>
  request<{ text: string }>(`/api/languages/${language}/demo`)

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
