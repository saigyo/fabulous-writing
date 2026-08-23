// The per-window connection registry — a pure state machine, one instance
// lives in the service worker. No chrome.*/browser.* imports here: every
// operation returns Effect[] that sw.ts executes against real ports. This is
// what makes the routing rules unit-testable without any port mocking.
import type {
  EmbedMessage, Envelope, FieldConnectedMessage, FieldDisconnectedMessage,
  HostCapabilities, HostMessage, StatusMessage, TextChangedMessage,
} from '../../../frontend/src/embed/protocol'
import { PROTOCOL_VERSION } from '../../../frontend/src/embed/protocol'
import type { PortMessage } from './messages'

export interface SendEffect {
  kind: 'send'
  to: 'panel' | 'field' | 'oldField'
  windowId: number
  tabId?: number
  message: PortMessage
}
export interface BadgeEffect { kind: 'badge'; tabId: number; text: string }
export type Effect = SendEffect | BadgeEffect

interface FieldState {
  tabId: number
  fieldId: string
  capabilities: HostCapabilities
  meta: { url: string; fieldKind: string }
  text: string
}

interface WindowState {
  field: FieldState | null
  panelReady: boolean
}

export class Registry {
  private windows = new Map<number, WindowState>()

  private getOrCreate(windowId: number): WindowState {
    let w = this.windows.get(windowId)
    if (!w) {
      w = { field: null, panelReady: false }
      this.windows.set(windowId, w)
    }
    return w
  }

  fieldConnected(windowId: number, tabId: number, msg: Envelope<FieldConnectedMessage>): Effect[] {
    const w = this.getOrCreate(windowId)
    const effects: Effect[] = []
    if (w.field && w.field.tabId !== tabId) {
      effects.push({
        kind: 'send', to: 'oldField', windowId, tabId: w.field.tabId,
        message: { ctl: { kind: 'detach', fieldId: w.field.fieldId } },
      })
      // Every other teardown path (fieldDisconnected, fieldPortGone) clears
      // the losing tab's badge; a cross-tab replace must too, or the old
      // tab's action badge is left showing a stale finding count forever.
      effects.push({ kind: 'badge', tabId: w.field.tabId, text: '' })
    }
    w.field = {
      tabId,
      fieldId: msg.payload.fieldId,
      capabilities: msg.payload.capabilities,
      meta: msg.payload.meta,
      text: msg.payload.text,
    }
    if (w.panelReady) {
      effects.push({ kind: 'send', to: 'panel', windowId, message: { relay: msg } })
    }
    return effects
  }

  textChanged(windowId: number, tabId: number, msg: Envelope<TextChangedMessage>): Effect[] {
    const w = this.windows.get(windowId)
    if (!w || !w.field || w.field.tabId !== tabId) return []
    w.field.text = msg.payload.text
    if (!w.panelReady) return []
    return [{ kind: 'send', to: 'panel', windowId, message: { relay: msg } }]
  }

  hostRelay(windowId: number, tabId: number, msg: Envelope<HostMessage>): Effect[] {
    const w = this.windows.get(windowId)
    if (!w || !w.field || w.field.tabId !== tabId) return []
    if (msg.type === 'fieldDisconnected') {
      const clearedTabId = w.field.tabId
      w.field = null
      const effects: Effect[] = []
      if (w.panelReady) {
        effects.push({ kind: 'send', to: 'panel', windowId, message: { relay: msg } })
      }
      effects.push({ kind: 'badge', tabId: clearedTabId, text: '' })
      return effects
    }
    if (!w.panelReady) return []
    return [{ kind: 'send', to: 'panel', windowId, message: { relay: msg } }]
  }

  embedRelay(windowId: number, msg: Envelope<EmbedMessage>): Effect[] {
    const w = this.windows.get(windowId)
    if (msg.type === 'status') {
      const statusMsg = msg as Envelope<StatusMessage>
      // Copilot round 4 (closing sweep), F1: badge/ctl-status effects fire
      // ONLY while this window has a LIVE field. Every disconnect path
      // (hostRelay's fieldDisconnected, fieldPortGone, the cross-tab replace
      // branch of fieldConnected) already emits its own immediate badge
      // clear, so there is no "one more trailing status" case left to catch
      // here — and trying to catch one is actively harmful: if a field's tab
      // reconnects in ANOTHER window, a late fieldless status arriving in
      // THIS window must not touch that tabId's badge at all, since the new
      // window may already be painting a live count onto it.
      if (!w || !w.field) return []
      return [
        {
          kind: 'badge',
          tabId: w.field.tabId,
          text: statusMsg.payload.findingCount > 0 ? String(statusMsg.payload.findingCount) : '',
        },
        {
          kind: 'send', to: 'field', windowId, tabId: w.field.tabId,
          message: {
            ctl: {
              kind: 'status',
              phase: statusMsg.payload.phase,
              findingCount: statusMsg.payload.findingCount,
              // M3: scopes the ctl to the CURRENT field, so a same-tab
              // reconnect racing a trailing status from the field it
              // replaced can't paint the wrong field's chip.
              fieldId: w.field.fieldId,
            },
          },
        },
      ]
    }
    if (!w || !w.field) return []
    return [{ kind: 'send', to: 'field', windowId, tabId: w.field.tabId, message: { relay: msg } }]
  }

  panelReady(windowId: number, ready: boolean): Effect[] {
    const w = this.getOrCreate(windowId)
    if (!ready) {
      w.panelReady = false
      return []
    }
    if (w.panelReady) return []
    w.panelReady = true
    if (!w.field) return []
    const synthesized: Envelope<FieldConnectedMessage> = {
      fw: PROTOCOL_VERSION,
      type: 'fieldConnected',
      payload: {
        fieldId: w.field.fieldId,
        text: w.field.text,
        capabilities: w.field.capabilities,
        meta: w.field.meta,
      },
    }
    return [{ kind: 'send', to: 'panel', windowId, message: { relay: synthesized } }]
  }

  fieldPortGone(windowId: number, tabId: number): Effect[] {
    const w = this.windows.get(windowId)
    if (!w || !w.field || w.field.tabId !== tabId) return []
    const fieldId = w.field.fieldId
    w.field = null
    const effects: Effect[] = []
    if (w.panelReady) {
      const synthesized: Envelope<FieldDisconnectedMessage> = {
        fw: PROTOCOL_VERSION,
        type: 'fieldDisconnected',
        payload: { fieldId },
      }
      effects.push({ kind: 'send', to: 'panel', windowId, message: { relay: synthesized } })
    }
    effects.push({ kind: 'badge', tabId, text: '' })
    return effects
  }

  panelPortGone(windowId: number): void {
    const w = this.windows.get(windowId)
    if (w) w.panelReady = false
  }
}
