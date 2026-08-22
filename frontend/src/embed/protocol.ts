// The bridge contract between the embed page and any host (spec: B43,
// "Bridge protocol"). Offsets in every message are UTF-16 code units.
// This module is imported by both sides — a breaking change here fails
// compilation in the extension too, never at runtime.
import type { Category, Severity } from '../types'

export const PROTOCOL_VERSION = 1

export const MARK_CAPABILITIES = ['overlay', 'native', 'none'] as const
export const REPLACE_CAPABILITIES = ['reliable', 'best-effort', 'none'] as const
export type MarkCapability = (typeof MARK_CAPABILITIES)[number]
export type ReplaceCapability = (typeof REPLACE_CAPABILITIES)[number]

export interface HostCapabilities {
  mark: MarkCapability
  replace: ReplaceCapability
}

export interface MarkingSpan {
  id: string
  from: number
  to: number
  severity: Severity
  category: Category
}

// ---- host -> embed ----
export interface HelloMessage {
  type: 'hello'
  payload: { host: { kind: string; version: string } }
}
export interface FieldConnectedMessage {
  type: 'fieldConnected'
  payload: {
    fieldId: string
    text: string
    capabilities: HostCapabilities
    meta: { url: string; fieldKind: string }
  }
}
export interface TextChangedMessage {
  type: 'textChanged'
  payload: { fieldId: string; text: string }
}
export interface ReplaceResultMessage {
  type: 'replaceResult'
  requestId: string
  payload: { fieldId: string; ok: boolean; text: string }
}
export interface MarkingClickedMessage {
  type: 'markingClicked'
  payload: { fieldId: string; id: string }
}
export interface FieldDisconnectedMessage {
  type: 'fieldDisconnected'
  payload: { fieldId: string }
}
export type HostMessage =
  | HelloMessage
  | FieldConnectedMessage
  | TextChangedMessage
  | ReplaceResultMessage
  | MarkingClickedMessage
  | FieldDisconnectedMessage

// ---- embed -> host ----
export interface ReadyMessage {
  type: 'ready'
  payload: { protocolVersion: number; features: string[] }
}
export interface StatusMessage {
  type: 'status'
  payload: {
    phase: 'idle' | 'checking' | 'llm-running' | 'error' | 'signed-out'
    findingCount: number
  }
}
export interface FindingsMessage {
  type: 'findings'
  payload: { fieldId: string; findings: MarkingSpan[] }
}
export interface ApplyReplacementMessage {
  type: 'applyReplacement'
  requestId: string
  payload: {
    fieldId: string
    from: number
    to: number
    insert: string
    expectedText: string
  }
}
export interface SelectFindingMessage {
  type: 'selectFinding'
  payload: { fieldId: string; id: string | null }
}
export type EmbedMessage =
  | ReadyMessage
  | StatusMessage
  | FindingsMessage
  | ApplyReplacementMessage
  | SelectFindingMessage

export type Envelope<M> = M & { fw: number }

export function envelope<M extends EmbedMessage>(message: M): Envelope<M> {
  return { fw: PROTOCOL_VERSION, ...message }
}

const HOST_TYPES = new Set([
  'hello', 'fieldConnected', 'textChanged', 'replaceResult',
  'markingClicked', 'fieldDisconnected',
])

function validCapabilities(value: unknown): value is HostCapabilities {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    MARK_CAPABILITIES.includes(c.mark as MarkCapability) &&
    REPLACE_CAPABILITIES.includes(c.replace as ReplaceCapability)
  )
}

/** Validate an incoming postMessage payload. Returns null for anything that
 * is not a current-version host message with the fields its type requires —
 * the bridge drops those silently (foreign frames post all kinds of data). */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.fw !== PROTOCOL_VERSION) return null
  if (typeof d.type !== 'string' || !HOST_TYPES.has(d.type)) return null
  const p = d.payload
  if (typeof p !== 'object' || p === null) return null
  const pay = p as Record<string, unknown>
  switch (d.type) {
    case 'hello':
      if (typeof pay.host !== 'object' || pay.host === null) return null
      break
    case 'fieldConnected':
      if (typeof pay.fieldId !== 'string' || typeof pay.text !== 'string') return null
      if (!validCapabilities(pay.capabilities)) return null
      break
    case 'textChanged':
      if (typeof pay.fieldId !== 'string' || typeof pay.text !== 'string') return null
      break
    case 'replaceResult':
      if (typeof d.requestId !== 'string' || typeof pay.ok !== 'boolean'
        || typeof pay.text !== 'string') return null
      break
    case 'markingClicked':
    case 'fieldDisconnected':
      if (typeof pay.fieldId !== 'string') return null
      break
  }
  return data as HostMessage
}

// ---- the host-side adapter contract (spec: "Field adapters") ----
// Lives here (not in the extension) so the simulator's reference adapter and
// every later host implement the same shape the protocol was designed for.
// Deviation from the spec's protocol table, recorded in Task 10: capabilities
// travel on fieldConnected (per field), not on hello — matching the spec's
// own prose ("per-field capabilities").
export interface FieldAdapter {
  capabilities(): HostCapabilities
  extract(): string
  onChange(cb: () => void): void
  applyReplacement(
    from: number, to: number, insert: string, expectedText: string,
  ): { ok: boolean; text: string }
  setMarkings(spans: MarkingSpan[]): void
  clearMarkings(): void
  flashFinding(id: string): void
  dispose(): void
}
