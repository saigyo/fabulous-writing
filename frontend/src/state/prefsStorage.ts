import { LOCALES, type Locale } from '../i18n/messages'

/** The persisted-preferences schema (B1, #34). Deliberately declared
 * standalone rather than derived from the store type: this is a storage
 * contract — changing it is a schema change and must be a conscious
 * decision (bump PREFS_VERSION and add a read-side migration when the
 * shape changes incompatibly). */
export interface Prefs {
  uiLocale: Locale | null
  lastProfileByLanguage: Record<string, number>
  rulesCollapsed: string[]
  currentDocId: number | null
  docSidebarCollapsed: boolean
  docFoldersCollapsed: number[]
}

export const PREF_KEYS = [
  'uiLocale',
  'lastProfileByLanguage',
  'rulesCollapsed',
  'currentDocId',
  'docSidebarCollapsed',
  'docFoldersCollapsed',
] as const satisfies readonly (keyof Prefs)[]

// Continues the legacy blob's numbering (it retired at v2) so the version
// number never moves backwards. There are no older versions to migrate:
// any other version is discarded and defaults apply.
export const PREFS_VERSION = 2

const TOKEN_KEY = 'fabulous-writing-token'
const REFRESH_TOKEN_KEY = 'fabulous-writing-refresh-token'
const TOKEN_EXPIRES_KEY = 'fabulous-writing-token-expires'
// The pre-B1 single blob that mixed the token with the last user's
// preferences. Deleted once at boot (see prefsPersistence.ts), never read.
const LEGACY_KEY = 'fabulous-writing-settings'

export const prefsKey = (userId: number): string =>
  `fabulous-writing-settings:${userId}`

// All accessors swallow storage failures (quota, privacy mode) exactly as
// the persist middleware did: reads fall back to null, writes are
// best-effort — the app then runs with in-memory state only.

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function writeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Without storage the session just won't survive a reload.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing to clear if storage itself is unavailable.
  }
}

export function readRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY)
  } catch {
    return null
  }
}

// null clears the key rather than writing the string "null" — session.ts
// passes the API's own refresh_token straight through (`?? null`), so a
// local-mode/expired response removes the stored value instead of pinning
// a literal "null" string that Number(...)/readRefreshToken would then
// have to special-case.
export function writeRefreshToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(REFRESH_TOKEN_KEY)
    else localStorage.setItem(REFRESH_TOKEN_KEY, token)
  } catch {
    // Without storage the session just won't survive a reload.
  }
}

export function clearRefreshToken(): void {
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY)
  } catch {
    // Nothing to clear if storage itself is unavailable.
  }
}

export function readTokenExpiresAt(): number | null {
  try {
    const raw = localStorage.getItem(TOKEN_EXPIRES_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isNaN(n) ? null : n
  } catch {
    return null
  }
}

// Same null-clears convention as writeRefreshToken above. Stored as a
// decimal string (Unix seconds, matching the backend's expires_at) rather
// than an ISO date: readTokenExpiresAt's Number(...) round-trips it exactly
// and needs no date parsing.
export function writeTokenExpiresAt(expiresAt: number | null): void {
  try {
    if (expiresAt === null) localStorage.removeItem(TOKEN_EXPIRES_KEY)
    else localStorage.setItem(TOKEN_EXPIRES_KEY, String(expiresAt))
  } catch {
    // Without storage the session just won't survive a reload.
  }
}

export function clearTokenExpiresAt(): void {
  try {
    localStorage.removeItem(TOKEN_EXPIRES_KEY)
  } catch {
    // Nothing to clear if storage itself is unavailable.
  }
}

export function deleteLegacyBlob(): void {
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Best-effort; an unremovable legacy key is never read anyway.
  }
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string')

const isNumberArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'number')

const isProfileRecord = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((item) => typeof item === 'number')

/** Per-field runtime validators: localStorage is user-editable, so a
 * current-version blob can still hold anything (e.g. docFoldersCollapsed:
 * null would crash `.includes` consumers). An invalid value is treated as
 * absent — its default applies. */
const VALIDATORS: { [K in keyof Prefs]: (v: unknown) => v is Prefs[K] } = {
  uiLocale: (v): v is Locale | null =>
    v === null ||
    (typeof v === 'string' && (LOCALES as readonly string[]).includes(v)),
  lastProfileByLanguage: isProfileRecord,
  rulesCollapsed: isStringArray,
  currentDocId: (v): v is number | null => v === null || typeof v === 'number',
  docSidebarCollapsed: (v): v is boolean => typeof v === 'boolean',
  docFoldersCollapsed: isNumberArray,
}

/** Returns the stored preference fields for the user, or null when absent,
 * unparseable, or not the current schema version — callers treat all three
 * identically (defaults apply; the next write replaces the blob). Unknown
 * keys and invalid values are dropped so a blob can never smuggle bad data
 * into the store. */
export function readPrefs(userId: number): Partial<Prefs> | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(prefsKey(userId))
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const envelope = parsed as { version?: unknown; state?: unknown }
  if (envelope.version !== PREFS_VERSION) return null
  if (typeof envelope.state !== 'object' || envelope.state === null) return null
  const state = envelope.state as Record<string, unknown>
  const prefs: Partial<Prefs> = {}
  for (const key of PREF_KEYS) {
    if (key in state && VALIDATORS[key](state[key])) {
      ;(prefs as Record<string, unknown>)[key] = state[key]
    }
  }
  return prefs
}

/** zustand-persist-compatible envelope: {"state": {...}, "version": 2} —
 * keeps a future return to the middleware possible without a storage-format
 * migration. */
export function writePrefs(userId: number, prefs: Prefs): void {
  try {
    localStorage.setItem(
      prefsKey(userId),
      JSON.stringify({ state: prefs, version: PREFS_VERSION }),
    )
  } catch {
    // Best-effort, matching the middleware's behavior under quota/privacy.
  }
}
