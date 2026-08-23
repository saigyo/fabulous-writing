import { describe, expect, it } from 'vitest'
import type {
  Envelope, FieldConnectedMessage, FieldDisconnectedMessage,
  MarkingClickedMessage, ReplaceResultMessage, SelectFindingMessage,
  StatusMessage, TextChangedMessage,
} from '../../../frontend/src/embed/protocol'
import { Registry } from './registry'

const W = 1
const TAB_A = 10
const TAB_B = 20

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

function replaceResult(fieldId: string): Envelope<ReplaceResultMessage> {
  return { fw: 1, type: 'replaceResult', requestId: 'r1', payload: { fieldId, ok: true, text: 'new' } }
}

function markingClicked(fieldId: string, id: string): Envelope<MarkingClickedMessage> {
  return { fw: 1, type: 'markingClicked', payload: { fieldId, id } }
}

function fieldDisconnected(fieldId: string): Envelope<FieldDisconnectedMessage> {
  return { fw: 1, type: 'fieldDisconnected', payload: { fieldId } }
}

function status(phase: StatusMessage['payload']['phase'], findingCount: number): Envelope<StatusMessage> {
  return { fw: 1, type: 'status', payload: { phase, findingCount } }
}

function selectFinding(fieldId: string, id: string | null): Envelope<SelectFindingMessage> {
  return { fw: 1, type: 'selectFinding', payload: { fieldId, id } }
}

describe('Registry — rule 1: fieldConnected', () => {
  it('cross-tab replace emits a detach to the old tab with the old fieldId', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.fieldConnected(W, TAB_B, fieldConnected('f2'))
    expect(effects).toEqual([
      { kind: 'send', to: 'oldField', windowId: W, tabId: TAB_A, message: { ctl: { kind: 'detach', fieldId: 'f1' } } },
      { kind: 'badge', tabId: TAB_A, text: '' },
    ])
  })

  it('same-tab reconnect with a new fieldId emits no detach effect, but still clears the old ' +
    'field\'s badge (Critical-1 regression pin; Copilot round 7, F2)', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.fieldConnected(W, TAB_A, fieldConnected('f2'))
    expect(effects).toEqual([{ kind: 'badge', tabId: TAB_A, text: '' }])
  })

  it('relays to the panel when the panel is ready', () => {
    const registry = new Registry()
    registry.panelReady(W, true)
    const msg = fieldConnected('f1')
    const effects = registry.fieldConnected(W, TAB_A, msg)
    expect(effects).toEqual([
      { kind: 'send', to: 'panel', windowId: W, message: { relay: msg } },
    ])
  })

  it('cross-tab replace while the panel is not ready: detach only, nothing to panel; ' +
    'a later panelReady(true) synthesizes the NEW field', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1', 'old text'))
    const newMsg = fieldConnected('f2', 'new text')
    const replaceEffects = registry.fieldConnected(W, TAB_B, newMsg)
    expect(replaceEffects).toEqual([
      { kind: 'send', to: 'oldField', windowId: W, tabId: TAB_A, message: { ctl: { kind: 'detach', fieldId: 'f1' } } },
      { kind: 'badge', tabId: TAB_A, text: '' },
    ])
    const readyEffects = registry.panelReady(W, true)
    expect(readyEffects).toEqual([
      { kind: 'send', to: 'panel', windowId: W, message: { relay: newMsg } },
    ])
  })
})

describe('Registry — rule 2: textChanged', () => {
  it('relays to the panel when ready', () => {
    const registry = new Registry()
    registry.panelReady(W, true)
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const msg = textChanged('f1', 'updated')
    const effects = registry.textChanged(W, TAB_A, msg)
    expect(effects).toEqual([
      { kind: 'send', to: 'panel', windowId: W, message: { relay: msg } },
    ])
  })

  it('does not relay when the panel is not ready', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.textChanged(W, TAB_A, textChanged('f1', 'updated'))
    expect(effects).toEqual([])
  })

  it('drops messages from a tab that is not the connected tab of its window', () => {
    const registry = new Registry()
    registry.panelReady(W, true)
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.textChanged(W, TAB_B, textChanged('stale', 'stale text'))
    expect(effects).toEqual([])
  })
})

