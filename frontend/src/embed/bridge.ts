// Bridge runtime (spec: B43, "Bridge protocol" / C1 embed surface).
//
// Owns the window 'message' listener: pins the first host that sends a
// valid `hello` (source + origin), routes everything after that to a
// HostDoc, and streams the store's check/auth state out as `status`
// messages. Everything outbound is a no-op until a host is pinned — the
// embed may run standalone (no host ever connects) without erroring.
import { useStore } from '../state/store'
import { setClientTag } from '../checking/clientTag'
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

  function statusMessage(state: ReturnType<typeof useStore.getState>): EmbedMessage {
    return { type: 'status', payload: { phase: statusPhase(state), findingCount: state.tracked.length } }
  }

  function emitStatusIfChanged() {
    if (!pinnedSource) return
    const state = useStore.getState()
    const key = statusKey(state)
    if (key === lastStatusKey) return
    lastStatusKey = key
    postToHost(statusMessage(state))
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
      case 'hello': {
        hostKindValue = msg.payload.host.kind
        setClientTag(msg.payload.host.kind)
        postToHost({ type: 'ready', payload: { protocolVersion: PROTOCOL_VERSION, features: [] } })
        // F5 (final review): emit the initial status right after ready — a
        // cold, unauthenticated panel must be able to show signed-out from
        // the start, not only after the first store change. lastStatusKey
        // is set from this same emission, so emitStatusIfChanged()'s
        // change-only dedup continues exactly as before for every message
        // after this one.
        const state = useStore.getState()
        lastStatusKey = statusKey(state)
        postToHost(statusMessage(state))
        break
      }
      case 'fieldConnected':
        hostDoc?.fieldConnected(
          msg.payload.fieldId, msg.payload.text, msg.payload.capabilities, msg.payload.meta,
        )
        break
      case 'textChanged':
        hostDoc?.textChanged(msg.payload.fieldId, msg.payload.text)
        break
      case 'replaceResult':
        hostDoc?.replaceResult(msg.requestId, msg.payload.ok, msg.payload.text, msg.payload.fieldId)
        break
      case 'markingClicked':
        hostDoc?.markingClicked(msg.payload.fieldId, msg.payload.id)
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
      // Security (Copilot round 9): the CSP's frame-ancestors directive
      // restricts who may FRAME this page — it is not an access-control on
      // the WindowProxy. Any window holding a reference to this one can
      // still postMessage into it: a hostile same-origin page can
      // window.open('/embed.html') as a top-level popup (which shares this
      // origin's authenticated storage, so window.parent === window there
      // too) or hold a sibling frame's proxy, then send a valid `hello` and
      // get pinned — driving checks under the user's session (credit burn),
      // receiving status/findings geometry, and seeing replacement text
      // slices. A hello is therefore accepted ONLY when this page is
      // actually embedded (window.parent !== window) AND the sender is
      // exactly the embedding parent (event.source === window.parent).
      // When not framed, no hello is ever accepted — direct navigation to
      // /embed is not a supported host context. This subsumes the earlier
      // null-source guard (F6, final review): window.parent is never null,
      // so a null event.source can never equal it.
      if (window.parent === window) return
      if (event.source !== window.parent) return
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
