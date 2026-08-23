// sw.ts registers its browser.runtime.onConnect listener once, at import
// time, and keeps its port bookkeeping (fieldPorts/panelPorts) and the
// Registry instance as module-scoped singletons — so every test below uses
// its own windowId/tabId to stay isolated within this file.
import { describe, expect, it } from 'vitest'
import type {
  Envelope, FieldConnectedMessage, SelectFindingMessage, TextChangedMessage,
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

  it('a stale panel-port disconnect (arriving after a reconnect for the same window) does not ' +
    'evict the new port or mark the window not-ready', () => {
    const W = 303
    const T = 404

    const panelA = connectPanel(W)
    const field = connectField(T, W)
    field.onMessage.emit({ relay: fieldConnected('f1') })
    expect(panelA.postMessage).toHaveBeenCalledTimes(1)

    // A new panel port reconnects for the same window (panel closed and
    // reopened) before panelA's onDisconnect fires. The window is already
    // marked ready, so embedReady(true) here is correctly a no-op (rule 4)
    // — what must move to panelB is the port-map entry.
    const panelB = createMockPort('panel')
    browserMock.runtime.onConnect.emit(panelB)
    panelB.onMessage.emit({ ctl: { kind: 'panelHello', windowId: W } })
    panelB.onMessage.emit({ ctl: { kind: 'embedReady', ready: true } })
    expect(panelB.postMessage).not.toHaveBeenCalled()

    // The OLD panel port's disconnect arrives late.
    panelA.onDisconnect.emit(panelA)

    // The window must still be marked ready and routed to panelB, not
    // silently dropped as "not ready".
    const msg = textChanged('f1', 'more')
    field.onMessage.emit({ relay: msg })
    expect(panelB.postMessage).toHaveBeenCalledTimes(1)
    expect(panelB.postMessage).toHaveBeenCalledWith({ relay: msg })
  })
})
