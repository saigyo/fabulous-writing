// sw.ts registers its browser.runtime.onConnect listener once, at import
// time, and keeps its port bookkeeping (fieldPorts/panelPorts) and the
// Registry instance as module-scoped singletons — so every test below uses
// its own windowId/tabId to stay isolated within this file.
import { describe, expect, it } from 'vitest'
import type {
  Envelope, FieldConnectedMessage, FieldDisconnectedMessage, SelectFindingMessage, TextChangedMessage,
} from '../../../frontend/src/embed/protocol'
import { browserMock, createMockPort, type MockPort } from './testing/browserMock'
import './sw'

function fieldConnected(fieldId: string, text = 'hello'): Envelope<FieldConnectedMessage> {
  return {
    fw: 1,
    type: 'fieldConnected',
    payload: {
      fieldId,
      text,
      capabilities: { mark: 'overlay', replace: 'reliable' },
      meta: { url: 'https://example.com', fieldKind: 'textarea' },
    },
  }
}

function fieldDisconnected(fieldId: string): Envelope<FieldDisconnectedMessage> {
  return { fw: 1, type: 'fieldDisconnected', payload: { fieldId } }
}

function textChanged(fieldId: string, text: string): Envelope<TextChangedMessage> {
  return { fw: 1, type: 'textChanged', payload: { fieldId, text } }
}

function selectFinding(fieldId: string, id: string | null): Envelope<SelectFindingMessage> {
  return { fw: 1, type: 'selectFinding', payload: { fieldId, id } }
}

function connectPanel(windowId: number): MockPort {
  const port = createMockPort('panel')
  browserMock.runtime.onConnect.emit(port)
  port.onMessage.emit({ ctl: { kind: 'panelHello', windowId } })
  port.onMessage.emit({ ctl: { kind: 'embedReady', ready: true } })
  return port
}

function connectField(tabId: number, windowId: number): MockPort {
  const port = createMockPort('field', { tab: { id: tabId, windowId } })
  browserMock.runtime.onConnect.emit(port)
  return port
}

describe('sw.ts — port bookkeeping', () => {
  it('a stale field-port disconnect (arriving after a same-tab reconnect) does not evict the ' +
    'new port or wipe the still-connected field', () => {
    const W = 101
    const T = 202
    const panelPort = connectPanel(W)

    const portA = connectField(T, W)
    portA.onMessage.emit({ relay: fieldConnected('f1') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(1)

    // A new content-script port connects under the SAME tabId (same-tab
    // navigation) and re-registers before portA's onDisconnect fires — no
    // ordering guarantee between those two browser events.
    const portB = connectField(T, W)
    portB.onMessage.emit({ relay: fieldConnected('f2') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)

    // The OLD port's disconnect arrives late.
    portA.onDisconnect.emit(portA)

    // No spurious fieldDisconnected/badge synthesis from the stale event.
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)

    // portB is still tracked in fieldPorts: a message routed FROM the panel
    // TO the field must still reach it.
    const toField = selectFinding('f2', 'm1')
    panelPort.onMessage.emit({ relay: toField })
    expect(portB.postMessage).toHaveBeenCalledWith({ relay: toField })

    // And the registry still has the field connected: portB's own traffic
    // still relays to the panel.
    portB.onMessage.emit({ relay: textChanged('f2', 'more text') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(3)
  })

  // Copilot round 1, F1: onDisconnect's identity guard alone isn't enough —
  // the OLD port's onMessage listener is still live and can deliver a late
  // message (not just a late disconnect) after a new port has already
  // re-registered under the same tabId.
  it('a stale field port\'s late message is dropped once a new port has re-registered under the ' +
    'same tabId, so it cannot wipe the field the new port just registered', () => {
    const W = 111
    const T = 212
    const panelPort = connectPanel(W)

    const portA = connectField(T, W)
    portA.onMessage.emit({ relay: fieldConnected('f1') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(1)

    // Same-tab navigation: a new port re-registers under T before portA's
    // onDisconnect (or even any disconnect at all) fires.
    const portB = connectField(T, W)
    portB.onMessage.emit({ relay: fieldConnected('f2') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)

    // portA delivers a late fieldDisconnected. Must be dropped silently —
    // NOT relayed to the panel, and must not clear the registry's field
    // (which is now f2, registered by portB).
    portA.onMessage.emit({ relay: fieldDisconnected('f1') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)

    // The registry still has f2 connected: portB's own traffic still relays.
    portB.onMessage.emit({ relay: textChanged('f2', 'more text') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(3)
  })

  it('a stale panel-port disconnect (arriving after a reconnect for the same window) does not ' +
    'evict the new port', () => {
    const W = 303
    const T = 404

    const panelA = connectPanel(W)
    const field = connectField(T, W)
    field.onMessage.emit({ relay: fieldConnected('f1') })
    expect(panelA.postMessage).toHaveBeenCalledTimes(1)

    // Copilot round 1, F2: a new panel port reconnects for the same window
    // (panel closed and reopened) before panelA's onDisconnect fires. panelA
    // is still registered when panelB's panelHello arrives, so this hello
    // must reset the window to not-ready BEFORE panelB's own embedReady(true)
    // runs — otherwise embedReady(true) hits rule 4's duplicate no-op and
    // never synthesizes the fieldConnected panelB needs to render the
    // already-connected field.
    const panelB = createMockPort('panel')
    browserMock.runtime.onConnect.emit(panelB)
    panelB.onMessage.emit({ ctl: { kind: 'panelHello', windowId: W } })
    panelB.onMessage.emit({ ctl: { kind: 'embedReady', ready: true } })
    expect(panelB.postMessage).toHaveBeenCalledExactlyOnceWith({ relay: fieldConnected('f1') })

    // The OLD panel port's disconnect arrives late — must be a no-op, not
    // evict panelB's entry or mark the window not-ready.
    panelA.onDisconnect.emit(panelA)

    const msg = textChanged('f1', 'more')
    field.onMessage.emit({ relay: msg })
    expect(panelB.postMessage).toHaveBeenCalledTimes(2)
    expect(panelB.postMessage).toHaveBeenNthCalledWith(2, { relay: msg })
  })

  // Copilot round 1, F3: same family as F1, for panel ports — a stale panel
  // port's onMessage listener is still live after being superseded and must
  // not affect the live panel's state.
  it('a stale panel port\'s late embedReady(false) after replacement does not affect the new ' +
    'panel\'s readiness', () => {
    const W = 505
    const T = 606

    const panelA = connectPanel(W)
    const field = connectField(T, W)
    field.onMessage.emit({ relay: fieldConnected('f1') })
    expect(panelA.postMessage).toHaveBeenCalledTimes(1)

    const panelB = createMockPort('panel')
    browserMock.runtime.onConnect.emit(panelB)
    panelB.onMessage.emit({ ctl: { kind: 'panelHello', windowId: W } })
    panelB.onMessage.emit({ ctl: { kind: 'embedReady', ready: true } })
    expect(panelB.postMessage).toHaveBeenCalledTimes(1)

    // panelA is now stale (superseded by panelB, never disconnected). A late
    // embedReady(false) from panelA must be dropped, not tear down panelB's
    // readiness.
    panelA.onMessage.emit({ ctl: { kind: 'embedReady', ready: false } })

    const msg = textChanged('f1', 'more')
    field.onMessage.emit({ relay: msg })
    expect(panelB.postMessage).toHaveBeenCalledTimes(2)
    expect(panelB.postMessage).toHaveBeenNthCalledWith(2, { relay: msg })
  })
})
