// Host simulator wiring (spec: B43, "Bridge protocol" / C1 embed surface,
// Task 7; generalized to two demo fields in C3, Task 4). This file plays the
// HOST role of the protocol: it sends host -> embed messages by hand
// (protocol.ts's envelope() only types the opposite direction — see
// protocol.ts's own comment on FieldAdapter) and listens for embed -> host
// messages from the iframe. It is the harness a human drives during the
// Step 6 hand-check and the seam an e2e negative probe hooks into via
// ?desync=1 (see below).
//
// B43 C3: the simulator now hosts TWO demo fields — the original textarea
// (fieldId 'sim-field') and a contentEditable div (fieldId 'sim-field-ce') —
// but the bridge protocol still only ever has ONE connected field at a time.
// `active` tracks which SimField (if any) currently owns that slot; every
// guard below that used to test a single `connected` boolean now tests
// `active` (null, or one of the two known SimField records) instead.
import { parseEmbedMessage, PROTOCOL_VERSION } from '../embed/protocol'
import type { FieldAdapter, HostCapabilities, HostMessage, MarkingSpan } from '../embed/protocol'
import { findingIdAt } from './clickHitTest'
import { createTextareaAdapter } from './textareaAdapter'
import { createContentEditableAdapter } from './contentEditableAdapter'

const HELLO_RETRY_MS = 250
// Finding 28: without a cap, an embed that never readies (a build that
// broke bridge.ts's hello handling, a genuinely wrong iframe src) retries
// forever with no visible signal beyond "not connected" — indistinguishable
// from a slow-but-working boot. 30 attempts at HELLO_RETRY_MS is ~7.5s,
// long enough to cover a slow dev-server cold start without leaving a human
// running the Step 6 hand-check staring at a silently-stuck page.
const MAX_HELLO_ATTEMPTS = 30

const fieldEl = document.getElementById('field') as HTMLTextAreaElement
const ceEl = document.getElementById('field-ce') as HTMLElement
const iframeEl = document.getElementById('embed') as HTMLIFrameElement
const connectBtn = document.getElementById('connect') as HTMLButtonElement
const ceConnectBtn = document.getElementById('connect-ce') as HTMLButtonElement
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement
const statusEl = document.getElementById('sim-status') as HTMLElement

// B43 C3: the generalized field record — one per demo field, each pairing
// its DOM element with its own FieldAdapter. `caretOffset` is optional in
// the type (the textarea adapter doesn't implement it; click-to-select for
// the textarea keeps using `fieldEl.selectionStart` directly instead) —
// only the contentEditable adapter provides a real one.
interface SimField {
  fieldId: string
  fieldKind: string
  el: HTMLElement
  adapter: FieldAdapter & { caretOffset?(): number | null }
}

const textareaField: SimField = {
  fieldId: 'sim-field',
  fieldKind: 'textarea',
  el: fieldEl,
  adapter: createTextareaAdapter(fieldEl),
}
const ceField: SimField = {
  fieldId: 'sim-field-ce',
  fieldKind: 'contenteditable',
  el: ceEl,
  adapter: createContentEditableAdapter(ceEl),
}

// The bridge protocol's one-connected-field rule, tracked here: null when
// no field is connected, else whichever of the two records above owns the
// slot. Every handler below that named FIELD_ID/adapter/connected in the
// single-field version now reads through `active`.
let active: SimField | null = null

function fieldById(fieldId: string): SimField | null {
  if (textareaField.fieldId === fieldId) return textareaField
  if (ceField.fieldId === fieldId) return ceField
  return null
}

function send(message: HostMessage) {
  iframeEl.contentWindow?.postMessage({ fw: PROTOCOL_VERSION, ...message }, location.origin)
}

// ---- desync hook for the e2e negative probe (?desync=1) ----
// The simulator's echo loop is otherwise synchronous: every keystroke's
// textChanged reaches the embed's HostDoc before any applyReplacement could
// race it, so its `expectedText` guess (buffer.slice(from, to)) always
// matches the live field and the mismatch branch is unreachable from the
// UI. This hook creates a deliberate, one-shot desync against WHICHEVER
// field is active: swallow the very next textChanged after a keystroke (the
// embed's buffer goes stale), then mutate the field out from under the very
// next applyReplacement request (prepend a character) before handing it to
// the adapter — guaranteeing `applyReplacement`'s expectedText compare fails
// and replaceResult reports ok:false. Both flags are one-shot and consumed
// on first use.
const desyncMode = new URLSearchParams(location.search).get('desync') === '1'
let desyncPendingSuppress = desyncMode
let desyncPendingMutate = false

