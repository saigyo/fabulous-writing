import type {
  Category,
  CheckStatus,
  Domain,
  Finding,
  Language,
  LanguageInfo,
  LimitsPayload,
  PolicyPayload,
  Profile,
  ProviderInfo,
  RoutingTable,
  RuleError,
  RuleInfo,
  Scorecard,
  Tier,
  Term,
  UsagePayload,
} from '../types'
// store.ts only imports this module's *types* (`import type`), which are
// erased at build time — so this value import does not close a runtime
// cycle. That is a different relationship from session.ts (below), which
// imports this module's values and therefore cannot be imported back.
import { useStore } from '../state/store'
import { createParser, type EventSourceMessage } from 'eventsource-parser'

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export class HttpError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// headers is narrowed from RequestInit's HeadersInit (Record<string,string>
// | string[][] | Headers) to a plain object: a Headers instance spreads to
// {} (its properties are not own-enumerable) and a string[][] spreads to
// {0: [...], 1: [...]} — both silently wrong, and a cast to
// Record<string, string> at the spread site would compile either one
// straight through. No caller passes the other two forms today, so nothing
// is lost by disallowing them here; a real need would surface as a type
// error instead of a runtime bug.
interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>
}

// keepSessionOn401 lives only on this internal type, never on the exported
// RequestOptions — so it is reachable exclusively through requestWithOptions
// below. Its callers, kept complete here since this flag is
// security-relevant and must not go stale: postLogin, postRefresh,
// postResetRequest, postResetConfirm. Anything importing the public
// request() gets a type that has no such property at all: passing
// { keepSessionOn401: true } as an object literal to request() is a compile
// error, not a convention someone has to remember. This is a property of
// the *call*, not a URL match, so a future endpoint that also must not
// clear state opts in by calling requestWithOptions explicitly rather than
// being special-cased by path. It must never influence header construction
// (in particular, it must never suppress the Authorization header) — it
// has exactly the one effect: skip the clear-auth branch on a 401.
interface RequestOptionsInternal extends RequestOptions {
  keepSessionOn401?: boolean
}

// A non-OK response is not guaranteed to have a JSON body, let alone one
// shaped like `{ detail: { code, message } }` — so a parse failure here
// must not replace the real HTTP status with a parse error; it just leaves
// `code` undefined and the caller still gets `status`.
async function extractErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await response.text())
    const detail = (body as { detail?: unknown } | null)?.detail
    if (
      detail !== null &&
      typeof detail === 'object' &&
      typeof (detail as { code?: unknown }).code === 'string'
    ) {
      return (detail as { code: string }).code
    }
  } catch {
    // Not JSON, or not the expected shape — status alone still throws below.
  }
  return undefined
}

// Shared by request() below and, from Task 5, the SSE reader (which passes
// the token it opened its stream with) — so both inherit this same scoping
// rather than the stream growing a second copy. The app fires several
// requests in parallel on mount and the check stream outlives them, so a
// 401 can arrive long after the request that earned it: once the first 401
// has shown the gate and the user has signed back in, a straggler from the
// dead token must not call the handler again and discard the *fresh*
// token. Clearing only when the store's current token still matches the
// one the rejected request was sent with prevents that.
export function handleUnauthorized(tokenUsed: string | null): void {
  // A visitor who never signed in has tokenUsed === null and the store's
  // token is also null, so the equality check below would otherwise pass
  // and expire a session that never existed — surfacing Task 6's "your
  // session has ended" notice on an anonymous visitor's first paint once
  // Task 10's enforcement lands and every mount-time request starts 401ing.
  if (!tokenUsed) return
  if (useStore.getState().token !== tokenUsed) return
  getUnauthorizedHandler()?.()
}

