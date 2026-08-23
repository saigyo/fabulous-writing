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
//    port-connect time, so routing (which panel a field's traffic reaches)
//    still follows a dragged tab's OLD window until the field's port
//    reconnects (e.g. on next keystroke) and re-registers under the new
//    window's id. Copilot round 3, L1: this used to also leave a GHOST field
//    behind in the old window's registry state — the idle-port replacement
//    branch below cleared the registry using the NEW port's windowId, so a
//    tab dragged into another window before its field reconnected had its
//    stale entry stored under the OLD window, which the replacement branch's
//    lookup never reached. fieldPorts now carries each port's own
//    connect-time windowId alongside it, and the replacement branch clears
//    the OLD window's entry by that stored windowId — so the ghost no longer
//    survives; only the routing-follows-the-old-window caveat remains.
//
//    M12 (closing sweep): the same connect-time windowId caveat also reaches
//    openPanel (handleFieldMessage below) — sidePanel.open() is called with
//    the WINDOW ID captured when the field's port connected, so a chip
//    click just after a drag-between-windows (before the field's port
//    reconnects and re-registers under the new window) opens the side
//    panel in the tab's OLD window instead of the one the user is looking
//    at, or the open call rejects outright for a since-closed window
//    (delivering the async error ctl below to a chip that did nothing
//    wrong). No cheap fix exists here either: a `tabs.get` await before
//    sidePanel.open() would drop the user-gesture context the synchronous
//    call depends on. Accepted for v1, same shape as this limit's own
//    routing caveat above.
import browser from 'webextension-polyfill'
import type { EmbedMessage, Envelope, HostMessage } from '../../../frontend/src/embed/protocol'
import { parsePortMessage, type PortMessage } from './messages'
import { initPanelBehavior, openPanel, setBadge } from './panelHost'
import { Registry, type Effect } from './registry'

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0]

const registry = new Registry()

// tabId -> {port, windowId}. windowId is the port's OWN connect-time window,
// tracked alongside it so a replacement port (Copilot round 3, L1) can evict
// the stale field from the OLD port's window even after the tab has since
// moved to a different one — see the module comment's accepted-limits item 2.
const fieldPorts = new Map<number, { port: Port; windowId: number }>()
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
      : effect.tabId !== undefined ? fieldPorts.get(effect.tabId)?.port
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
  if (fieldPorts.get(tabId)?.port !== port) return
  const parsed = parsePortMessage(data)
  if (parsed === null) return
  if ('ctl' in parsed) {
    if (parsed.ctl.kind === 'openPanel') {
      // MUST be synchronous — no await before this call. sidePanel.open
      // requires a user gesture, and any microtask hop before it drops the
      // gesture context propagated from the content-script click.
      openPanel(windowId, () => {
        // Only the port that INITIATED this openPanel may receive the
        // failure ctl. sidePanel.open()'s rejection is async — by the time
        // it settles, a same-tab navigation may have superseded this port
        // with a new one under the same tabId. Sending to "whichever port
        // currently occupies fieldPorts.get(tabId)" would mark the
        // REPLACEMENT session failed for an error that belongs to this
        // (now-stale) one, so compare identity against the captured `port`
        // closure variable rather than re-reading the map by tabId alone.
        if (fieldPorts.get(tabId)?.port === port) {
          postSafely(port, { ctl: { kind: 'status', phase: 'error', findingCount: 0 } })
        }
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
    const existing = fieldPorts.get(tabId)
    if (existing && existing.port !== port) {
      // An idle scout can open a new port for this tab (hover, before it has
      // sent any fieldConnected of its own — e.g. same-tab navigation) BEFORE
      // the old port's onDisconnect fires — no ordering guarantee between a
      // new port's onConnect and an old port's onDisconnect. The old port's
      // eventual disconnect is then identity-ignored below (fieldPorts
      // already points at the new port), so its fieldPortGone effects
      // (clearing the stale field, notifying the panel, clearing the badge)
      // must run HERE, before the new port is stored, or the registry keeps
      // the OLD field connected forever — the panel would show it as still
      // connected until the user manually reconnects.
      //
      // Copilot round 3, L1: this must clear the registry under the OLD
      // port's OWN windowId (existing.windowId), not the new port's — a tab
      // dragged into another window between the old port opening and this
      // replacement connecting has its stale field stored under the OLD
      // window's WindowState, which the NEW port's windowId would never
      // reach, leaving a ghost entry there forever.
      execute(registry.fieldPortGone(existing.windowId, tabId))
    }
    fieldPorts.set(tabId, { port, windowId })
    port.onMessage.addListener((data) => handleFieldMessage(tabId, windowId, port, data))
    port.onDisconnect.addListener(() => {
      // Guard against a stale disconnect: same-tab navigation can connect a
      // NEW port and re-register it under this tabId before the OLD port's
      // onDisconnect fires (no ordering guarantee between those events). If
      // the map no longer points at THIS port, it was already superseded —
      // the disconnect of a superseded port must be a complete no-op, never
      // evicting the live port or wiping a still-connected field.
      if (fieldPorts.get(tabId)?.port !== port) return
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