// The mutate half of the desync hook: a real DOM mutation performed just
// before handing the request to the field's own adapter. The textarea's
// mutation stays `.value` string surgery (as before); the contentEditable
// field's is `ceEl.prepend('_')` — an actual DOM mutation, matching how a
// real host page's own script could race an in-flight applyReplacement.
function applyDesyncMutation(field: SimField): void {
  if (field.fieldKind === 'textarea') {
    const ta = field.el as HTMLTextAreaElement
    ta.value = `_${ta.value}`
  } else {
    field.el.prepend('_')
  }
}

let ready = false
let currentFindings: MarkingSpan[] = []
let selectedFindingId: string | null = null
let helloTimer: ReturnType<typeof setInterval> | null = null
let helloAttempts = 0

function sendHello() {
  send({ type: 'hello', payload: { host: { kind: 'simulator', version: '0.0.1' } } })
}

// Finding 28: each tick counts against the cap; past it, stop retrying and
// say so instead of silently retrying forever.
function attemptHello() {
  helloAttempts += 1
  if (helloAttempts > MAX_HELLO_ATTEMPTS) {
    if (helloTimer !== null) {
      clearInterval(helloTimer)
      helloTimer = null
    }
    statusEl.textContent = 'embed not responding'
    return
  }
  sendHello()
}

function armHelloRetry() {
  helloAttempts = 0
  attemptHello()
  helloTimer = setInterval(attemptHello, HELLO_RETRY_MS)
}

// Fires on the FIRST load (the initial /embed.html navigation) and on every
// subsequent one (a manual iframe reload during a hand-check). A reload
// replaces the embed with a fresh shim that has no memory of this session —
// it won't ready/connect on its own, and it will silently ignore any
// textChanged sent against the old (now-stale) belief that a field is still
// connected. Without resetting here, the simulator keeps showing "connected"
// and stale marks against an embed that has already forgotten everything.
iframeEl.addEventListener('load', () => {
  if (helloTimer !== null) {
    clearInterval(helloTimer)
    helloTimer = null
  }
  ready = false
  active = null
  currentFindings = []
  selectedFindingId = null
  // B43 C3: BOTH adapters get cleared, not just the one that happened to be
  // active — a stale mark left on the field that WASN'T connected at reload
  // time is just as stale as one on the field that was.
  textareaField.adapter.clearMarkings()
  textareaField.adapter.setSelected?.(null)
  ceField.adapter.clearMarkings()
  ceField.adapter.setSelected?.(null)
  connectBtn.disabled = true
  ceConnectBtn.disabled = true
  disconnectBtn.disabled = true
  // Finding 25: a reload drops in a fresh embed shim with no memory of the
  // prior session, so a desync run needs a fresh one-shot suppress/mutate
  // pair too — carrying over a flag already consumed (or a stale mutate
  // still armed) before the reload would desync the WRONG edit, or none.
  desyncPendingSuppress = desyncMode
  desyncPendingMutate = false
  statusEl.textContent = 'embed reloaded — reconnect needed'
  armHelloRetry()
})

// Eagerly arm the retry loop too (Copilot round 4), not just on 'load':
// this script is a deferred module, so a cached /embed.html can finish
// loading and register its own message listener before this script's
// 'load' listener above ever fires — waiting for 'load' alone can miss
// that window and leave the embed never hearing a hello. Posting to a
// contentWindow that hasn't loaded yet simply goes nowhere (postMessage is
// fire-and-forget), and the loop is idempotent — it self-clears the moment
// 'ready' arrives — so starting it here as well is harmless: a genuine
// later 'load' (e.g. a manual reload) still clears this timer and arms its
// own via the listener above.
armHelloRetry()

connectBtn.disabled = true
ceConnectBtn.disabled = true

