// The service worker: wires real browser.runtime ports to the pure Registry
// (registry.ts) and to the Chromium-only panelHost abstraction. Direction is
// discriminated BY PORT NAME — 'field' ports are opened by the content-script
// scout (Task 7), 'panel' ports by the side panel (Task 8) — never by
// inspecting message content.
//
// Accepted v1 limits (both apply to the Registry instance below):
// 1. The registry is entirely in-memory. This is ACCEPTED for v1 because
//    Chrome >= 116 (this extension's own manifest `minimum_chrome_version`)
//    keeps a service worker alive for as long as any runtime port stays
//    connected — so state is lost only on an extension update or a SW crash,
//    not on routine idle-suspend/wake. The recovery path for that loss is the
//    scout's reconnect-on-next-interaction (Task 7); a
//    `chrome.storage.session`-backed registry is a later hardening.
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

function handleFieldMessage(tabId: number, windowId: number, data: unknown): void {
  const parsed = parsePortMessage(data)
  if (parsed === null) return
  if ('ctl' in parsed) {
    if (parsed.ctl.kind === 'openPanel') {
      // MUST be synchronous — no await before this call. sidePanel.open
      // requires a user gesture, and any microtask hop before it drops the
      // gesture context propagated from the content-script click.
      openPanel(windowId, () => {
        const port = fieldPorts.get(tabId)
        if (port) postSafely(port, { ctl: { kind: 'status', phase: 'error', findingCount: 0 } })
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
      state.windowId = parsed.ctl.windowId
      panelPorts.set(state.windowId, port)
      return
    }
    if (parsed.ctl.kind === 'embedReady' && state.windowId !== null) {
      execute(registry.panelReady(state.windowId, parsed.ctl.ready))
    }
    return
  }
  if (state.windowId !== null) {
    // Panel ports carry only embed->sw envelopes — see the module comment.
    execute(registry.embedRelay(state.windowId, parsed.relay as Envelope<EmbedMessage>))
  }
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
    port.onMessage.addListener((data) => handleFieldMessage(tabId, windowId, data))
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
