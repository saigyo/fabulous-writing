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
  | { kind: 'status'; phase: StatusMessage['payload']['phase']; findingCount: number } // sw -> scout (affordance chip)

export const HOST_KIND = 'browser-extension'

// Mirrors protocol.ts's own STATUS_PHASES (not exported there) — kept in
// sync with StatusMessage['payload']['phase'].
const STATUS_PHASES = new Set(['idle', 'checking', 'llm-running', 'error', 'signed-out'])

const CTL_KINDS = new Set(['openPanel', 'panelHello', 'embedReady', 'detach', 'status'])

function parseCtlMessage(data: unknown): CtlMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.kind !== 'string' || !CTL_KINDS.has(d.kind)) return null
  switch (d.kind) {
    case 'openPanel':
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