// B43 C3: shared Connect logic for both fields. Connecting one field clears
// the OTHER field's markings/selection first (only one field ever owns the
// bridge's connected slot) and resets the tracked findings — the newly
// connected field has none of its own yet, and the old field's would
// otherwise leak into e.g. the textarea's click-to-select hit test.
function connectField(field: SimField, other: SimField): void {
  if (!ready) return
  other.adapter.clearMarkings()
  other.adapter.setSelected?.(null)
  active = field
  currentFindings = []
  selectedFindingId = null
  const capabilities: HostCapabilities = field.adapter.capabilities()
  send({
    type: 'fieldConnected',
    payload: {
      fieldId: field.fieldId,
      text: field.adapter.extract(),
      capabilities,
      meta: { url: location.href, fieldKind: field.fieldKind },
    },
  })
  disconnectBtn.disabled = false
  statusEl.textContent = 'connected'
}

connectBtn.addEventListener('click', () => connectField(textareaField, ceField))
ceConnectBtn.addEventListener('click', () => connectField(ceField, textareaField))

// Finding 19: the human-driven counterpart to fieldDisconnected — lets a
// Step 6 hand-check (or the negative-path e2e probe) exercise a clean
// disconnect without reloading the whole iframe.
disconnectBtn.disabled = true
disconnectBtn.addEventListener('click', () => {
  if (active === null) return
  const field = active
  active = null
  currentFindings = []
  selectedFindingId = null
  field.adapter.clearMarkings()
  field.adapter.setSelected?.(null)
  send({ type: 'fieldDisconnected', payload: { fieldId: field.fieldId } })
  disconnectBtn.disabled = true
  connectBtn.disabled = !ready
  ceConnectBtn.disabled = !ready
  statusEl.textContent = ready ? 'embed ready — click Connect' : 'not connected'
})

// Finding 6/29 portability note aside, this is a dev-only harness: dispose
// both adapters' own listeners/overlay on page unload rather than leaving
// them for the browser to tear down implicitly — matches
// createTextareaAdapter's/createContentEditableAdapter's own dispose()
// contract.
window.addEventListener('beforeunload', () => {
  textareaField.adapter.dispose()
  ceField.adapter.dispose()
})

// Finding 25: only consume the one-shot suppress flag once a field is
// actually active — an edit typed before Connect is clicked would never be
// sent anyway (the `active !== field` return below), so consuming the flag
// then would waste the deliberate desync on an edit that was never in play,
// leaving the real first post-connect edit un-desynced. Shared by both
// fields' onChange (B43 C3): the desync one-shot pair applies to whichever
// field is active, not to a fixed field.
function handleChange(field: SimField): void {
  if (active !== field) return
  if (desyncPendingSuppress) {
    desyncPendingSuppress = false
    desyncPendingMutate = true
    return
  }
  send({ type: 'textChanged', payload: { fieldId: field.fieldId, text: field.adapter.extract() } })
}

textareaField.adapter.onChange(() => handleChange(textareaField))
ceField.adapter.onChange(() => handleChange(ceField))

// Marks are paint-only (see textareaAdapter.ts) — clicking one is detected
// on the real textarea via the caret position the browser places on click,
// matched against the last findings the embed sent.
fieldEl.addEventListener('click', () => {
  if (active !== textareaField) return
  const pos = fieldEl.selectionStart ?? 0
  const hitId = findingIdAt(currentFindings, selectedFindingId, pos)
  if (hitId === null) return
  selectedFindingId = hitId
  send({ type: 'markingClicked', payload: { fieldId: textareaField.fieldId, id: hitId } })
})

// B43 C3: same click-to-select for the contentEditable field, via the
// adapter's own caretOffset() (a null caret — the click landed outside the
// field's text, or there is no selection at all — is a no-op, same as the
// textarea's `pos` always resolving to a number).
ceEl.addEventListener('click', () => {
  if (active !== ceField) return
  const pos = ceField.adapter.caretOffset?.()
  if (pos == null) return
  const hitId = findingIdAt(currentFindings, selectedFindingId, pos)
  if (hitId === null) return
  selectedFindingId = hitId
  send({ type: 'markingClicked', payload: { fieldId: ceField.fieldId, id: hitId } })
})

