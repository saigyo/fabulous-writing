import {
  deleteLegacyBlob,
  PREF_KEYS,
  readPrefs,
  writePrefs,
  type Prefs,
} from './prefsStorage'
import { INITIAL_DATA, useStore } from './store'

/** The seven persisted fields' slice of INITIAL_DATA — the single defaults
 * definition shared by the loader, the tests, and (via spread) every
 * load. */
export const PREFS_DEFAULTS: Prefs = {
  uiLocale: INITIAL_DATA.uiLocale,
  // Collection fields are copied, not aliased: INITIAL_DATA is the baseline
  // every resetSessionState() restores from, and sharing its object
  // identities here would let one future in-place mutation corrupt that
  // baseline for every user.
  lastProfileByLanguage: { ...INITIAL_DATA.lastProfileByLanguage },
  rulesCollapsed: [...INITIAL_DATA.rulesCollapsed],
  currentDocId: INITIAL_DATA.currentDocId,
  docSidebarCollapsed: INITIAL_DATA.docSidebarCollapsed,
  docFoldersCollapsed: [...INITIAL_DATA.docFoldersCollapsed],
  language: INITIAL_DATA.language,
}

const pick = (state: Prefs): Prefs => ({
  uiLocale: state.uiLocale,
  lastProfileByLanguage: state.lastProfileByLanguage,
  rulesCollapsed: state.rulesCollapsed,
  currentDocId: state.currentDocId,
  docSidebarCollapsed: state.docSidebarCollapsed,
  docFoldersCollapsed: state.docFoldersCollapsed,
  language: state.language,
})

/** Applies the user's stored preferences over the declared defaults in ONE
 * atomic setState. Reset and hydration being a single step is what makes
 * the #34 leak impossible: a user with no blob gets exactly the defaults,
 * never the previous user's in-memory values. Must run while the store's
 * `user` is still null (the ordering invariant — see session.ts) so the
 * write subscriber below stays silent. */
export function loadUserPrefs(userId: number): void {
  useStore.setState({ ...PREFS_DEFAULTS, ...readPrefs(userId) })
}

let initialized = false

/** Boot wiring, called once from main.tsx (idempotent for tests): deletes
 * the legacy pre-B1 blob (clean break — never read) and registers the
 * write subscriber. */
export function initPrefsPersistence(): void {
  if (initialized) return
  initialized = true
  deleteLegacyBlob()
  useStore.subscribe((state, prev) => {
    // Reference comparison is exact: pref fields only change via their
    // setters, which always produce new values. Skipping unchanged states
    // keeps high-frequency transient updates (docWords/docChars on every
    // keystroke) away from localStorage.
    if (PREF_KEYS.every((key) => state[key] === prev[key])) return
    // Never write while logged out: the login gate cannot pollute any
    // namespace, and session-teardown resets (which run after
    // setAuth(null, null) per the ordering invariant) land nowhere.
    if (!state.user) return
    writePrefs(state.user.id, pick(state))
  })
}