// Shared by requestWithOptions below and, from Task 5, the SSE reader — so
// the `Bearer ${token}` string is assembled in exactly one place rather than
// growing a second copy where the stream builds its own headers.
function authHeader(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function requestWithOptions<T>(path: string, init?: RequestOptionsInternal): Promise<T> {
  const { keepSessionOn401, headers: callerHeaders, ...rest } = init ?? {}
  // Read at fetch time, not captured earlier: an in-flight request that
  // turns stale is safe only because it still carries the *outgoing*
  // session's own token, so a recovered document lands under the user who
  // was leaving rather than the one arriving. Reading any earlier (e.g. at
  // api-function entry) risks a request built before a refresh picking up
  // a token that isn't its caller's anymore.
  const token = useStore.getState().token
  // Deliberately unconditional on keepSessionOn401: that flag has exactly
  // one effect (skipping the clear-auth branch below) and must never touch
  // header construction, or the first exempt endpoint that actually
  // carries a token would silently lose its Authorization header.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...callerHeaders,
    ...authHeader(token),
  }

  const response = await fetch(`${BASE}${path}`, { ...rest, headers })

  if (!response.ok) {
    if (response.status === 401 && !keepSessionOn401) {
      handleUnauthorized(token)
    }
    throw new HttpError(
      response.status,
      `${init?.method ?? 'GET'} ${path} failed: ${response.status}`,
      await extractErrorCode(response),
    )
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  return requestWithOptions<T>(path, init)
}

// Mirrors backend/app/main.py's /api/health handler: auth_features is
// ALWAYS present on the wire, in both modes (pinned by
// test_health_auth_features_false_in_local_mode) — local mode returns it
// with both flags false, not omitted. password_reset/invites are each true
// only when the deployment's auth backend actually supports them (Supabase
// mode). The field stays optional here for wire-tolerance only (an older
// backend or a network layer stripping it); the gate's mount effect
// (LoginGate.tsx) already treats a missing value the same as "neither flag
// is on" via its truthy read.
export interface AuthFeatures {
  password_reset: boolean
  invites: boolean
}

export interface HealthResponse {
  status: string
  name: string
  version: string
  auth_features?: AuthFeatures
}

// Public and unauthenticated by design (backend/app/api/health.py) — this is
// the one /api/* call the gate issues before any session exists.
export const getHealth = () => request<HealthResponse>('/api/health')

/** Mirrors the backend's own response (`backend/app/api/auth.py`). M4 added
 * `policy` (LLM tier/provider/model gating, spec §8); M5 delivers the
 * promised extension — `usage`/`limits` (quota/size/concurrency) and
 * `allow_additional_admins` — onto this same type rather than a second one. */
export interface MeResponse {
  id: number
  email: string
  display_name: string | null
  tier: string
  is_admin: boolean
  policy: PolicyPayload
  usage: UsagePayload
  limits: LimitsPayload
  allow_additional_admins: boolean
}

export interface LoginResponse {
  token: string
  // Both null in local mode (backend/app/api/auth.py): session.ts treats
  // their absence as "this session never refreshes".
  refresh_token: string | null
  expires_at: number | null
  user: MeResponse
}

// keepSessionOn401: a wrong password is a 401 here, and must reach the
// caller as an HttpError rather than clearing auth state — there is no
// session to clear yet, and doing so would just retrigger the login UI in
// a loop. postPasswordChange (Task 8) is deliberately NOT exempt: its 401
// can only mean the bearer token was rejected (Task 8 removes the
// ambiguity with get_current_user at the source), so it must flow through
// expireSession() like any other endpoint.
export const postLogin = (email: string, password: string) =>
  requestWithOptions<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    keepSessionOn401: true,
  })

// Without a timeout, a refresh request that never settles pins
// session.ts's refreshInFlight for the current generation forever — the
// retry branch in doRefresh's catch only runs on rejection, so a hung
// request never arms a retry and an otherwise-refreshable session dies
// silently on the next 401. AbortSignal.timeout(REFRESH_TIMEOUT_MS) below
// bounds the wait; the resulting abort rejects with a DOMException/
// TypeError, not an HttpError, which doRefresh's catch already routes
// through its non-401 retry path (see the comment there).
const REFRESH_TIMEOUT_MS = 15_000

// keepSessionOn401: a dead refresh token is a 401 here, and must reach the
// caller as an HttpError rather than clearing auth state directly — the
// refresh engine (session.ts) is the one that decides to expireSession()
// on that error, exactly like a request-level 401 would.
export const postRefresh = (refreshToken: string) =>
  requestWithOptions<LoginResponse>('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
    keepSessionOn401: true,
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  })

// Deliberately uses the public request(): a 401 here can only mean the
// bearer token was already dead, and logout()'s own teardown must proceed
// either way — see session.ts.
export const postLogout = () => request<void>('/api/auth/logout', { method: 'POST' })

// keepSessionOn401: requested while anonymous (ForgotPasswordForm), so there
// is no session to clear — matches postLogin's reasoning above. Always
// resolves 204 regardless of whether the address has an account
// (enumeration-neutral, backend/app/api/auth.py).
export const postResetRequest = (email: string) =>
  requestWithOptions<void>('/api/auth/reset-request', {
    method: 'POST',
    body: JSON.stringify({ email }),
    keepSessionOn401: true,
  })

// keepSessionOn401: submitted from ResetPasswordForm while anonymous (a
// recovery/invite link, not a bearer token) — a 401 must reach the caller as
// an HttpError, not clear auth state that does not exist yet.
export const postResetConfirm = (tokenHash: string, type: 'recovery' | 'invite', newPassword: string) =>
  requestWithOptions<void>('/api/auth/reset-confirm', {
    method: 'POST',
    body: JSON.stringify({ token_hash: tokenHash, type, new_password: newPassword }),
    keepSessionOn401: true,
  })