window.addEventListener('message', (event) => {
  if (event.source !== iframeEl.contentWindow || event.origin !== location.origin) return
  const msg = parseEmbedMessage(event.data)
  if (!msg) return

  switch (msg.type) {
    case 'ready':
      ready = true
      if (helloTimer !== null) {
        clearInterval(helloTimer)
        helloTimer = null
      }
      connectBtn.disabled = false
      ceConnectBtn.disabled = false
      if (active === null) statusEl.textContent = 'embed ready — click Connect'
      break
    // Finding 21: render status even before Connect is clicked — a field
    // can connect while the login form is still showing in the real embed
    // (auth/session.ts's login()), so the pre-connect signed-out line is a
    // real, observable state worth showing here too, not just once
    // "connected" is true.
    case 'status':
      statusEl.textContent = `${msg.payload.phase} (${msg.payload.findingCount} findings)`
      break
    case 'findings':
      if (active === null || msg.payload.fieldId !== active.fieldId) break
      currentFindings = msg.payload.findings
      active.adapter.setMarkings(msg.payload.findings)
      break
    case 'selectFinding':
      if (active === null || msg.payload.fieldId !== active.fieldId) break
      // Tracks the embed's authoritative selection (not just our own click
      // guess) so findingIdAt's cycling stays correct even when the
      // selection changed some other way (e.g. picked in the embed's own
      // sidebar).
      selectedFindingId = msg.payload.id
      // F2 (C2): setSelected FIRST — it re-renders the overlay's marks from
      // scratch (textareaAdapter.ts's render(), via
      // overlay.replaceChildren()), which would wipe out flashFinding's own
      // fw-mark-flash class if that ran first. id: null included, so a
      // toggle-off clears the persistent marker too.
      active.adapter.setSelected?.(msg.payload.id)
      if (msg.payload.id !== null) active.adapter.flashFinding(msg.payload.id)
      break
    case 'applyReplacement': {
      const { requestId } = msg
      const { from, to, insert, expectedText } = msg.payload
      // Copilot round 11: unlike the other field-scoped handlers above
      // (findings, selectFinding), this one used to call the adapter
      // unconditionally. A delayed or mismatched request — e.g. one queued
      // before a disconnect/reload and only delivered after — could still
      // mutate a live field with no connected field to own it. Refuse it
      // the same way the adapter itself refuses an expectedText mismatch:
      // ok:false, so the shim's own retry/desync handling on the other end
      // sees an ordinary refusal rather than a crash.
      //
      // B43 C3: with two known fields but neither connected, there is no
      // longer one single "own" field to always echo — the closest
      // generalization of the old single-field behavior (which always
      // echoed FIELD_ID and its current, unmodified text) is to answer as
      // whichever KNOWN field the request itself named, with THAT field's
      // current text, since that's the field a real reply would have been
      // about; a request naming neither known field gets the same empty-
      // text answer the foreign-fieldId branch below gives.
      if (active === null) {
        const named = fieldById(msg.payload.fieldId)
        send({
          type: 'replaceResult',
          requestId,
          payload: {
            fieldId: msg.payload.fieldId,
            ok: false,
            text: named ? named.adapter.extract() : '',
          },
        })
        break
      }
      // Finding 20: a request naming a DIFFERENT fieldId than the currently
      // connected one (a stale requester from before a disconnect/reload,
      // or one addressed to the OTHER demo field) echoes back that same
      // foreign fieldId, not the active field's id — a reply addressed as
      // the active field could be mistaken for an answer about it by a host
      // tracking more than one. The embed's own shim discards a
      // replaceResult whose fieldId doesn't match its connected field
      // regardless (hostDoc.ts's replaceResult), so the active field's real
      // text is never legitimately meant for that foreign reply — send an
      // empty string rather than leaking it into an echo addressed to a
      // field that isn't this one.
      if (msg.payload.fieldId !== active.fieldId) {
        send({
          type: 'replaceResult',
          requestId,
          payload: { fieldId: msg.payload.fieldId, ok: false, text: '' },
        })
        break
      }
      if (desyncPendingMutate) {
        desyncPendingMutate = false
        applyDesyncMutation(active)
      }
      // Finding 6: the adapter's own range guard (textareaAdapter.ts's /
      // contentEditableAdapter.ts's applyReplacement) refuses a malformed
      // vector cleanly, but this call still crosses into real DOM APIs
      // whose own edge cases aren't this reference host's to fully
      // characterize. A throw here must not take down the simulator's
      // message listener (an uncaught exception inside it would drop every
      // later postMessage silently) — answer the same ok:false-with-
      // current-text refusal the guard itself would give.
      let result: { ok: boolean; text: string }
      try {
        result = active.adapter.applyReplacement(from, to, insert, expectedText)
      } catch {
        result = { ok: false, text: active.adapter.extract() }
      }
      send({
        type: 'replaceResult',
        requestId,
        payload: { fieldId: active.fieldId, ok: result.ok, text: result.text },
      })
      break
    }
  }
})