describe('Registry — rule 3: hostRelay', () => {
  it('relays replaceResult/markingClicked when the sender is the connected tab and panel is ready', () => {
    const registry = new Registry()
    registry.panelReady(W, true)
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const msg = replaceResult('f1')
    const effects = registry.hostRelay(W, TAB_A, msg)
    expect(effects).toEqual([
      { kind: 'send', to: 'panel', windowId: W, message: { relay: msg } },
    ])
  })

  it('drops when the sender is not the connected tab', () => {
    const registry = new Registry()
    registry.panelReady(W, true)
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.hostRelay(W, TAB_B, markingClicked('other', 'm1'))
    expect(effects).toEqual([])
  })

  it('drops when the panel is not ready', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.hostRelay(W, TAB_A, markingClicked('f1', 'm1'))
    expect(effects).toEqual([])
  })

  it('fieldDisconnected clears the entry, relays to the panel (if ready), and clears the badge', () => {
    const registry = new Registry()
    registry.panelReady(W, true)
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const msg = fieldDisconnected('f1')
    const effects = registry.hostRelay(W, TAB_A, msg)
    expect(effects).toEqual([
      { kind: 'send', to: 'panel', windowId: W, message: { relay: msg } },
      { kind: 'badge', tabId: TAB_A, text: '' },
    ])
    // the entry is cleared: a later textChanged from that tab is dropped
    expect(registry.textChanged(W, TAB_A, textChanged('f1', 'more'))).toEqual([])
  })

  it('fieldDisconnected without a ready panel still clears the badge but does not relay', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.hostRelay(W, TAB_A, fieldDisconnected('f1'))
    expect(effects).toEqual([{ kind: 'badge', tabId: TAB_A, text: '' }])
  })
})

describe('Registry — rule 4: panelReady', () => {
  it('duplicate panelReady(true) does not re-synthesize', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const first = registry.panelReady(W, true)
    expect(first).toHaveLength(1)
    const second = registry.panelReady(W, true)
    expect(second).toEqual([])
  })

  it('synthesizes a fresh fieldConnected from stored state, including the latest text', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1', 'initial'))
    registry.textChanged(W, TAB_A, textChanged('f1', 'latest text'))
    const effects = registry.panelReady(W, true)
    expect(effects).toEqual([{
      kind: 'send',
      to: 'panel',
      windowId: W,
      message: {
        relay: {
          fw: 1,
          type: 'fieldConnected',
          payload: {
            fieldId: 'f1',
            text: 'latest text',
            capabilities: { mark: 'overlay', replace: 'reliable' },
            meta: { url: 'https://example.com', fieldKind: 'textarea' },
          },
        },
      },
    }])
  })

  it('panelReady(false) marks not ready and keeps field state', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    registry.panelReady(W, true)
    expect(registry.panelReady(W, false)).toEqual([])
    // field state survives: a later panelReady(true) re-synthesizes
    const effects = registry.panelReady(W, true)
    expect(effects).toHaveLength(1)
  })

  it('no-op when there is no connected field', () => {
    const registry = new Registry()
    expect(registry.panelReady(W, true)).toEqual([])
  })
})

describe('Registry — rule 5: embedRelay', () => {
  it('status yields a badge effect and a ctl-status send, never a raw relay of the status envelope', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.embedRelay(W, status('checking', 3))
    expect(effects).toEqual([
      { kind: 'badge', tabId: TAB_A, text: '3' },
      // M3 (closing sweep): fieldId scopes the ctl to the field that is
      // CURRENT at the time this status arrives.
      { kind: 'send', to: 'field', windowId: W, tabId: TAB_A, message: { ctl: { kind: 'status', phase: 'checking', findingCount: 3, fieldId: 'f1' } } },
    ])
    expect(effects.some((e) => e.kind === 'send' && 'message' in e && 'relay' in e.message)).toBe(false)
  })

  it('badge-cleared-on-zero: findingCount 0 clears the badge text', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.embedRelay(W, status('idle', 0))
    expect(effects[0]).toEqual({ kind: 'badge', tabId: TAB_A, text: '' })
  })

  // Copilot round 4 (closing sweep), F1: badge/ctl-status effects fire only
  // while the window has a LIVE field. The disconnect paths themselves
  // (hostRelay's fieldDisconnected, fieldPortGone, fieldConnected's
  // cross-tab replace branch — each pinned in its own describe block above)
  // already emit the immediate badge clear; a trailing status for a
  // now-fieldless window must not emit anything at all.
  it('a fieldless status after disconnect emits no badge effect (F1 regression pin)', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    registry.fieldPortGone(W, TAB_A)
    const effects = registry.embedRelay(W, status('idle', 0))
    expect(effects).toEqual([])
  })

  it('field disconnects in window 1, tab reconnects in window 2: a late fieldless status in ' +
    'window 1 emits no badge effect on the tab now owned by window 2 (F1 regression pin)', () => {
    const registry = new Registry()
    const W2 = 2
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    registry.fieldPortGone(W, TAB_A)
    // The tab reconnects in a different window and gets a live finding count.
    registry.fieldConnected(W2, TAB_A, fieldConnected('f1'))
    const liveEffects = registry.embedRelay(W2, status('checking', 3))
    expect(liveEffects).toEqual([
      { kind: 'badge', tabId: TAB_A, text: '3' },
      { kind: 'send', to: 'field', windowId: W2, tabId: TAB_A, message: { ctl: { kind: 'status', phase: 'checking', findingCount: 3, fieldId: 'f1' } } },
    ])
    // A late status delivered to the OLD window's now-fieldless entry must
    // not wipe the badge window 2 just painted.
    const staleEffects = registry.embedRelay(W, status('idle', 0))
    expect(staleEffects).toEqual([])
  })

  it('routes non-status embed messages verbatim to the connected tab field port', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const msg = selectFinding('f1', 'm1')
    const effects = registry.embedRelay(W, msg)
    expect(effects).toEqual([
      { kind: 'send', to: 'field', windowId: W, tabId: TAB_A, message: { relay: msg } },
    ])
  })

  it('drops non-status embed messages when there is no field connected', () => {
    const registry = new Registry()
    const effects = registry.embedRelay(W, selectFinding('f1', null))
    expect(effects).toEqual([])
  })
})

