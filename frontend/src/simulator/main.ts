// Host simulator wiring (spec: B43, "Bridge protocol" / C1 embed surface,
// Task 7). This file plays the HOST role of the protocol: it sends
// host -> embed messages by hand (protocol.ts's envelope() only types the
// opposite direction — see protocol.ts's own comment on FieldAdapter) and
// listens for embed -> host messages from the iframe. It is the harness a
// human drives during the Step 6 hand-check and the seam an e2e negative
// probe hooks into via ?desync=1 (see below).
import { PROTOCOL_VERSION } from '../embed/protocol'
import type { EmbedMessage, HostCapabilities, HostMessage, MarkingSpan } from '../embed/protocol'
import { createTextareaAdapter } from './textareaAdapter'

const FIELD_ID = 'sim-field'
const HELLO_RETRY_MS = 250

const fieldEl = document.getElementById('field') as HTMLTextAreaElement
const iframeEl = document.getElementById('embed') as HTMLIFrameElement
const connectBtn = document.getElementById('connect') as HTMLButtonElement
const statusEl = document.getElementById('sim-status') as HTMLElement

const adapter = createTextareaAdapter(fieldEl)

// Only current-version, known-type embed->host messages are handled; the
// payload shape is trusted from there — this is a dev-only reference host,
// not the hardened validator protocol.ts ships for the opposite direction.
const EMBED_TYPES = new Set(['ready', 'status', 'findings', 'applyReplacement', 'selectFinding'])
function parseEmbedMessage(data: unknown): EmbedMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.fw !== PROTOCOL_VERSION) return null
  if (typeof d.type !== 'string' || !EMBED_TYPES.has(d.type)) return null
  return data as EmbedMessage
}

function send(message: HostMessage) {
  iframeEl.contentWindow?.postMessage({ fw: PROTOCOL_VERSION, ...message }, location.origin)
}

// ---- desync hook for the e2e negative probe (?desync=1) ----
// The simulator's echo loop is otherwise synchronous: every keystroke's
// textChanged reaches the embed's HostDoc before any applyReplacement could
// race it, so its `expectedText` guess (buffer.slice(from, to)) always
// matches the live textarea and the mismatch branch is unreachable from the
// UI. This hook creates a deliberate, one-shot desync: swallow the very
// next textChanged after a keystroke (the embed's buffer goes stale), then
// mutate the field out from under the very next applyReplacement request
// (prepend one character) before handing it to the adapter — guaranteeing
// `applyReplacement`'s expectedText compare fails and replaceResult reports
// ok:false. Both flags are one-shot and consumed on first use.
const desyncMode = new URLSearchParams(location.search).get('desync') === '1'
let desyncPendingSuppress = desyncMode
let desyncPendingMutate = false

let ready = false
let connected = false
let currentFindings: MarkingSpan[] = []
let helloTimer: ReturnType<typeof setInterval> | null = null

function sendHello() {
  send({ type: 'hello', payload: { host: { kind: 'simulator', version: '0.0.1' } } })
}

iframeEl.addEventListener('load', () => {
  sendHello()
  helloTimer = setInterval(sendHello, HELLO_RETRY_MS)
})

connectBtn.disabled = true
connectBtn.addEventListener('click', () => {
  if (!ready) return
  connected = true
  const capabilities: HostCapabilities = adapter.capabilities()
  send({
    type: 'fieldConnected',
    payload: {
      fieldId: FIELD_ID,
      text: adapter.extract(),
      capabilities,
      meta: { url: location.href, fieldKind: 'textarea' },
    },
  })
  statusEl.textContent = 'connected'
})

adapter.onChange(() => {
  if (desyncPendingSuppress) {
    desyncPendingSuppress = false
    desyncPendingMutate = true
    return
  }
  if (!connected) return
  send({ type: 'textChanged', payload: { fieldId: FIELD_ID, text: adapter.extract() } })
})

// Marks are paint-only (see textareaAdapter.ts) — clicking one is detected
// on the real textarea via the caret position the browser places on click,
// matched against the last findings the embed sent.
fieldEl.addEventListener('click', () => {
  if (!connected) return
  const pos = fieldEl.selectionStart ?? 0
  const hit = currentFindings.find((f) => pos >= f.from && pos < f.to)
  if (hit) send({ type: 'markingClicked', payload: { fieldId: FIELD_ID, id: hit.id } })
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
      if (!connected) statusEl.textContent = 'embed ready — click Connect'
      break
    case 'status':
      if (connected) {
        statusEl.textContent = `${msg.payload.phase} (${msg.payload.findingCount} findings)`
      }
      break
    case 'findings':
      if (msg.payload.fieldId !== FIELD_ID) break
      currentFindings = msg.payload.findings
      adapter.setMarkings(msg.payload.findings)
      break
    case 'selectFinding':
      if (msg.payload.fieldId !== FIELD_ID || msg.payload.id === null) break
      adapter.flashFinding(msg.payload.id)
      break
    case 'applyReplacement': {
      if (desyncPendingMutate) {
        desyncPendingMutate = false
        fieldEl.value = `_${fieldEl.value}`
      }
      const { requestId } = msg
      const { from, to, insert, expectedText } = msg.payload
      const result = adapter.applyReplacement(from, to, insert, expectedText)
      send({
        type: 'replaceResult',
        requestId,
        payload: { fieldId: FIELD_ID, ok: result.ok, text: result.text },
      })
      break
    }
  }
})
