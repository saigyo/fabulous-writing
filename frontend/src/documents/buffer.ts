import type {
  DocumentSettingsPayload,
  SavedFinding,
  ScorecardSnapshot,
} from '../api/client'

const BUFFER_KEY = 'fabulous-writing-doc-buffer'

/**
 * Write-through cache of the current document. localStorage is never the
 * source of truth — it only bridges network failures and tab closes until
 * the backend confirms the write (dirty=false).
 */
export interface DocSnapshot {
  docId: number
  revision: number
  dirty: boolean
  name: string
  text: string
  findings: SavedFinding[]
  scorecard: ScorecardSnapshot | null
  settings: DocumentSettingsPayload
  // The signed-in user at write time — NOT the document's own owner_id
  // (M2 hardcodes that to 1 for every document). Used to tell whether a
  // buffer left over from a previous session belongs to the user now
  // signing in. Optional (not `number | undefined`, which TypeScript still
  // treats as required) so a snapshot written by an older build, which has
  // no such field, remains a valid DocSnapshot; that absence is then
  // treated as "not this user's" — failing safe costs one unsaved buffer
  // once, while failing open would leak text across accounts.
  ownerId?: number
}

export function writeSnapshot(snapshot: DocSnapshot): void {
  localStorage.setItem(BUFFER_KEY, JSON.stringify(snapshot))
}

export function readSnapshot(): DocSnapshot | null {
  const raw = localStorage.getItem(BUFFER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as DocSnapshot
  } catch {
    return null
  }
}

export function clearSnapshot(): void {
  localStorage.removeItem(BUFFER_KEY)
}
