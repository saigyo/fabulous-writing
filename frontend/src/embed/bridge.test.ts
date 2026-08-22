// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../state/store'
import { clientTag, setClientTag } from '../checking/clientTag'
import { startBridge as startBridgeRaw } from './bridge'
import { PROTOCOL_VERSION } from './protocol'
import type { HostCapabilities, HostMessage, MarkingSpan } from './protocol'
import type { HostDoc } from './hostDoc'
import type { Bridge } from './bridge'

const CAPS: HostCapabilities = { mark: 'overlay', replace: 'reliable' }

// Every test's window 'message' listener must be torn down before the next
// test dispatches — otherwise a prior test's still-attached (and unpinned)
// bridge would race to pin itself on a later test's hello. Track every
// bridge created via startBridge() below and dispose them all afterEach.
let activeBridges: Bridge[] = []
function startBridge(): Bridge {
  const bridge = startBridgeRaw()
  activeBridges.push(bridge)
  return bridge
}
afterEach(() => {
  for (const bridge of activeBridges) bridge.dispose()
  activeBridges = []
})

interface StubHostDoc extends HostDoc {
  fieldConnectedCalls: {
    fieldId: string
    text: string
    capabilities: HostCapabilities
    meta?: { url: string; fieldKind: string }
  }[]
  textChangedCalls: { fieldId: string; text: string }[]
  replaceResultCalls: { requestId: string; ok: boolean; text: string; fieldId: string }[]
  fieldDisconnectedCalls: string[]
  selectFindingCalls: (string | null)[]
  markingClickedCalls: { fieldId: string; id: string }[]
}

function stubHostDoc(): StubHostDoc {
  const fieldConnectedCalls: StubHostDoc['fieldConnectedCalls'] = []
  const textChangedCalls: StubHostDoc['textChangedCalls'] = []
  const replaceResultCalls: StubHostDoc['replaceResultCalls'] = []
  const fieldDisconnectedCalls: string[] = []
  const selectFindingCalls: (string | null)[] = []
  const markingClickedCalls: StubHostDoc['markingClickedCalls'] = []
  return {
    fieldConnectedCalls,
    textChangedCalls,
    replaceResultCalls,
    fieldDisconnectedCalls,
    selectFindingCalls,
    markingClickedCalls,
    hasDocument: () => true,
    connected: () => true,
    capabilities: () => CAPS,
    getText: () => '',
    setDocument: () => {},
    currentFinding: () => null,
    serverSpan: () => null,
    mergeFindings: () => {},
    applySuggestion: () => Promise.resolve('not-found'),
    applyRewrite: () => Promise.resolve('not-found'),
    fieldConnected(fieldId, text, capabilities, meta) {
      fieldConnectedCalls.push({ fieldId, text, capabilities, meta })
    },
    fieldDisconnected(fieldId) {
      fieldDisconnectedCalls.push(fieldId)
    },
    textChanged(fieldId, text) {
      textChangedCalls.push({ fieldId, text })
    },
    replaceResult(requestId, ok, text, fieldId) {
      replaceResultCalls.push({ requestId, ok, text, fieldId })
    },
    selectFinding(id) {
      selectFindingCalls.push(id)
    },
    markingClicked(fieldId, id) {
      markingClickedCalls.push({ fieldId, id })
    },
    resetSession() {},
    republish() {},
    activateSession() {},
  }
}

function fakeSource(): Window {
  return { postMessage: vi.fn() } as unknown as Window
}

// The bridge now pins a hello only when it comes from window.parent AND the
// page is actually framed (window.parent !== window) — see bridge.ts's
// handleMessage. jsdom/happy-dom's top-level window has window.parent ===
// window by default, so any test that expects a hello to pin must first
// make window.parent a distinct object and use that same object as the
// dispatched event's source. Restored to the real window (the unframed
// default) in the afterEach below so later tests don't leak an "embedded"
// state.
function embeddedParent(): Window {
  const parent = { postMessage: vi.fn() } as unknown as Window
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
  return parent
}

