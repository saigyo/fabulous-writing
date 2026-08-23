// sw.ts registers its browser.runtime.onConnect listener once, at import
// time, and keeps its port bookkeeping (fieldPorts/panelPorts) and the
// Registry instance as module-scoped singletons — so every test below uses
// its own windowId/tabId to stay isolated within this file.
import { describe, expect, it } from 'vitest'
import type {
  Envelope, FieldConnectedMessage, FieldDisconnectedMessage, SelectFindingMessage, TextChangedMessage,
} from '../../../frontend/src/embed/protocol'
import { browserMock, createMockPort, type MockPort } from './testing/browserMock'
import { chromeMock } from './testing/chromeMock'
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
    // ordering guarantee between those two browser events. S1 fix: this
    // connect itself now synthesizes an immediate fieldDisconnected for the
    // stale f1 (a fieldPortGone effect run before the new port is stored),
    // so the panel sees that BEFORE portB's own fieldConnected.
    const portB = connectField(T, W)
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)
    portB.onMessage.emit({ relay: fieldConnected('f2') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(3)

    // The OLD port's disconnect arrives late.
    portA.onDisconnect.emit(portA)

    // No spurious fieldDisconnected/badge synthesis from the stale event.
    expect(panelPort.postMessage).toHaveBeenCalledTimes(3)

    // portB is still tracked in fieldPorts: a message routed FROM the panel
    // TO the field must still reach it.
    const toField = selectFinding('f2', 'm1')
    panelPort.onMessage.emit({ relay: toField })
    expect(portB.postMessage).toHaveBeenCalledWith({ relay: toField })

    // And the registry still has the field connected: portB's own traffic
    // still relays to the panel.
    portB.onMessage.emit({ relay: textChanged('f2', 'more text') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(4)
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
    // onDisconnect (or even any disconnect at all) fires. S1 fix: this
    // connect itself now synthesizes an immediate fieldDisconnected for the
    // stale f1 before portB's own fieldConnected.
    const portB = connectField(T, W)
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)
    portB.onMessage.emit({ relay: fieldConnected('f2') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(3)

    // portA delivers a late fieldDisconnected. Must be dropped silently —
    // NOT relayed to the panel, and must not clear the registry's field
    // (which is now f2, registered by portB).
    portA.onMessage.emit({ relay: fieldDisconnected('f1') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(3)

    // The registry still has f2 connected: portB's own traffic still relays.
    portB.onMessage.emit({ relay: textChanged('f2', 'more text') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(4)
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

  // Copilot round 2, S1: the scout opens its port on hover, before it has
  // sent any fieldConnected of its own — so a same-tab navigation can
  // register a NEW, still-idle port for the same tabId before the OLD port's
  // onDisconnect fires. Without evicting the stale field the moment the new
  // port registers, the registry would keep the OLD field connected forever
  // (the old port's late disconnect is identity-ignored, same as the tests
  // above), stranding the panel on a field that's actually gone.
  it('an idle replacement port connecting before any fieldConnected evicts the stale field immediately: panel gets fieldDisconnected, badge clears, registry has no field, and the old port\'s late disconnect stays a no-op', () => {
    const W = 909
    const T = 1010
    const panelPort = connectPanel(W)

    const portA = connectField(T, W)
    portA.onMessage.emit({ relay: fieldConnected('f1') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(1)

    // Same-tab navigation opens a NEW, still-idle port under the same
    // tabId — no fieldConnected sent yet.
    const portB = connectField(T, W)

    // The stale field must be evicted the moment portB registers, not left
    // dangling until portA's disconnect eventually (if ever) arrives.
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)
    expect(panelPort.postMessage).toHaveBeenNthCalledWith(2, { relay: fieldDisconnected('f1') })
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ tabId: T, text: '' })

    // The registry has no field at all right now: a message that would only
    // relay if w.field were (wrongly) still set to the old field is dropped.
    portB.onMessage.emit({ relay: textChanged('f1', 'still stale?') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)

    // portA's late disconnect is a complete no-op: fieldPorts already points
    // at portB.
    portA.onDisconnect.emit(portA)
    expect(panelPort.postMessage).toHaveBeenCalledTimes(2)

    // portB can still register its own field normally afterward.
    portB.onMessage.emit({ relay: fieldConnected('f2') })
    expect(panelPort.postMessage).toHaveBeenCalledTimes(3)
    expect(panelPort.postMessage).toHaveBeenNthCalledWith(3, { relay: fieldConnected('f2') })
  })

  // Copilot round 3, L1: a tab dragged into another browser window between
  // its field port opening and a replacement port connecting used to leave a
  // GHOST field behind — the idle-port replacement branch cleared the
  // registry using the NEW port's windowId, but the stale field was stored
  // under the OLD window. fieldPorts now tracks each port's own connect-time
  // windowId, so the replacement clears the OLD window's entry correctly.
  it('a window-moved tab\'s idle replacement port evicts the stale field from the OLD window, ' +
    'not the new one', () => {
    const W1 = 1313
    const W2 = 1414
    const T = 1515
    const panel1 = connectPanel(W1)
    const panel2 = connectPanel(W2)

    const portA = connectField(T, W1)
    portA.onMessage.emit({ relay: fieldConnected('f1') })
    expect(panel1.postMessage).toHaveBeenCalledTimes(1)
    expect(panel2.postMessage).toHaveBeenCalledTimes(0)

    // The tab is dragged into window 2 before portA reconnects; a fresh idle
    // port then connects under the SAME tabId, reporting the NEW windowId.
    const portB = connectField(T, W2)

    // Window 1's panel gets the fieldDisconnected + badge clear for the
    // ghost; window 2's panel gets nothing (no field registered there yet).
    expect(panel1.postMessage).toHaveBeenCalledTimes(2)
    expect(panel1.postMessage).toHaveBeenNthCalledWith(2, { relay: fieldDisconnected('f1') })
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ tabId: T, text: '' })
    expect(panel2.postMessage).toHaveBeenCalledTimes(0)

    // Window 1's registry state has no field left under it at all.
    portB.onMessage.emit({ relay: textChanged('f1', 'still stale?') })
    expect(panel1.postMessage).toHaveBeenCalledTimes(2)

    // portB can register its own field normally, routed to window 2's panel.
    portB.onMessage.emit({ relay: fieldConnected('f2') })
    expect(panel2.postMessage).toHaveBeenCalledTimes(1)
    expect(panel2.postMessage).toHaveBeenNthCalledWith(1, { relay: fieldConnected('f2') })
  })

  // Copilot round 2, S3: openPanel's sidePanel.open() rejection is async — by
  // the time it settles, a same-tab navigation may have superseded the
  // originating port with a new one for the same tabId. The failure ctl must
  // only ever reach the port that actually initiated the (now-failed)
  // openPanel call, never "whichever port currently occupies fieldPorts for
  // this tab".
  it('a superseded port\'s openPanel rejection does not deliver an error ctl to the replacement port (or the stale one)', async () => {
    const W = 1111
    const T = 1212
    connectPanel(W)
    const portA = connectField(T, W)
    chromeMock.sidePanel.open.mockImplementationOnce(() => Promise.reject(new Error('boom')))
    portA.onMessage.emit({ ctl: { kind: 'openPanel' } })

    // Same-tab navigation supersedes portA before its openPanel rejection
    // has had a chance to settle.
    const portB = connectField(T, W)

    // Flush the rejected promise's microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const errorCtl = { ctl: { kind: 'status', phase: 'error', findingCount: 0 } }
    expect(portB.postMessage).not.toHaveBeenCalledWith(errorCtl)
    expect(portA.postMessage).not.toHaveBeenCalledWith(errorCtl)
  })
})
