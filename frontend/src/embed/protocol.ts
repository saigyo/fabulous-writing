// The bridge contract between the embed page and any host (spec: B43,
// "Bridge protocol"). Offsets in every message are UTF-16 code units.
// This module is imported by both sides — a breaking change here fails
// compilation in the extension too, never at runtime.
import { CATEGORIES } from '../types'
import type { Category, Severity } from '../types'
import { SEVERITIES } from '../findings/severity'

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
  // Exact-match only. The spec's version policy is N-1 (accept the current
  // and immediately prior protocol version), not yet implemented: this line
  // must become a range check (d.fw < PROTOCOL_VERSION - 1 || d.fw >
  // PROTOCOL_VERSION) the first time PROTOCOL_VERSION is bumped.
  if (d.fw !== PROTOCOL_VERSION) return null
  if (typeof d.type !== 'string' || !HOST_TYPES.has(d.type)) return null
  const p = d.payload
  if (typeof p !== 'object' || p === null) return null
  const pay = p as Record<string, unknown>
  switch (d.type) {
    case 'hello': {
      if (typeof pay.host !== 'object' || pay.host === null) return null
      const host = pay.host as Record<string, unknown>
      if (typeof host.kind !== 'string' || typeof host.version !== 'string') return null
      break
    }
    case 'fieldConnected': {
      if (typeof pay.fieldId !== 'string' || pay.fieldId.length === 0) return null
      if (typeof pay.text !== 'string') return null
      if (!validCapabilities(pay.capabilities)) return null
      if (typeof pay.meta !== 'object' || pay.meta === null) return null
      const meta = pay.meta as Record<string, unknown>
      if (typeof meta.url !== 'string' || typeof meta.fieldKind !== 'string') return null
      break
    }
    case 'textChanged':
      if (typeof pay.fieldId !== 'string' || pay.fieldId.length === 0) return null
      if (typeof pay.text !== 'string') return null
      break
    case 'replaceResult':
      // fieldId is the shim's stale-field guard (hostDoc.ts's replaceResult
      // ignores any echo whose fieldId doesn't match the connected field) —
      // reject here at the parser rather than let a malformed payload reach
      // that guard with fieldId silently undefined. An empty string would
      // pass typeof but can never legitimately match a connected field
      // (fieldConnected/fieldDisconnected below reject it too), so hostDoc's
      // fieldId !== fid guard would just as reliably drop it — this rejects
      // it earlier, at the wire boundary, instead of relying on that.
      if (typeof d.requestId !== 'string' || typeof pay.ok !== 'boolean'
        || typeof pay.text !== 'string') return null
      if (typeof pay.fieldId !== 'string' || pay.fieldId.length === 0) return null
      break
    case 'markingClicked':
      if (typeof pay.fieldId !== 'string' || pay.fieldId.length === 0) return null
      if (typeof pay.id !== 'string' || pay.id.length === 0) return null
      break
    case 'fieldDisconnected':
      if (typeof pay.fieldId !== 'string' || pay.fieldId.length === 0) return null
      break
  }
  return data as HostMessage
}

const EMBED_TYPES = new Set([
  'ready', 'status', 'findings', 'applyReplacement', 'selectFinding',
])

const STATUS_PHASES = new Set(['idle', 'checking', 'llm-running', 'error', 'signed-out'])

function isValidMarkingSpan(value: unknown): value is MarkingSpan {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.id === 'string' && s.id.length > 0 &&
    typeof s.from === 'number' && typeof s.to === 'number' &&
    SEVERITIES.includes(s.severity as Severity) &&
    CATEGORIES.includes(s.category as Category)
  )
}

/** Validate an incoming postMessage payload from the embed -> host direction
 * — the simulator's own host role (main.ts) plays here what parseHostMessage
 * plays for the embed. Lives beside parseHostMessage so both directions of
 * the protocol share one hardened validator module instead of each host
 * implementation (the simulator today, C2's browser extension next)
 * reinventing its own permissive, type-only parse. */
export function parseEmbedMessage(data: unknown): EmbedMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.fw !== PROTOCOL_VERSION) return null
  if (typeof d.type !== 'string' || !EMBED_TYPES.has(d.type)) return null
  const p = d.payload
  if (typeof p !== 'object' || p === null) return null
  const pay = p as Record<string, unknown>
  switch (d.type) {
    case 'ready':
      if (typeof pay.protocolVersion !== 'number') return null
      if (!Array.isArray(pay.features) || !pay.features.every((f) => typeof f === 'string')) return null
      break
    case 'status':
      if (typeof pay.phase !== 'string' || !STATUS_PHASES.has(pay.phase)) return null
      if (typeof pay.findingCount !== 'number') return null
      break
    case 'findings':
      if (typeof pay.fieldId !== 'string' || pay.fieldId.length === 0) return null
      if (!Array.isArray(pay.findings) || !pay.findings.every(isValidMarkingSpan)) return null
      break
    case 'applyReplacement':
      if (typeof d.requestId !== 'string') return null
      if (typeof pay.fieldId !== 'string' || pay.fieldId.length === 0) return null
      if (typeof pay.from !== 'number' || typeof pay.to !== 'number') return null
      if (typeof pay.insert !== 'string' || typeof pay.expectedText !== 'string') return null
      break
    case 'selectFinding':
      if (typeof pay.fieldId !== 'string' || pay.fieldId.length === 0) return null
      if (pay.id !== null && typeof pay.id !== 'string') return null
      break
  }
  return data as EmbedMessage
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
