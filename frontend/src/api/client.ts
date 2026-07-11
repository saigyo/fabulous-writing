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
  Scorecard,
  Tier,
  Term,
} from '../types'

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `${init?.method ?? 'GET'} ${path} failed: ${response.status}`,
    )
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export interface RuleConfig {
  categories_off: Category[]
  exceptions: string[]
  packs_on: string[]
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
  onScorecard?: (scorecard: Scorecard) => void
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
  source.addEventListener('scorecard', (event) => {
    const data = JSON.parse((event as MessageEvent).data)
    handlers.onScorecard?.(data)
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

export interface HeldBackSuggestion {
  text: string
  reason_kind: 'rules' | 'spelling'
  rule_ids: string[]
  words: string[]
}

export interface SuggestionResponse {
  suggestions: string[]
  span: { start: number; end: number }
  original: string
  rejected: number
  held_back: HeldBackSuggestion[]
  advice: string[]
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
  packs: string[]
}

export const getRules = (language: Language) =>
  request<RulesResponse>(`/api/rules?language=${language}`)

export const getDomains = () => request<Domain[]>('/api/domains')
export const createDomain = (name: string, description = '') =>
  request<Domain>('/api/domains', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  })
export const updateDomain = (id: number, name: string) =>
  request<Domain>(`/api/domains/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
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

export interface DocumentSummary {
  id: number
  name: string
  language: Language
  folder_id: number | null
  created_at: string
  edited_at: string
  checked_at: string | null
  updated_at: string
}

export interface SavedFinding {
  finding: Finding
  from: number
  to: number
}

export interface ScorecardSnapshot {
  card: Scorecard
  stale: boolean
}

export type NameSource = 'fallback' | 'llm' | 'user'

export interface DocumentFull {
  id: number
  owner_id: number
  name: string
  name_source: NameSource
  text: string
  language: Language
  profile_id: number | null
  domain_ids: number[]
  llm_provider: string | null
  llm_model: string | null
  llm_tier: Tier | null
  llm_auto: boolean
  last_findings: SavedFinding[]
  scorecard: ScorecardSnapshot | null
  folder_id: number | null
  revision: number
  created_at: string
  updated_at: string
  edited_at: string
  checked_at: string | null
}

export interface DocumentSettingsPayload {
  language: Language
  profile_id: number | null
  domain_ids: number[]
  llm_provider: string | null
  llm_model: string | null
  llm_tier: Tier | null
  llm_auto: boolean
}

export interface DocumentContentPayload {
  text: string
  findings: SavedFinding[]
  scorecard: ScorecardSnapshot | null
}

export interface DocumentCreatePayload extends Partial<DocumentSettingsPayload> {
  name: string
  language: Language
  folder_id?: number | null
  name_source?: 'fallback' | 'user'
  text?: string
  findings?: SavedFinding[]
  scorecard?: ScorecardSnapshot | null
}

export interface DocumentUpdatePayload {
  revision: number
  name?: string
  content?: DocumentContentPayload
  settings?: DocumentSettingsPayload
}

export const listDocuments = () => request<DocumentSummary[]>('/api/documents')
export const getDocument = (id: number) =>
  request<DocumentFull>(`/api/documents/${id}`)
export const createDocument = (payload: DocumentCreatePayload) =>
  request<DocumentFull>('/api/documents', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
export const updateDocument = (id: number, payload: DocumentUpdatePayload) =>
  request<DocumentFull>(`/api/documents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
export const deleteDocument = (id: number) =>
  request<void>(`/api/documents/${id}`, { method: 'DELETE' })
export const generateDocumentName = (id: number) =>
  request<DocumentFull>(`/api/documents/${id}/generate-name`, { method: 'POST' })

export interface Folder {
  id: number
  name: string
  created_at: string
}

export const listFolders = () => request<Folder[]>('/api/folders')
export const createFolder = (name: string) =>
  request<Folder>('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const renameFolder = (id: number, name: string) =>
  request<Folder>(`/api/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  })
export const deleteFolder = (id: number) =>
  request<void>(`/api/folders/${id}`, { method: 'DELETE' })
export const moveDocument = (id: number, folderId: number | null) =>
  request<DocumentFull>(`/api/documents/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ folder_id: folderId }),
  })
