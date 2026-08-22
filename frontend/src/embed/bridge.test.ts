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
  replaceResultCalls: { requestId: string; ok: boolean; text: string }[]
  fieldDisconnectedCalls: string[]
  selectFindingCalls: (string | null)[]
}

function stubHostDoc(): StubHostDoc {
  const fieldConnectedCalls: StubHostDoc['fieldConnectedCalls'] = []
  const textChangedCalls: StubHostDoc['textChangedCalls'] = []
  const replaceResultCalls: StubHostDoc['replaceResultCalls'] = []
  const fieldDisconnectedCalls: string[] = []
  const selectFindingCalls: (string | null)[] = []
  return {
    fieldConnectedCalls,
    textChangedCalls,
    replaceResultCalls,
    fieldDisconnectedCalls,
    selectFindingCalls,
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
    replaceResult(requestId, ok, text) {
      replaceResultCalls.push({ requestId, ok, text })
    },
    selectFinding(id) {
      selectFindingCalls.push(id)
    },
  }
}

function fakeSource(): Window {
  return { postMessage: vi.fn() } as unknown as Window
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
    const source = fakeSource()

    dispatchHost(helloMessage(), ORIGIN_A, source)

    expect(source.postMessage).toHaveBeenCalledTimes(1)
    const [replyPayload, replyOrigin] = (source.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(replyPayload).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    expect(replyOrigin).toBe(ORIGIN_A)
    expect(bridge.hostKind()).toBe('simulator')
  })

  it('drops post-hello messages whose origin differs from the pinned origin', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const pinnedSource = fakeSource()
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
    const source = fakeSource()
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
    const source = fakeSource()
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
    expect(hostDoc.replaceResultCalls).toEqual([{ requestId: 'r1', ok: true, text: 'abcX' }])
    expect(hostDoc.selectFindingCalls).toEqual(['finding-1'])
    expect(hostDoc.fieldDisconnectedCalls).toEqual(['f1'])
  })

  it('sets the client tag on hello', () => {
    const bridge = startBridge()
    const hostDoc = stubHostDoc()
    bridge.attach(hostDoc)
    const source = fakeSource()

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
    const source = fakeSource()
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
    const source = fakeSource()
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
