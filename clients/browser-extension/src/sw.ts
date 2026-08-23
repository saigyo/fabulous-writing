// The service worker: wires real browser.runtime ports to the pure Registry
// (registry.ts) and to the Chromium-only panelHost abstraction. Direction is
// discriminated BY PORT NAME — 'field' ports are opened by the content-script
// scout (Task 7), 'panel' ports by the side panel (Task 8) — never by
// inspecting message content.
//
// Accepted v1 limits (both apply to the Registry instance below):
// 1. The registry is entirely in-memory. This is ACCEPTED for v1 NOT because
//    an open runtime port keeps an MV3 worker alive indefinitely — it
//    doesn't; only port TRAFFIC resets the ~30s idle timer, so a quiet
//    session can still lose the worker and its in-memory state — but because
//    BOTH sides recover when that happens: the scout reconnects on the next
//    user interaction (port onDisconnect tears its session down to an idle
//    chip; the next click/focus lazily reopens a port and re-registers,
//    scout.ts's handlePortDisconnect), and the panel reloads itself the
//    moment its own port disconnects (panel.ts's
//    `port.onDisconnect.addListener(() => location.reload())`), re-deriving
//    fresh state via a new panelHello. A `chrome.storage.session`-backed
//    registry is a later hardening, not a correctness requirement for v1.
// 2. The registry keys field/panel state on the windowId captured at
//    port-connect time. Dragging a connected tab into another browser window
//    keeps it routed to the OLD window's panel until that field reconnects
//    (e.g. on next keystroke) and re-registers under the new window.
import browser from 'webextension-polyfill'
import type { EmbedMessage, Envelope, HostMessage } from '../../../frontend/src/embed/protocol'
import { parsePortMessage, type PortMessage } from './messages'
import { initPanelBehavior, openPanel, setBadge } from './panelHost'
import { Registry, type Effect } from './registry'

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0]

const registry = new Registry()

const fieldPorts = new Map<number, Port>() // tabId -> port
const panelPorts = new Map<number, Port>() // windowId -> port

// A disconnected/gone port throwing must not kill the handler — the effect
// list may target several ports and one dead one shouldn't stop the rest.
function postSafely(port: Port, message: PortMessage): void {
  try {
    port.postMessage(message)
  } catch {
    // ignored — the corresponding onDisconnect will clean the port up
  }
}

function execute(effects: Effect[]): void {
  for (const effect of effects) {
    if (effect.kind === 'badge') {
      setBadge(effect.tabId, effect.text)
      continue
    }
    const port = effect.to === 'panel' ? panelPorts.get(effect.windowId)
      : effect.tabId !== undefined ? fieldPorts.get(effect.tabId)
      : undefined
    if (port) postSafely(port, effect.message)
  }
}

function handleFieldMessage(tabId: number, windowId: number, port: Port, data: unknown): void {
  // A superseded port (same-tab navigation opened a NEW port and
  // re-registered under this tabId before the OLD port's onDisconnect fired
  // — no ordering guarantee between those two events, see the onDisconnect
  // guard below) must not affect state under the new port's tabId. Without
  // this, a late fieldDisconnected from the old port would clear the field
  // the new port already re-registered.
  if (fieldPorts.get(tabId) !== port) return
  const parsed = parsePortMessage(data)
  if (parsed === null) return
  if ('ctl' in parsed) {
    if (parsed.ctl.kind === 'openPanel') {
      // MUST be synchronous — no await before this call. sidePanel.open
      // requires a user gesture, and any microtask hop before it drops the
      // gesture context propagated from the content-script click.
      openPanel(windowId, () => {
        const fieldPort = fieldPorts.get(tabId)
        if (fieldPort) postSafely(fieldPort, { ctl: { kind: 'status', phase: 'error', findingCount: 0 } })
      })
    }
    return
  }
  // Field ports carry only host->sw envelopes (protocol direction, enforced
  // by port name, not by content inspection — see the module comment).
  const msg = parsed.relay as Envelope<HostMessage>
  if (msg.type === 'fieldConnected') {
    execute(registry.fieldConnected(windowId, tabId, msg))
  } else if (msg.type === 'textChanged') {
    execute(registry.textChanged(windowId, tabId, msg))
  } else {
    execute(registry.hostRelay(windowId, tabId, msg))
  }
}

function handlePanelMessage(state: { windowId: number | null }, port: Port, data: unknown): void {
  const parsed = parsePortMessage(data)
  if (parsed === null) return
  if ('ctl' in parsed) {
    if (parsed.ctl.kind === 'panelHello') {
      const windowId = parsed.ctl.windowId
      const existing = panelPorts.get(windowId)
      if (existing && existing !== port) {
        // This hello REPLACES a still-registered different port for the
        // same window (the old panel hasn't disconnected yet — its
        // identity-guarded onDisconnect below never fires panelPortGone for
        // an already-superseded port). Without resetting readiness here, the
        // registry would stay panelReady from the old panel and this new
        // panel's own embedReady(true) below would hit rule 4's duplicate
        // no-op — never synthesizing the fieldConnected the new panel needs
        // to render the current field. A fresh panel always starts
        // not-ready. (registry.panelReady(_, false) never returns effects,
        // so there's nothing to execute().)
        registry.panelReady(windowId, false)
      }
      state.windowId = windowId
      panelPorts.set(windowId, port)
      return
    }
    // Everything past the hello requires currency: a stale panel port (one
    // superseded by a replacement already registered under this windowId,
    // whose onMessage nonetheless still fires) must not affect the live
    // panel's state.
    if (state.windowId === null || panelPorts.get(state.windowId) !== port) return
    if (parsed.ctl.kind === 'embedReady') {
      execute(registry.panelReady(state.windowId, parsed.ctl.ready))
    }
    return
  }
  if (state.windowId === null || panelPorts.get(state.windowId) !== port) return
  // Panel ports carry only embed->sw envelopes — see the module comment.
  execute(registry.embedRelay(state.windowId, parsed.relay as Envelope<EmbedMessage>))
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'field') {
    const tab = port.sender?.tab
    if (tab?.id === undefined || tab.windowId === undefined) {
      port.disconnect()
      return
    }
    const tabId = tab.id
    const windowId = tab.windowId
    fieldPorts.set(tabId, port)
    port.onMessage.addListener((data) => handleFieldMessage(tabId, windowId, port, data))
    port.onDisconnect.addListener(() => {
      // Guard against a stale disconnect: same-tab navigation can connect a
      // NEW port and re-register it under this tabId before the OLD port's
      // onDisconnect fires (no ordering guarantee between those events). If
      // the map no longer points at THIS port, it was already superseded —
      // the disconnect of a superseded port must be a complete no-op, never
      // evicting the live port or wiping a still-connected field.
      if (fieldPorts.get(tabId) !== port) return
      fieldPorts.delete(tabId)
      execute(registry.fieldPortGone(windowId, tabId))
    })
    return
  }

  if (port.name === 'panel') {
    const state: { windowId: number | null } = { windowId: null }
    port.onMessage.addListener((data) => handlePanelMessage(state, port, data))
    port.onDisconnect.addListener(() => {
      if (state.windowId === null) return
      // Same guard as the field-port branch above, for a superseded panel
      // reconnect racing its predecessor's disconnect.
      if (panelPorts.get(state.windowId) !== port) return
      panelPorts.delete(state.windowId)
      registry.panelPortGone(state.windowId)
    })
  }
})

initPanelBehavior()
