// Leaf module in the spirit of checking/cancelSlot.ts: the checking layer
// and the sidebar talk to "the document" through this port; the main app
// registers a CodeMirror implementation (editor/editorPort.ts) from
// main.tsx, the embed registers the host-document shim. No module imports
// both sides. Like cancelSlot, the default is a null object, not null —
// call sites never null-check, and "no port" behaves as an empty document.
import type { TrackedFinding } from '../editor/findings'
import type { Finding, Source } from '../types'

export type ApplyResult = 'ok' | 'not-found' | 'refused'

export interface DocumentPort {
  /** False when no real document is behind the port (no EditorView / no
   * connected field / null object). Guards that previously read "is there
   * a view?" MUST use this — getText() === '' is NOT a substitute: an
   * empty string is also a legitimate empty document, and autosave PUTting
   * '' over a real document would be data loss. */
  hasDocument(): boolean
  getText(): string
  /** Replace the whole document and its findings (document-manager
   * hydration path). No-op in the embed shim — the document manager never
   * runs there. */
  setDocument(text: string, findings: Finding[]): void
  /** The finding's current tracked state (live document state, not the
   * store's post-hoc mirror), or null if it was dropped. */
  currentFinding(id: string): TrackedFinding | null
  /** The finding's span in BACKEND offsets (code points) for outbound
   * requests. Identity with the tracked span in the CodeMirror port. */
  serverSpan(id: string): { start: number; end: number } | null
  /** Replace all findings of the given sources (no staleness check — the
   * caller compares getText() against its checked snapshot first). */
  mergeFindings(replaceSources: Source[], findings: Finding[]): void
  selectFinding(id: string | null): void
  /** 'ok' = applied; 'not-found' = the finding/sentence is gone (stale);
   * 'refused' = the host declined or timed out (embed only). */
  applySuggestion(id: string, suggestion: string): Promise<ApplyResult>
  applyRewrite(id: string, original: string, replacement: string): Promise<ApplyResult>
}

const nullPort: DocumentPort = {
  hasDocument: () => false,
  getText: () => '',
  setDocument: () => {},
  currentFinding: () => null,
  serverSpan: () => null,
  mergeFindings: () => {},
  selectFinding: () => {},
  applySuggestion: () => Promise.resolve('not-found'),
  applyRewrite: () => Promise.resolve('not-found'),
}

let port: DocumentPort = nullPort
export function setDocumentPort(p: DocumentPort | null): void { port = p ?? nullPort }
export function getDocumentPort(): DocumentPort { return port }
