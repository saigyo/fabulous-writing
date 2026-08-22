import { create } from 'zustand'
import { readToken, readTokenExpiresAt, readRefreshToken } from './prefsStorage'
import type {
  AuthFeatures,
  DocumentSummary,
  Folder,
  HeldBackSuggestion,
  MeResponse,
  NameSource,
} from '../api/client'
import type { TrackedFinding } from '../editor/findings'
import { mapEquivalentIds } from '../findings/equivalence'
import type { SourceGroup } from '../findings/source'
import type { Locale } from '../i18n/messages'
import { FALLBACK_LANGUAGES } from '../languages'
import { applyProfileToHeader } from '../profiles/profile'
import type { Scorecard } from '../scoring/score'
import type {
  Domain,
  EffectiveLlm,
  Language,
  LanguageInfo,
  Profile,
  ProviderInfo,
  RoutingTable,
  Severity,
  Tier,
} from '../types'

export type CheckPhase = 'idle' | 'fast' | 'llm'
export type ActiveView =
  | 'editor'
  | 'rules'
  | 'terminology'
  | 'profiles'
  | 'admin'
  | 'activity'

// 'self' = the signed-in user's own activity; 'all' = every user
// (admin-only, aggregated); a number = one drilled-into user's id.
export type ActivitySubject = 'self' | 'all' | number

export interface DocMeta {
  id: number
  name: string
  nameSource: NameSource
  revision: number
}

// Data fields only; actions live in AppStateActions below. The split lets
// INITIAL_DATA (further down) be typed against AppStateData alone, so
// resetSessionState() can restore every data field without enumerating them
// and without also having to know about the actions.
interface AppStateData {
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
  // The most recent check's effective_llm report (degradation/skip info);
  // transient like the rest of the check-phase fields above — never
  // persisted, reset on every new runCheck() and on session turnover.
  llmEffective: EffectiveLlm | null
  providers: ProviderInfo[]
  routing: RoutingTable | null
  domains: Domain[]
  languages: LanguageInfo[]
  profiles: Profile[]
  profileId: number | null
  lastProfileByLanguage: Record<string, number>
  // Collapsed rules-view sections (category names and `pack:<name>` keys).
  rulesCollapsed: string[]
  // Last LLM scorecard for the current document (kept until the next one
  // arrives); stale once the text was edited after it arrived.
  scorecard: Scorecard | null
  scorecardStale: boolean
  // Live word count of the editor document (feeds the quality score).
  docWords: number
  // Live character count of the editor document (feeds the char-count
  // display and its two threshold notes); transient like docWords — never
  // persisted, reset on every document load.
  docChars: number
  // The embed's currently connected host field (B43 C1) — null while no
  // field is connected. A minimal extension beyond hostDoc.ts's own
  // connected()/capabilities() (not reactive, and not observable outside
  // the module): EmbedApp needs a reactive signal both to show the
  // connected page's URL and to detect a fresh fieldConnected() (to trigger
  // cancelCheck() + an immediate check) — every call to setConnectedField()
  // on a (re)connect writes a brand-new object, so a React effect keyed on
  // this field's identity fires on every connect, not just the first one.
  // Never persisted (transient like docWords/docChars) and unused outside
  // the embed entry — the main app's editorPort.ts never touches it.
  connectedField: { fieldId: string; url: string | null } | null
  extraSuggestions: Record<string, string[]>
  suggestPendingId: string | null
  suggestErrors: Record<string, string>
  suggestHeldBack: Record<string, HeldBackSuggestion[]>
  suggestAdvice: Record<string, string[]>
  rewrites: Record<string, Rewrite>
  rewritePendingId: string | null
  rewriteErrors: Record<string, string>
  rewriteHeldBack: Record<string, HeldBackRewrite>
  rewriteAdvice: Record<string, string[]>
  documents: DocumentSummary[]
  docMeta: DocMeta | null
  // Persisted so a reload reopens the same document; docMeta is runtime-only.
  currentDocId: number | null
  docSidebarCollapsed: boolean
  docListError: boolean
  folders: Folder[]
  // Collapsed folder groups in the document sidebar (folder ids).
  docFoldersCollapsed: number[]

  // Which subject the activity view is showing (B40, #124).
  activitySubject: ActivitySubject
  // The drilled-into user's email/display_name, for the view heading; null
  // for 'self'/'all' and whenever setActivitySubject() is called without a
  // label.
  activitySubjectLabel: string | null