function dispatchHost(data: unknown, origin: string, source: Window) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
}

// The wire-format envelope for host -> embed messages, mirroring
// protocol.ts's envelope() (which is typed for the opposite direction).
function hostEnvelope<M extends HostMessage>(message: M): M & { fw: number } {
  return { fw: PROTOCOL_VERSION, ...message }
}

function helloMessage(kind = 'simulator') {
  return hostEnvelope({
    type: 'hello' as const,
    payload: { host: { kind, version: '0.0.1' } },
  })
}

const ORIGIN_A = 'https://host-a.example'
const ORIGIN_B = 'https://host-b.example'

afterEach(() => {
  useStore.setState({ tracked: [], checkPhase: 'idle', llmError: null, authStatus: 'authenticated' })
  setClientTag('web') // reset client tag after each test
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
})

describe('startBridge: origin pinning and routing', () => {
  it('ignores a non-hello message before any hello has pinned the host', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = fakeSource()

    dispatchHost(
      hostEnvelope({ type: 'textChanged' as const, payload: { fieldId: 'f1', text: 'hi' } }),
      ORIGIN_A,
      source,
    )

    expect(hostDoc.textChangedCalls).toEqual([])
    expect(source.postMessage).not.toHaveBeenCalled()
  })

  it('pins source/origin on hello and replies with ready on that source/origin', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = embeddedParent()

    dispatchHost(helloMessage(), ORIGIN_A, source)

    // F5: ready, then one initial status message — a cold, unauthenticated
    // panel must be able to show signed-out from the start.
    expect(source.postMessage).toHaveBeenCalledTimes(2)
    const calls = (source.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const [readyPayload, readyOrigin] = calls[0]
    expect(readyPayload).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    expect(readyOrigin).toBe(ORIGIN_A)
    const [statusPayload, statusOrigin] = calls[1]
    expect(statusPayload.type).toBe('status')
    expect(statusOrigin).toBe(ORIGIN_A)
    expect(bridge.hostKind()).toBe('simulator')
  })

  // F6 (final review): a hello with a null source must not half-pin —
  // pinnedOrigin getting set with no matching source is a state that can
  // never complete the handshake (postToHost requires both). This is now
  // subsumed by the parent-only check (event.source === window.parent, and
  // window.parent is never null), but we still dispatch it under an
  // embedded window.parent to prove the null source alone is rejected.
  it('a hello with a null source does not pin, and a later real hello still pins and gets ready', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const parent = embeddedParent()

    dispatchHost(helloMessage(), ORIGIN_A, null as unknown as Window)

    dispatchHost(helloMessage(), ORIGIN_A, parent)

    expect(parent.postMessage).toHaveBeenCalled()
    const [replyPayload] = (parent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(replyPayload).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
  })

  // Security (Copilot round 9): frame-ancestors restricts framing, not
  // WindowProxy access — a hostile popup or sibling frame could still hold
  // a reference to this window and post a hello. Even while embedded
  // (window.parent !== window), only a hello whose source is exactly
  // window.parent may pin.
  it('ignores a hello whose source is not window.parent, even when embedded', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const parent = embeddedParent()
    const impostor = fakeSource() // e.g. a same-origin popup or sibling frame

    dispatchHost(helloMessage(), ORIGIN_A, impostor)

    expect(impostor.postMessage).not.toHaveBeenCalled()
    expect(bridge.hostKind()).toBe('web')

    // The real parent can still pin afterward.
    dispatchHost(helloMessage(), ORIGIN_A, parent)
    expect(parent.postMessage).toHaveBeenCalled()
  })

  // Security (Copilot round 9): when the page is not framed at all
  // (window.parent === window, jsdom/happy-dom's default for a top-level
  // window), no hello is ever accepted — direct navigation to /embed is not
  // a supported host context.
  it('accepts no hello when the page is not framed (window.parent === window)', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = fakeSource()

    dispatchHost(helloMessage(), ORIGIN_A, source)

    expect(source.postMessage).not.toHaveBeenCalled()
    expect(bridge.hostKind()).toBe('web')
  })

  it('drops post-hello messages whose origin differs from the pinned origin', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const pinnedSource = embeddedParent()
    dispatchHost(helloMessage(), ORIGIN_A, pinnedSource)

    const foreignSource = fakeSource()
    dispatchHost(
      hostEnvelope({ type: 'textChanged' as const, payload: { fieldId: 'f1', text: 'hi' } }),
      ORIGIN_B,
      foreignSource,
    )

    expect(hostDoc.textChangedCalls).toEqual([])
  })

  it('routes textChanged from the pinned host to the HostDoc', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = embeddedParent()
    dispatchHost(helloMessage(), ORIGIN_A, source)

    dispatchHost(
      hostEnvelope({ type: 'textChanged' as const, payload: { fieldId: 'f1', text: 'hello world' } }),
      ORIGIN_A,
      source,
    )

    expect(hostDoc.textChangedCalls).toEqual([{ fieldId: 'f1', text: 'hello world' }])
  })

  it('routes fieldConnected, replaceResult, fieldDisconnected, and markingClicked', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = embeddedParent()
    dispatchHost(helloMessage(), ORIGIN_A, source)

    dispatchHost(
      hostEnvelope({
        type: 'fieldConnected' as const,
        payload: { fieldId: 'f1', text: 'abc', capabilities: CAPS, meta: { url: 'u', fieldKind: 'textarea' } },
      }),
      ORIGIN_A,
      source,
    )
    dispatchHost(
      hostEnvelope({
        type: 'replaceResult' as const,
        requestId: 'r1',
        payload: { fieldId: 'f1', ok: true, text: 'abcX' },
      }),
      ORIGIN_A,
      source,
    )
    dispatchHost(
      hostEnvelope({ type: 'markingClicked' as const, payload: { fieldId: 'f1', id: 'finding-1' } }),
      ORIGIN_A,
      source,
    )
    dispatchHost(
      hostEnvelope({ type: 'fieldDisconnected' as const, payload: { fieldId: 'f1' } }),
      ORIGIN_A,
      source,
    )

    expect(hostDoc.fieldConnectedCalls).toEqual([
      { fieldId: 'f1', text: 'abc', capabilities: CAPS, meta: { url: 'u', fieldKind: 'textarea' } },
    ])
    expect(hostDoc.replaceResultCalls).toEqual([{ requestId: 'r1', ok: true, text: 'abcX', fieldId: 'f1' }])
    expect(hostDoc.markingClickedCalls).toEqual([{ fieldId: 'f1', id: 'finding-1' }])
    expect(hostDoc.fieldDisconnectedCalls).toEqual(['f1'])
  })

  // Copilot round 1: the bridge passes the payload's fieldId through
  // unconditionally — it's markingClicked's own field-match guard (hostDoc's
  // job, tested there) that rejects a stale-field click. Here we assert the
  // bridge routes the fieldId it was given, not whatever field is currently
  // connected in the shim.
  it('markingClicked passes the payload fieldId through to hostDoc', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = embeddedParent()
    dispatchHost(helloMessage(), ORIGIN_A, source)

    dispatchHost(
      hostEnvelope({
        type: 'markingClicked' as const,
        payload: { fieldId: 'stale-field', id: 'finding-9' },
      }),
      ORIGIN_A,
      source,
    )

    expect(hostDoc.markingClickedCalls).toEqual([{ fieldId: 'stale-field', id: 'finding-9' }])
  })

  it('sets the client tag on hello', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = embeddedParent()

    dispatchHost(helloMessage('browser-extension'), ORIGIN_A, source)

    expect(clientTag()).toBe('browser-extension')
  })

  it('dispose removes the message listener: a hello after dispose is not answered', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    bridge.dispose()
    const source = fakeSource()

    dispatchHost(helloMessage(), ORIGIN_A, source)

    expect(source.postMessage).not.toHaveBeenCalled()
    expect(bridge.hostKind()).toBe('web')
  })
})

