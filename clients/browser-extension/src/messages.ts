// Everything that travels over browser.runtime ports. Protocol envelopes
// pass through the service worker UNTRANSLATED (spec: "protocol passes
// through untranslated"); ctl messages are extension-internal lifecycle.
// Ports are extension-internal (no foreign senders can connect without
// externally_connectable), but parse anyway: a malformed message must drop,
// not crash a context.
import {
  parseEmbedMessage, parseHostMessage,
  type EmbedMessage, type Envelope, type HostMessage, type StatusMessage,
} from '../../../frontend/src/embed/protocol'

export type PortMessage =
  | { relay: Envelope<HostMessage> | Envelope<EmbedMessage> }
  | { ctl: CtlMessage }

export type CtlMessage =
  | { kind: 'openPanel' }                      // scout -> sw (affordance click)
  | { kind: 'panelHello'; windowId: number }   // panel -> sw (port handshake)
  | { kind: 'embedReady'; ready: boolean }     // panel -> sw
  // sw -> scout, field replaced from ANOTHER tab. Carries the fieldId being
  // detached: a scout ignores a detach that does not name its CURRENT
  // session (a same-tab reconnect mints a new fieldId — a detach for the old
  // one arriving late must not kill the new session).
  | { kind: 'detach'; fieldId: string }
  // sw -> scout (affordance chip). M3 (closing sweep): fieldId is OPTIONAL
  // and, when present, scoping — same reasoning as detach's own fieldId
  // above: a same-tab reconnect to a different field must not let a
  // trailing status ctl for the OLD field paint the NEW field's chip.
  // Optional rather than mandatory because the registry-driven status
  // (registry.ts's embedRelay) always knows the current field's fieldId,
  // but sw.ts's own openPanel-failure error status is sent before any
  // session/fieldId exists to name — that one is left unscoped, exactly as
  // it was before this ctl carried a fieldId at all.
  | { kind: 'status'; phase: StatusMessage['payload']['phase']; findingCount: number; fieldId?: string }
  // panel -> sw -> scout (the panel's Disconnect button, live-test UX
  // decision B43 C2 PR #139). Unscoped (no fieldId): the registry only ever
  // routes this to the tab holding ITS OWN currently-connected field
  // (registry.disconnectRequested), so there is no OTHER field it could
  // wrongly land on the way detach/status's fieldId scoping guards against.
  | { kind: 'disconnect' }

export const HOST_KIND = 'browser-extension'

// Mirrors protocol.ts's own STATUS_PHASES (not exported there) — kept in
// sync with StatusMessage['payload']['phase'] WITHOUT importing that
// private set: every phase is a key of this Record, so tsc fails to compile
// if protocol.ts ever adds or renames a phase and this map isn't updated to
// match (a plain array/Set literal would silently drift instead).
const STATUS_PHASE_MAP: Record<StatusMessage['payload']['phase'], true> = {
  idle: true,
  checking: true,
  'llm-running': true,
  error: true,
  'signed-out': true,
}
const STATUS_PHASES = new Set(Object.keys(STATUS_PHASE_MAP))

const CTL_KINDS = new Set(['openPanel', 'panelHello', 'embedReady', 'detach', 'status', 'disconnect'])

function parseCtlMessage(data: unknown): CtlMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.kind !== 'string' || !CTL_KINDS.has(d.kind)) return null
  switch (d.kind) {
    case 'openPanel':
    case 'disconnect':
      break
    case 'panelHello':
      if (typeof d.windowId !== 'number') return null
      break
    case 'embedReady':
      if (typeof d.ready !== 'boolean') return null
      break
    case 'detach':
      if (typeof d.fieldId !== 'string') return null
      break
    case 'status':
      if (typeof d.phase !== 'string' || !STATUS_PHASES.has(d.phase)) return null
      if (typeof d.findingCount !== 'number') return null
      if (d.fieldId !== undefined && typeof d.fieldId !== 'string') return null
      break
  }
  return data as CtlMessage
}

export function parsePortMessage(data: unknown): PortMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if ('relay' in d) {
    const parsed = parseHostMessage(d.relay) ?? parseEmbedMessage(d.relay)
    if (parsed === null) return null
    return { relay: d.relay as Envelope<HostMessage> | Envelope<EmbedMessage> }
  }
  if ('ctl' in d) {
    const ctl = parseCtlMessage(d.ctl)
    if (ctl === null) return null
    return { ctl }
  }
  return null
}