  // Auth. token, refreshToken and tokenExpiresAt are the three of these
  // eight persisted — each in its own localStorage key (prefsStorage.ts),
  // read once at store creation; user is re-fetched from /api/auth/me on
  // every load rather than cached, so it can never go stale (stale
  // tier/is_admin flags). refreshToken/tokenExpiresAt are both null in
  // local mode (no backing Supabase session to refresh) — see session.ts's
  // scheduleRefresh().
  token: string | null
  refreshToken: string | null
  tokenExpiresAt: number | null
  user: MeResponse | null
  authStatus: 'unknown' | 'anonymous' | 'authenticated'
  // Set only by expireSession(), cleared only by login(): see session.ts.
  sessionExpired: boolean
  // Set when restoreSession() fails to reach the server (not a 401):
  // authStatus stays 'unknown' rather than logging the user out. Cleared by
  // every setAuth call, since reaching a resolved auth state at all means
  // the server answered.
  restoreFailed: boolean
  // Bumped only by login() committing (see session.ts) — including the
  // silent same-user re-login the password-change flow performs
  // (auth/AccountMenu.tsx). sessionGeneration() itself is a plain module
  // variable, so bumping it does not trigger a React re-render; this field
  // is the reactive counterpart mount effects can depend on to re-run after
  // such a re-login (Copilot round-9 U1/U2) — e.g. Header's and
  // TerminologyView's domains fetches. Deliberately NOT bumped by
  // logout()/expireSession(): those already unmount the effects that would
  // depend on it (LoginGate stops rendering children), and re-running them
  // on the way to a null user would only fire fetches no one is looking at.
  authGeneration: number
  // Set once by LoginGate's unconditional, empty-deps mount effect (Task 7)
  // from GET /api/health's auth_features — never re-fetched afterwards. Not
  // persisted: it describes the deployment, not the session, so there is no
  // storage key for it. It MUST survive resetSessionState() (see the tenth
  // exclusion member below) — the gate that would re-fetch it is mounted
  // for the whole app lifetime and only runs that effect once per page
  // load, so a reset on logout would silently and permanently hide
  // "Forgot password?" for the rest of the tab's life.
  authFeatures: AuthFeatures | null
  // Set from the same one-per-page-load health fetch as authFeatures and
  // for the same reason not persisted and reset-surviving: it describes
  // the deployment, not the session (B35). null only until that fetch
  // resolves; 'dev' or the release tag afterwards.
  appVersion: string | null
}

interface AppStateActions {
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
  toggleRuleSection: (key: string) => void
  setRulesCollapsed: (keys: string[]) => void
  setScorecard: (scorecard: Scorecard) => void
  clearScorecard: () => void
  markScorecardStale: () => void
  setDocWords: (docWords: number) => void
  setDocChars: (docChars: number) => void
  setConnectedField: (field: { fieldId: string; url: string | null } | null) => void
  setSuggestPending: (findingId: string | null) => void
  setExtraSuggestions: (findingId: string, suggestions: string[]) => void
  setSuggestError: (findingId: string, error: string | null) => void
  setSuggestHeldBack: (findingId: string, candidates: HeldBackSuggestion[] | null) => void
  setSuggestAdvice: (findingId: string, advice: string[] | null) => void
  setRewritePending: (findingId: string | null) => void
  setRewrite: (findingId: string, rewrite: Rewrite | null) => void
  setRewriteError: (findingId: string, error: string | null) => void
  setRewriteHeldBack: (findingId: string, heldBack: HeldBackRewrite | null) => void
  setRewriteAdvice: (findingId: string, advice: string[] | null) => void
  setDocuments: (documents: DocumentSummary[]) => void
  setDocMeta: (docMeta: DocMeta | null) => void
  patchDocMeta: (patch: Partial<DocMeta>) => void
  patchDocumentSummary: (id: number, patch: Partial<DocumentSummary>) => void
  toggleDocSidebar: () => void
  setDocListError: (docListError: boolean) => void
  setFolders: (folders: Folder[]) => void
  toggleFolderCollapsed: (id: number) => void
  // Overloaded so a numeric subject can never be set without its label at
  // the type level — a bare setActivitySubject(5) would render an empty
  // <h2> in ActivityView (the heading has no id fallback; see
  // activity/ActivityView.tsx). 'self'/'all' take no label (nulling it —
  // see activitySubjectLabel's field comment above); the implementation
  // below stays permissive (label optional) since one function body must
  // satisfy both call shapes.
  setActivitySubject(subject: 'self' | 'all'): void
  setActivitySubject(subject: number, label: string): void
  // authStatus is derived: 'authenticated' when both token and user are
  // present, 'anonymous' otherwise. sessionExpired is deliberately left
  // untouched here — only expireSession() sets it and only login() clears
  // it (see session.ts), so a re-login after an expiry does not race this
  // setter.
  setAuth: (token: string | null, user: MeResponse | null) => void
  // Writes the store fields only — persistence (writeToken/writeRefreshToken/
  // writeTokenExpiresAt) stays the caller's job in session.ts, exactly like
  // setAuth() above leaves writeToken/clearToken to its callers.
  setSessionTokens: (
    token: string,
    refreshToken: string | null,
    expiresAt: number | null,
  ) => void
  // Called only from login() on a commit — see authGeneration's own comment.
  bumpAuthGeneration: () => void
  // Called only from LoginGate's mount-effect health fetch — see
  // authFeatures's own comment above.
  setAuthFeatures: (authFeatures: AuthFeatures) => void
  // Called only from LoginGate's mount-effect health fetch — see
  // appVersion's own comment above.
  setAppVersion: (appVersion: string) => void
}

