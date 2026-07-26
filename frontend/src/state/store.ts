import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
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

  // Auth. token is the only one of these five persisted (see partialize
  // below); user is re-fetched from /api/auth/me on every load rather than
  // cached, so it can never go stale (stale tier/is_admin flags).
  token: string | null
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
  // authStatus is derived: 'authenticated' when both token and user are
  // present, 'anonymous' otherwise. sessionExpired is deliberately left
  // untouched here — only expireSession() sets it and only login() clears
  // it (see session.ts), so a re-login after an expiry does not race this
  // setter.
  setAuth: (token: string | null, user: MeResponse | null) => void
  // Called only from login() on a commit — see authGeneration's own comment.
  bumpAuthGeneration: () => void
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

// Persist options shared with tests: zustand v5 gives tests no handle on the
// inline options, so the SAME object is exported (never a copy — a copy can
// silently drift from what the store actually runs).
//
// token was added to the allowlist without a version bump: an older blob
// simply lacks the key, and token: null is the correct initial value, so
// there is nothing for a migrate branch to do. user is deliberately never
// persisted — see the field's own comment.
export const persistConfig = {
  name: 'fabulous-writing-settings',
  version: 2,
  // v0 predates tiers: those users had explicitly chosen provider/model,
  // so they stay pinned rather than silently switching models.
  // v1 -> v2: header settings moved into per-document storage; stale keys
  // in old blobs are harmless extras and rehydrate transiently (the
  // legacy-document migration in documents.ts still reads them once).
  migrate: (persisted: unknown, version: number): unknown =>
    version === 0
      ? { ...(persisted as object), tier: null }
      : (persisted as object),
  partialize: (state: AppState) => ({
    uiLocale: state.uiLocale,
    lastProfileByLanguage: state.lastProfileByLanguage,
    rulesCollapsed: state.rulesCollapsed,
    currentDocId: state.currentDocId,
    docSidebarCollapsed: state.docSidebarCollapsed,
    docFoldersCollapsed: state.docFoldersCollapsed,
    token: state.token,
  }),
}

// Every AppStateData field except the six auth fields (token, user,
// authStatus, sessionExpired, restoreFailed, authGeneration) — those are set
// explicitly by every resetSessionState() caller right afterwards (see
// session.ts), never through this object. authGeneration specifically must
// survive a reset untouched: it is bumped only by login()'s own commit, and
// resetSessionState() runs before that bump on a cross-user login, so
// resetting it here would just be overwritten a line later anyway — keeping
// it out of this object makes that explicit instead of coincidental.
// Exported (rather than enumerated again inside resetSessionState()) so a
// field added here is reset automatically instead of silently leaking from
// one account's session into the next.
export const INITIAL_DATA: Omit<
  AppStateData,
  'token' | 'user' | 'authStatus' | 'sessionExpired' | 'restoreFailed' | 'authGeneration'
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
}

/** Resets the whole data half of the store — not just the persisted blob.
 * Most of the store (tracked findings, documents, folders, scorecard, ...)
 * is never persisted and so is invisible to `persist.clearStorage()` alone;
 * left alone it would survive a gate swap and render the previous account's
 * data until async initialisation replaces it (or forever, if that
 * initialisation fails). Called on logout, on session expiry, and on a
 * login that changes the user — see session.ts for which. */
export function resetSessionState(): void {
  useStore.persist.clearStorage()
  // Order matters, but not the way it looks: clearStorage() removes the
  // localStorage key, then setState() immediately triggers the persist
  // middleware to write it straight back — with token still holding
  // whatever it was before this call, since every caller (login/logout/
  // expireSession) sets auth via setAuth() right after this returns. So the
  // key ends up *recreated with INITIAL_DATA's values plus the old token*,
  // not removed, for the instant between this line and that setAuth() call.
  // All three callers still end up correct because they all call setAuth()
  // immediately afterwards, but do not reorder this to setState() then
  // clearStorage() — that would instead leave the *reset* state (not the
  // old one) sitting in storage during that same instant, which is a
  // smaller window but the same class of bug the moment a caller is added
  // that doesn't immediately call setAuth().
  useStore.setState(INITIAL_DATA) // shallow merge: the actions survive
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      ...INITIAL_DATA,
      token: null,
      user: null,
      authStatus: 'unknown',
      sessionExpired: false,
      restoreFailed: false,
      authGeneration: 0,

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
      setAuth: (token, user) =>
        set({
          token,
          user,
          authStatus: token && user ? 'authenticated' : 'anonymous',
          restoreFailed: false,
        }),
      bumpAuthGeneration: () =>
        set((state) => ({ authGeneration: state.authGeneration + 1 })),
    }),
    persistConfig,
  ),
)
