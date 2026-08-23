// The content-side session for one field (spec: B43, C2 browser extension,
// Task 6 Part B). Plays exactly the HOST role frontend/src/simulator/main.ts
// plays for the simulator's demo textarea — the connected-state logic here
// is ported off that file's DOM/button harness onto a plain `send` callback
// the content script (scout.ts, Task 7) supplies instead. Every guard
// main.ts grew across its own C1 review rounds carries over verbatim: the
// not-connected (here: detached) refusal with the current text, the
// foreign-fieldId refusal with empty text, and the try/catch around
// adapter.applyReplacement so a real DOM edge case can't take down the
// scout's message handling.
//
// Unlike main.ts (which waits for a human to click Connect), a session
// auto-connects the moment it's created: on a real host page the field is
// already live before a scout ever notices it, so there is no separate
// "ready but not yet connected" state to model here.
import { createTextareaAdapter } from '../../../frontend/src/simulator/textareaAdapter'
import { findingIdAt } from '../../../frontend/src/simulator/clickHitTest'
import { PROTOCOL_VERSION } from '../../../frontend/src/embed/protocol'
import type { EmbedMessage, Envelope, HostMessage, MarkingSpan } from '../../../frontend/src/embed/protocol'

export interface Session {
  fieldId: string
  handleEmbedMessage(msg: Envelope<EmbedMessage>): void
  /** Detach without notifying (SW/scout-initiated replace). */
  detach(): void
  /** User-initiated disconnect: sends fieldDisconnected, then detaches. */
  stop(): void
}

export function startSession(
  el: HTMLTextAreaElement,
  send: (msg: Envelope<HostMessage>) => void,
  // M2 (closing sweep): a session that detaches ITSELF (the MutationObserver
  // below noticing the field left the document) has no other way to tell
  // its owner — without this, scout's own session/sessionEl refs would keep
  // pointing at a torn-down session forever. Optional: only scout.ts's own
  // real usage needs it; a caller that doesn't care about self-detach (most
  // of this file's own tests) can omit it.
  onDetached?: () => void,
): Session {
  // crypto.randomUUID is secure-context-gated (a content script shares the
  // host page's context), so on a plain-http site it's simply undefined —
  // fall back to a non-cryptographic id that's still unique enough for a
  // per-tab field session.
  const fieldId = `fw-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
  const adapter = createTextareaAdapter(el)

  let detached = false
  let currentFindings: MarkingSpan[] = []
  let selectedId: string | null = null

  function sendMsg(message: HostMessage): void {
    send({ fw: PROTOCOL_VERSION, ...message })
  }

  adapter.onChange(() => {
    sendMsg({ type: 'textChanged', payload: { fieldId, text: adapter.extract() } })
  })

  // Marks are paint-only (textareaAdapter.ts) — clicking one is detected on
  // the real field via the caret position the browser places on click,
  // matched against the last findings this session was told about. Mirrors
  // main.ts's own click handling exactly, including cycling the selection
  // outward via findingIdAt when the same spot is clicked again.
  function handleClick(): void {
    const pos = el.selectionStart ?? 0
    const hitId = findingIdAt(currentFindings, selectedId, pos)
    if (hitId === null) return
    selectedId = hitId
    sendMsg({ type: 'markingClicked', payload: { fieldId, id: hitId } })
  }
  el.addEventListener('click', handleClick)

  // Turbo (and similar) navigations can replace the composer element out
  // from under a live session without ever removing the extension's content
  // script — auto-disconnect the moment the field itself leaves the
  // document, rather than leaking a session no host page can reach anymore.
  const observer = new MutationObserver(() => {
    if (detached || el.isConnected) return
    stop()
    onDetached?.()
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  function detach(): void {
    if (detached) return
    detached = true
    observer.disconnect()
    el.removeEventListener('click', handleClick)
    adapter.dispose()
  }

  function stop(): void {
    if (detached) return
    sendMsg({ type: 'fieldDisconnected', payload: { fieldId } })
    detach()
  }

  function handleEmbedMessage(msg: Envelope<EmbedMessage>): void {
    switch (msg.type) {
      case 'findings':
        // A detached session's adapter is disposed — its overlay is gone,
        // so setMarkings would render into a detached DOM node for no
        // reason. Same early return as applyReplacement's detached guard.
        if (detached) return
        if (msg.payload.fieldId !== fieldId) return
        currentFindings = msg.payload.findings
        adapter.setMarkings(msg.payload.findings)
        return
      case 'selectFinding':
        // Same reasoning as 'findings' above — flashFinding schedules a
        // fresh 700ms timer against the (disposed) overlay if allowed to
        // run after detach.
        if (detached) return
        if (msg.payload.fieldId !== fieldId) return
        selectedId = msg.payload.id
        if (msg.payload.id !== null) adapter.flashFinding(msg.payload.id)
        return
      case 'applyReplacement': {
        const { requestId } = msg
        const { from, to, insert, expectedText } = msg.payload
        // Same ordering as main.ts's applyReplacement handler: a delayed or
        // mismatched request must be refused, never silently applied to a
        // field that no longer owns this session.
        if (detached) {
          sendMsg({
            type: 'replaceResult',
            requestId,
            payload: { fieldId, ok: false, text: adapter.extract() },
          })
          return
        }
        if (msg.payload.fieldId !== fieldId) {
          sendMsg({
            type: 'replaceResult',
            requestId,
            payload: { fieldId: msg.payload.fieldId, ok: false, text: '' },
          })
          return
        }
        let result: { ok: boolean; text: string }
        try {
          result = adapter.applyReplacement(from, to, insert, expectedText)
        } catch {
          result = { ok: false, text: adapter.extract() }
        }
        sendMsg({
          type: 'replaceResult',
          requestId,
          payload: { fieldId, ok: result.ok, text: result.text },
        })
        return
      }
      case 'ready':
      case 'status':
        return
    }
  }

  sendMsg({
    type: 'fieldConnected',
    payload: {
      fieldId,
      text: adapter.extract(),
      capabilities: adapter.capabilities(),
      meta: { url: location.href, fieldKind: 'textarea' },
    },
  })

  return { fieldId, handleEmbedMessage, detach, stop }
}