export const getMe = () => request<MeResponse>('/api/auth/me')

// The server's SELF_MIN_PASSWORD_LENGTH (backend/app/core/auth.py) is 8, and
// no endpoint exposes it, so Task 8's password form hardcodes the same value
// here to pre-validate before ever sending a request.
export const MIN_PASSWORD_LENGTH = 8

// Deliberately uses the public request(), not requestWithOptions: a 401 here
// can only mean the bearer token was rejected (Task 8's backend change gives
// "current password wrong" its own 422 + code instead), so this must flow
// through expireSession() like any other endpoint — see postLogin's comment
// for the contrasting case.
export const postPasswordChange = (current: string, next: string) =>
  request<void>('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ current, new: next }),
  })

/** Mirrors backend/app/services/users.py User — no password material, ever
 * (token_epoch is excluded server-side). */
export interface AdminUser {
  id: number
  email: string
  display_name: string | null
  tier: string
  is_admin: boolean
  is_active: boolean
  created_at: string
  external_id: string | null
  password_changed_at: string | null
}

export interface AdminUserCreate {
  email: string
  // Omitted in supabase mode: the admin invites the user through Supabase
  // instead of setting a credential directly (backend/app/api/admin.py).
  password?: string
  display_name?: string
  tier: string
  is_admin: boolean
}

/** PATCH semantics (backend/app/api/admin.py UserPatch): only submitted
 * fields change; display_name: null explicitly clears the name; password
 * present = reset. Callers send exactly the fields they mean. */
export interface AdminUserPatch {
  display_name?: string | null
  tier?: string
  is_admin?: boolean
  is_active?: boolean
  password?: string
}

// The server's ADMIN_SET_MIN_PASSWORD_LENGTH (backend/app/core/auth.py) is
// 12 and no endpoint exposes it — hardcoded here like MIN_PASSWORD_LENGTH
// above, so admin forms pre-validate before sending.
export const ADMIN_MIN_PASSWORD_LENGTH = 12

export const getAdminUsers = () => request<AdminUser[]>('/api/admin/users')

export const getAdminTiers = () => request<string[]>('/api/admin/tiers')

// `invited` is an event of this call, not durable user state (it never
// appears on AdminUser / GET admin/users) -- see AdminUserCreated in
// backend/app/api/admin.py.
export const postAdminUser = (body: AdminUserCreate) =>
  request<AdminUser & { invited?: boolean }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const patchAdminUser = (id: number, patch: AdminUserPatch) =>
  request<AdminUser>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