describe('Registry — rule 6: fieldPortGone', () => {
  it('clears the entry, emits a synthesized fieldDisconnected to the panel (if ready), and clears the badge', () => {
    const registry = new Registry()
    registry.panelReady(W, true)
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.fieldPortGone(W, TAB_A)
    expect(effects).toEqual([
      { kind: 'send', to: 'panel', windowId: W, message: { relay: fieldDisconnected('f1') } },
      { kind: 'badge', tabId: TAB_A, text: '' },
    ])
  })

  it('is a no-op for a tab that is not the connected tab', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.fieldPortGone(W, TAB_B)
    expect(effects).toEqual([])
  })

  it('does not relay when the panel is not ready, but still clears the badge', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.fieldPortGone(W, TAB_A)
    expect(effects).toEqual([{ kind: 'badge', tabId: TAB_A, text: '' }])
  })
})

describe('Registry — panelPortGone', () => {
  it('marks the window not-ready so a later panelReady(true) re-synthesizes', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    registry.panelReady(W, true)
    registry.panelPortGone(W)
    const effects = registry.panelReady(W, true)
    expect(effects).toHaveLength(1)
  })
})

// The panel's Disconnect button (live-test UX decision, B43 C2 PR #139).
describe('Registry — disconnectRequested', () => {
  it('routes a ctl disconnect to the tab holding the connected field', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    const effects = registry.disconnectRequested(W)
    expect(effects).toEqual([
      { kind: 'send', to: 'field', windowId: W, tabId: TAB_A, message: { ctl: { kind: 'disconnect' } } },
    ])
  })

  it('is a no-op when the window has no connected field', () => {
    const registry = new Registry()
    expect(registry.disconnectRequested(W)).toEqual([])
  })

  it('is a no-op for a window the registry has never seen', () => {
    const registry = new Registry()
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    expect(registry.disconnectRequested(999)).toEqual([])
  })
})

// Issue #142: changing the extension's server URL must hard-disconnect
// every window's connected field — never keep state that could later flow a
// field's text to a newly configured server without an explicit reconnect.
describe('Registry — serverChanged', () => {
  it('detaches and clears the badge for every window with a connected field; windows without ' +
    'a field contribute nothing; all field state is wiped', () => {
    const registry = new Registry()
    const W2 = 2
    registry.fieldConnected(W, TAB_A, fieldConnected('f1'))
    registry.panelReady(W2, true) // window with no connected field
    const effects = registry.serverChanged()
    expect(effects).toEqual([
      { kind: 'send', to: 'field', windowId: W, tabId: TAB_A, message: { ctl: { kind: 'detach', fieldId: 'f1' } } },
      { kind: 'badge', tabId: TAB_A, text: '' },
    ])
    // field state is gone: subsequent traffic from the (now-stale) tab drops
    expect(registry.textChanged(W, TAB_A, textChanged('f1', 'more'))).toEqual([])
    expect(registry.embedRelay(W, selectFinding('f1', null))).toEqual([])
  })

  it('is a no-op when no window has a connected field', () => {
    const registry = new Registry()
    expect(registry.serverChanged()).toEqual([])
  })
})