describe('startBridge: hostKind', () => {
  it('defaults to web before any hello arrives', () => {
    const bridge = startBridge()
    expect(bridge.hostKind()).toBe('web')
  })
})

describe('startBridge: outbound', () => {
  it('no-ops until the host is pinned', () => {
    const bridge = startBridge()
    expect(() => {
      bridge.outbound.sendFindings('f1', [])
      bridge.outbound.sendSelectFinding('f1', null)
      bridge.outbound.sendApplyReplacement({
        requestId: 'r1', fieldId: 'f1', from: 0, to: 1, insert: 'x', expectedText: 'y',
      })
      bridge.outbound.onInput()
    }).not.toThrow()
  })

  it('sends through the pinned source/origin once pinned', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = embeddedParent()
    dispatchHost(helloMessage(), ORIGIN_A, source)
    ;(source.postMessage as ReturnType<typeof vi.fn>).mockClear()

    const findings: MarkingSpan[] = [{ id: 'f1', from: 0, to: 3, severity: 'warning', category: 'style' }]
    bridge.outbound.sendFindings('field1', findings)

    expect(source.postMessage).toHaveBeenCalledWith(
      { fw: PROTOCOL_VERSION, type: 'findings', payload: { fieldId: 'field1', findings } },
      ORIGIN_A,
    )
  })

  it('onInput defaults to a no-op and can be replaced by the caller', () => {
    const bridge = startBridge()
    expect(() => bridge.outbound.onInput()).not.toThrow()
    const spy = vi.fn()
    bridge.outbound.onInput = spy
    bridge.outbound.onInput()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('startBridge: status stream', () => {
  beforeEach(() => {
    useStore.setState({ tracked: [], checkPhase: 'idle', llmError: null, authStatus: 'authenticated' })
  })

  function pinnedBridge() {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = embeddedParent()
    dispatchHost(helloMessage(), ORIGIN_A, source)
    ;(source.postMessage as ReturnType<typeof vi.fn>).mockClear()
    return { bridge, source }
  }

  function statusCalls(source: Window) {
    return (source.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([payload]) => payload)
      .filter((p): p is { type: 'status'; payload: { phase: string; findingCount: number } } =>
        (p as { type?: string }).type === 'status')
  }

  it('maps checkPhase fast/llm/else to checking/llm-running/idle', () => {
    const { source } = pinnedBridge()
    useStore.setState({ checkPhase: 'fast' })
    useStore.setState({ checkPhase: 'llm' })
    useStore.setState({ checkPhase: 'idle' })

    const phases = statusCalls(source).map((c) => c.payload.phase)
    expect(phases).toEqual(['checking', 'llm-running', 'idle'])
  })

  it('signed-out wins over the checkPhase mapping', () => {
    const { source } = pinnedBridge()
    useStore.setState({ checkPhase: 'fast', authStatus: 'anonymous' })

    const calls = statusCalls(source)
    expect(calls[calls.length - 1].payload.phase).toBe('signed-out')
  })

  it('llmError present maps to error when authenticated', () => {
    const { source } = pinnedBridge()
    useStore.setState({ llmError: 'boom' })

    const calls = statusCalls(source)
    expect(calls[calls.length - 1].payload.phase).toBe('error')
  })

  it('includes tracked.length as findingCount and only emits on change', () => {
    const { source } = pinnedBridge()
    useStore.setState({ tracked: [] }) // no real change vs. initial -> no emit
    expect(statusCalls(source)).toEqual([])

    useStore.setState({ checkPhase: 'fast' })
    const calls = statusCalls(source)
    expect(calls).toHaveLength(1)
    expect(calls[0].payload.findingCount).toBe(0)
  })
})