// Injected by auth/session.ts (avoids a module cycle): session.ts imports
// this module for postLogin/getMe, so this module must not import
// session.ts back to call expireSession() directly. getUnauthorizedHandler
// is read by handleUnauthorized() above, invoked from request()'s 401
// branch.
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}
export function getUnauthorizedHandler(): (() => void) | null {
  return onUnauthorized
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
  llm_tier?: Tier | null
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

// EventSource cannot send an Authorization header, so the stream is read
// over fetch()+AbortController instead. Framing (chunk splitting, \r\n vs
// \n, multi-line data:, comments) comes from eventsource-parser — see spec
// §7.3 for why a fuller SSE client was rejected: both alternatives
// considered reconnect automatically, which is wrong for a one-shot check
// stream, and one of them treats only HTTP 204 as terminal, so a 401 from
// an expired token would loop invisibly to our 401 handler.
function dispatchCheckEvent(event: EventSourceMessage, handlers: CheckEventHandlers): void {
  switch (event.event) {
    case 'checker_result': {
      const data = JSON.parse(event.data)
      handlers.onResult(data.checker, data.findings)
      return
    }
    case 'llm_progress': {
      const data = JSON.parse(event.data)
      handlers.onProgress?.(data.tokens)
      return
    }
    case 'scorecard': {
      handlers.onScorecard?.(JSON.parse(event.data))
      return
    }
    case 'checker_error': {
      const data = JSON.parse(event.data)
      handlers.onError(data.checker, data.error)
      return
    }
    default:
      return
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

async function readEvents(
  checkId: string,
  handlers: CheckEventHandlers,
  signal: AbortSignal,
): Promise<void> {
  // Settle exactly once: `done` calls onDone(), and so does an ended or
  // failed stream, and so does the non-OK-response path below. Without this
  // flag a `done` frame immediately followed by natural end-of-stream would
  // fire onDone() twice.
  let settled = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const settle = (): void => {
    if (settled) return
    settled = true
    handlers.onDone()
  }

  const parser = createParser({
    onEvent(event) {
      // A single feed() call can synchronously dispatch every event framed
      // in one chunk. If a handler calls the unsubscribe function returned
      // by subscribeCheck (aborting `signal`) partway through that chunk,
      // later events in the same chunk must not still reach a handler the
      // caller just tore down. `settled` covers the mirror case: a `done`
      // frame earlier in the same chunk sets it but does not abort
      // `signal`, so a later frame in that chunk would otherwise still
      // reach its handler after the stream has already been told it's over.
      if (signal.aborted || settled) return
      if (event.event === 'done') {
        // "done" closes the stream: stop reading and settle, matching
        // EventSource's own close-on-done behaviour above. cancel() rejects
        // if the stream is already errored (e.g. a dropped connection
        // racing this same frame) — nothing awaits it, so that rejection
        // must be caught here rather than becoming unhandled.
        void reader?.cancel().catch(() => {})
        settle()
        return
      }
      dispatchCheckEvent(event, handlers)
    },
  })

  // Read at fetch time, same as request() above — not captured earlier,
  // so a delayed 401 on this stream is scoped to the token it was opened
  // with, not whatever token is current when the 401 arrives.
  const token = useStore.getState().token
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...authHeader(token),
  }

  try {
    const response = await fetch(`${BASE}/api/checks/${checkId}/events`, { headers, signal })

    // fetch() resolves happily for a 401 — without this check the reader
    // would parse the JSON error body as an event stream, emit nothing,
    // reach end-of-stream and call onDone(), leaving the app believing the
    // session is still valid. Route it through the same handler request()
    // uses so a 401 reaches expireSession().
    if (!response.ok) {
      if (response.status === 401) handleUnauthorized(token)
      settle()
      return
    }

    reader = response.body?.getReader()
    if (!reader) {
      settle()
      return
    }

    // { stream: true } and the trailing flush matter: a ReadableStream
    // splits on byte boundaries, not code points, so decoding each chunk
    // independently would replace a split multi-byte character with U+FFFD
    // before the parser ever sees it. Findings and messages in this app
    // carry German, French, Japanese and Chinese text, so that corruption
    // would be routine.
    const decoder = new TextDecoder()
    while (!settled) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
    }
    // Deliberately unpinnable by test: a correctly-terminated SSE stream
    // never leaves a complete pending code point in the decoder, so this
    // flush can only ever produce the tail of an already-truncated
    // sequence — bytes that could never have completed a dispatchable
    // frame (which requires a trailing blank line) regardless of whether
    // this call exists. It stays because the brief mandates it as the
    // general defence against a decoder holding a still-buffered partial
    // multi-byte character across the last chunk, not because any test
    // here can observe its absence — see task-5-report.md.
    parser.feed(decoder.decode())
    settle()
  } catch (error) {
    // AbortError is the normal cancellation path (cancelCheck() already
    // resets the store itself), not a failure — it must not surface as an
    // error and onDone() must not fire. Every other error (a dropped
    // connection, DNS failure, ...) is indistinguishable from completion
    // today, and this milestone deliberately keeps that.
    if (isAbortError(error)) return
    settle()
  }
}

export function subscribeCheck(
  checkId: string,
  handlers: CheckEventHandlers,
): () => void {
  const controller = new AbortController()
  // readEvents() only rejects if handlers.onDone() itself throws from
  // inside its own catch-block settle() — nothing here awaits that
  // promise, so an uncaught rejection would otherwise surface as an
  // unhandled rejection with no connection back to this call site.
  void readEvents(checkId, handlers, controller.signal).catch(() => {})
  // AbortController.abort() is idempotent and never throws, so the returned
  // function needs no guard of its own even though cancelCheck() and every
  // new runCheck() call it unconditionally.
  return () => controller.abort()
}

export interface SuggestionRequest {
  text: string
  span: { start: number; end: number }
  message: string
  language: Language
  scope?: 'span' | 'sentence'
  rule_id?: string | null
  llm_tier?: Tier | null
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
  skipped?: string | null
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

export type ProfilePayload = Omit<Profile, 'id' | 'is_standard' | 'is_global'>

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

export interface FolderDefaults {
  default_language: Language | null
  default_profile_id: number | null
  default_domain_ids: number[] | null
  default_llm_provider: string | null
  default_llm_model: string | null
  default_llm_tier: Tier | null
  default_llm_auto: boolean | null
}

export interface Folder extends FolderDefaults {
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

export const putFolderDefaults = (id: number, defaults: FolderDefaults) =>
  request<Folder>(`/api/folders/${id}/defaults`, {
    method: 'PUT',
    body: JSON.stringify(defaults),
  })

export const moveDocument = (id: number, folderId: number | null) =>
  request<DocumentFull>(`/api/documents/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ folder_id: folderId }),
  })
