// Embed-only UI state (B43 C2, owner UX round 2): whether the selector block
// (Profile/Language/Domain/LLM) is collapsed. Deliberately NOT part of the
// Prefs schema (state/prefsStorage.ts) — it is local to this embed page, not
// synced with the main app or across devices, so it gets its own key rather
// than a schema bump. Reads/writes swallow storage failures (quota, privacy
// mode), matching prefsStorage.ts's own accessors.
const SELECTORS_COLLAPSED_KEY = 'fw-embed-selectors-collapsed'

export function readSelectorsCollapsed(): boolean {
  try {
    return localStorage.getItem(SELECTORS_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeSelectorsCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SELECTORS_COLLAPSED_KEY, String(collapsed))
  } catch {
    // Best-effort; the collapsed state just won't survive a reload.
  }
}
