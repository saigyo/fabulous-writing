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
