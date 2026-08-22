// Bridge runtime (spec: B43, "Bridge protocol" / C1 embed surface).
//
// Owns the window 'message' listener: pins the first host that sends a
// valid `hello` (source + origin), routes everything after that to a
// HostDoc, and streams the store's check/auth state out as `status`
// messages. Everything outbound is a no-op until a host is pinned — the
// embed may run standalone (no host ever connects) without erroring.
import { useStore } from '../state/store'
import { envelope, parseHostMessage, PROTOCOL_VERSION } from './protocol'
import type { EmbedMessage, HostMessage } from './protocol'
import type { HostDoc, HostDocOutbound } from './hostDoc'

export interface Bridge {
  /** Outbound sender set — hand to createHostDoc(). No-ops until pinned. */
  outbound: HostDocOutbound
  /** Wire the message routing to a HostDoc and start listening. */
  attach(hostDoc: HostDoc): void
  dispose(): void
  hostKind(): string // 'web' until a hello arrives
}

function statusPhase(state: {
  checkPhase: 'idle' | 'fast' | 'llm'
  authStatus: 'unknown' | 'anonymous' | 'authenticated'
  llmError: string | null
}): 'idle' | 'checking' | 'llm-running' | 'error' | 'signed-out' {
  if (state.authStatus !== 'authenticated') return 'signed-out'
  if (state.llmError) return 'error'
  if (state.checkPhase === 'fast') return 'checking'
  if (state.checkPhase === 'llm') return 'llm-running'
  return 'idle'
}

export function startBridge(): Bridge {
  let pinnedSource: MessageEventSource | null = null
  let pinnedOrigin: string | null = null
  let hostKindValue = 'web'
  let hostDoc: HostDoc | null = null
  let listener: ((event: MessageEvent) => void) | null = null
  let unsubscribeStore: (() => void) | null = null
  let lastStatusKey: string | null = null

  function postToHost(message: EmbedMessage) {
    if (!pinnedSource || !pinnedOrigin) return
    ;(pinnedSource as Window).postMessage(envelope(message), pinnedOrigin)
  }

  function statusKey(state: ReturnType<typeof useStore.getState>) {
    return `${statusPhase(state)}:${state.tracked.length}`
  }

  function emitStatusIfChanged() {
    if (!pinnedSource) return
    const state = useStore.getState()
    const key = statusKey(state)
    if (key === lastStatusKey) return
    lastStatusKey = key
    postToHost({ type: 'status', payload: { phase: statusPhase(state), findingCount: state.tracked.length } })
  }

  const outbound: HostDocOutbound = {
    sendApplyReplacement(msg) {
      postToHost({
        type: 'applyReplacement',
        requestId: msg.requestId,
        payload: {
          fieldId: msg.fieldId, from: msg.from, to: msg.to,
          insert: msg.insert, expectedText: msg.expectedText,
        },
      })
    },
    sendSelectFinding(fieldId, id) {
      postToHost({ type: 'selectFinding', payload: { fieldId, id } })
    },
    sendFindings(fieldId, findings) {
      postToHost({ type: 'findings', payload: { fieldId, findings } })
    },
    onInput() {}, // replaced by the embed app (Task 6)
  }

  function route(msg: HostMessage) {
    switch (msg.type) {
      case 'hello':
        hostKindValue = msg.payload.host.kind
        postToHost({ type: 'ready', payload: { protocolVersion: PROTOCOL_VERSION, features: [] } })
        // Capture the current status as the baseline silently: `ready` is
        // the greeting, so the first genuine store change afterwards is
        // what triggers the first `status` message, not the pin itself.
        lastStatusKey = statusKey(useStore.getState())
        break
      case 'fieldConnected':
        hostDoc?.fieldConnected(msg.payload.fieldId, msg.payload.text, msg.payload.capabilities)
        break
      case 'textChanged':
        hostDoc?.textChanged(msg.payload.fieldId, msg.payload.text)
        break
      case 'replaceResult':
        hostDoc?.replaceResult(msg.requestId, msg.payload.ok, msg.payload.text)
        break
      case 'markingClicked':
        hostDoc?.selectFinding(msg.payload.id)
        break
      case 'fieldDisconnected':
        hostDoc?.fieldDisconnected(msg.payload.fieldId)
        break
    }
  }

  function handleMessage(event: MessageEvent) {
    const msg = parseHostMessage(event.data)
    if (!msg) return
    if (!pinnedSource || !pinnedOrigin) {
      if (msg.type !== 'hello') return
      pinnedSource = event.source
      pinnedOrigin = event.origin
    } else if (event.source !== pinnedSource || event.origin !== pinnedOrigin) {
      return
    }
    route(msg)
  }

  return {
    outbound,
    attach(doc) {
      hostDoc = doc
      listener = handleMessage
      window.addEventListener('message', listener)
      unsubscribeStore = useStore.subscribe(() => emitStatusIfChanged())
    },
    dispose() {
      if (listener) window.removeEventListener('message', listener)
      listener = null
      if (unsubscribeStore) unsubscribeStore()
      unsubscribeStore = null
      hostDoc = null
    },
    hostKind: () => hostKindValue,
  }
}