type AppState = AppStateData & AppStateActions

export interface Rewrite {
  original: string
  options: string[]
}

export interface HeldBackRewrite {
  original: string
  candidates: HeldBackSuggestion[]
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

// Every AppStateData field except the ten auth/deployment fields (token,
// refreshToken, tokenExpiresAt, user, authStatus, sessionExpired,
// restoreFailed, authGeneration, authFeatures, appVersion) — those are
// managed explicitly by resetSessionState()'s callers via setAuth()/
// setSessionTokens(), never through this object. Since B1 (#34), callers
// null the auth fields BEFORE the reset (the ordering invariant in
// session.ts: the prefs write subscriber must see user === null while pref
// fields are bulk-reset) and set the new session's values after it.
// authGeneration specifically must survive a reset untouched: it is bumped
// only by login()'s own commit, which runs after the reset on a cross-user
// login — keeping it out of this object makes that explicit instead of
// coincidental. authFeatures (Task 7) and appVersion (B35) must survive a
// reset for a different reason — see their own comments on AppStateData
// above.
// Exported (rather than enumerated again inside resetSessionState()) so a
// field added here is reset automatically instead of silently leaking from
// one account's session into the next.
export const INITIAL_DATA: Omit<
  AppStateData,
  | 'token'
  | 'refreshToken'
  | 'tokenExpiresAt'
  | 'user'
  | 'authStatus'
  | 'sessionExpired'
  | 'restoreFailed'
  | 'authGeneration'
  | 'authFeatures'
  | 'appVersion'
> = {
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
  llmEffective: null,
  providers: [],
  routing: null,
  domains: [],
  languages: FALLBACK_LANGUAGES,
  profiles: [],
  profileId: null,
  lastProfileByLanguage: {},
  rulesCollapsed: [],
  scorecard: null,
  scorecardStale: false,
  docWords: 0,
  docChars: 0,
  connectedField: null,
  extraSuggestions: {},
  suggestPendingId: null,
  suggestErrors: {},
  suggestHeldBack: {},
  suggestAdvice: {},
  rewrites: {},
  rewritePendingId: null,
  rewriteErrors: {},
  rewriteHeldBack: {},
  rewriteAdvice: {},
  documents: [],
  docMeta: null,
  currentDocId: null,
  docSidebarCollapsed: false,
  docListError: false,
  folders: [],
  docFoldersCollapsed: [],
  activitySubject: 'self',
  activitySubjectLabel: null,
}

/** Resets the whole data half of the store — not just the formerly
 * persisted slice. Most of the store (tracked findings, documents,
 * folders, scorecard, ...) is invisible to storage; left alone it would
 * survive a gate swap and render the previous account's data. Called on
 * logout, on session expiry, and on a login that changes the user — see
 * session.ts for which. Storage is untouched: per-user preference blobs
 * survive every session transition by design (B1, #34), and the write
 * subscriber (prefsPersistence.ts) ignores this reset because every
 * caller nulls the user first — the ordering invariant documented in
 * session.ts. */
export function resetSessionState(): void {
  useStore.setState(INITIAL_DATA) // shallow merge: the actions survive
}

export const useStore = create<AppState>()((set) => ({
  ...INITIAL_DATA,
  // Initialised from storage, each in its own key (prefsStorage.ts) rather
  // than any per-user preference blob: the token must be readable before we
  // know who the user is, and refreshToken/tokenExpiresAt travel with it so
  // scheduleRefresh() (session.ts) can arm on a reload without waiting on
  // /api/auth/me.
  token: readToken(),
  refreshToken: readRefreshToken(),
  tokenExpiresAt: readTokenExpiresAt(),
  user: null,
  authStatus: 'unknown',
  sessionExpired: false,
  restoreFailed: false,
  authGeneration: 0,
  authFeatures: null,
  appVersion: null,

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
        suggestHeldBack: migrateByFinding(state.suggestHeldBack, idMap),
        suggestAdvice: migrateByFinding(state.suggestAdvice, idMap),
        rewrites: migrateByFinding(state.rewrites, idMap),
        rewriteErrors: migrateByFinding(state.rewriteErrors, idMap),
        rewriteHeldBack: migrateByFinding(state.rewriteHeldBack, idMap),
        rewriteAdvice: migrateByFinding(state.rewriteAdvice, idMap),
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
  toggleRuleSection: (key) =>
    set((state) => ({
      rulesCollapsed: state.rulesCollapsed.includes(key)
        ? state.rulesCollapsed.filter((k) => k !== key)
        : [...state.rulesCollapsed, key],
    })),
  setRulesCollapsed: (rulesCollapsed) => set({ rulesCollapsed }),
  setScorecard: (scorecard) => set({ scorecard, scorecardStale: false }),
  clearScorecard: () => set({ scorecard: null, scorecardStale: false }),
  markScorecardStale: () =>
    set((state) => (state.scorecard ? { scorecardStale: true } : {})),
  setDocWords: (docWords) => set({ docWords }),
  setDocChars: (docChars) => set({ docChars }),
  setConnectedField: (connectedField) => set({ connectedField }),
  setSuggestPending: (suggestPendingId) => set({ suggestPendingId }),
  setExtraSuggestions: (findingId, suggestions) =>
    set((state) => ({
      extraSuggestions: { ...state.extraSuggestions, [findingId]: suggestions },
    })),
  setSuggestError: (findingId, error) =>
    set((state) => ({
      suggestErrors: withEntry(state.suggestErrors, findingId, error),
    })),
  setSuggestHeldBack: (findingId, candidates) =>
    set((state) => ({
      suggestHeldBack: withEntry(state.suggestHeldBack, findingId, candidates),
    })),
  setSuggestAdvice: (findingId, advice) =>
    set((state) => ({
      suggestAdvice: withEntry(state.suggestAdvice, findingId, advice),
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
  setRewriteHeldBack: (findingId, heldBack) =>
    set((state) => ({
      rewriteHeldBack: withEntry(state.rewriteHeldBack, findingId, heldBack),
    })),
  setRewriteAdvice: (findingId, advice) =>
    set((state) => ({
      rewriteAdvice: withEntry(state.rewriteAdvice, findingId, advice),
    })),
  setDocuments: (documents) => set({ documents }),
  setDocMeta: (docMeta) =>
    set({ docMeta, currentDocId: docMeta ? docMeta.id : null }),
  patchDocMeta: (patch) =>
    set((state) =>
      state.docMeta ? { docMeta: { ...state.docMeta, ...patch } } : {},
    ),
  // Merge server-returned fields into one summary and re-sort. Entries
  // only move when the server bumped edited_at — the client never fakes
  // recency locally.
  patchDocumentSummary: (id, patch) =>
    set((state) => {
      if (!state.documents.some((d) => d.id === id)) return {}
      const documents = state.documents
        .map((d) => (d.id === id ? { ...d, ...patch } : d))
        .sort(
          (a, b) =>
            b.edited_at.localeCompare(a.edited_at) || b.id - a.id,
        )
      return { documents }
    }),
  toggleDocSidebar: () =>
    set((state) => ({ docSidebarCollapsed: !state.docSidebarCollapsed })),
  setDocListError: (docListError) => set({ docListError }),
  setFolders: (folders) => set({ folders }),
  toggleFolderCollapsed: (id) =>
    set((state) => ({
      docFoldersCollapsed: state.docFoldersCollapsed.includes(id)
        ? state.docFoldersCollapsed.filter((f) => f !== id)
        : [...state.docFoldersCollapsed, id],
    })),
  setActivitySubject: (activitySubject: ActivitySubject, label: string | null = null) =>
    set({ activitySubject, activitySubjectLabel: label }),
  setAuth: (token, user) =>
    set({
      token,
      user,
      authStatus: token && user ? 'authenticated' : 'anonymous',
      restoreFailed: false,
    }),
  setSessionTokens: (token, refreshToken, tokenExpiresAt) =>
    set({ token, refreshToken, tokenExpiresAt }),
  bumpAuthGeneration: () =>
    set((state) => ({ authGeneration: state.authGeneration + 1 })),
  setAuthFeatures: (authFeatures) => set({ authFeatures }),
  setAppVersion: (appVersion) => set({ appVersion }),
}))
