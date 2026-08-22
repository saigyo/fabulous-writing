// Host document shim (spec: B43, "Bridge protocol" / C1 embed surface).
//
// Implements DocumentPort against postMessage-driven host state instead of
// a CodeMirror EditorView. The host owns the text; the shim never edits it
// directly. Every incoming text snapshot (a textChanged message, or a
// replaceResult echo) is diffed against the shim's buffer with a single
// derived splice, and the tracked findings are mapped through that splice —
// porting editor/findings.ts's ChangeSet-mapping semantics to a
// single-splice-per-update world (there is exactly one diff to reason
// about here, not an arbitrary ChangeSet).
import type { ApplyResult, DocumentPort } from '../checking/documentPort'
import type { TrackedFinding } from '../editor/findings'
import { findEquivalent } from '../findings/equivalence'
import { codePoints, wordCount } from '../scoring/score'
import { useStore } from '../state/store'
import type { Finding, Source } from '../types'
import { convertFindingOffsets, toCodePointSpan } from './offsets'
import type { HostCapabilities, MarkingSpan } from './protocol'

const REPLACE_TIMEOUT_MS = 2000

export interface HostDocOutbound {
  sendApplyReplacement(msg: {
    requestId: string
    fieldId: string
    from: number
    to: number
    insert: string
    expectedText: string
  }): void
  sendSelectFinding(fieldId: string, id: string | null): void
  sendFindings(fieldId: string, findings: MarkingSpan[]): void
  onInput(): void // scheduler hook, wired by the embed app
}

export interface HostDoc extends DocumentPort {
  /** meta is optional only for backward-compatible test call sites — the
   * bridge always sends it (protocol.ts's FieldConnectedMessage.payload.meta
   * is required). Used solely to publish the connected field's page URL to
   * the store (see connectedField's own comment in state/store.ts) — the
   * shim has no other use for fieldKind. */
  fieldConnected(
    fieldId: string,
    text: string,
    capabilities: HostCapabilities,
    meta?: { url: string; fieldKind: string },
  ): void
  fieldDisconnected(fieldId: string): void
  /** A markingClicked message routed from the bridge — verifies fieldId
   * still matches the connected field before selecting, so a click on a
   * marking rendered for a field the host already disconnected (a stale
   * postMessage still in flight) can never select a finding against
   * whatever field is connected now. */
  markingClicked(fieldId: string, id: string): void
  textChanged(fieldId: string, text: string): void
  replaceResult(requestId: string, ok: boolean, text: string, fieldId: string): void
  connected(): boolean
  capabilities(): HostCapabilities | null
  /** Session-scoped teardown for session turnover (auth/session.ts, via
   * embed/disconnectSlot.ts on logout/expireSession): clears tracked
   * findings (store and host both get the empty-findings message, sent
   * while fieldId is still current), settles pending replacements as
   * 'refused', clears the selection, and clears the store's doc metrics/
   * scorecard — but deliberately RETAINS the shim's own field identity,
   * capabilities, meta, and buffer.
   *
   * Contrast with the old unconditional teardown() this replaced: that
   * also nulled fieldId, which made the login-time republish() (fieldId
   * === null) a no-op — the embed then waited forever while the host still
   * believed it was connected (nothing tells the host to reconnect; see
   * republish()'s own comment). Retaining the buffer leaks nothing: its
   * text belongs to the HOST page (still visible there, in the user's own
   * field), not to the session.
   *
   * connected() (fieldId !== null) stays true across this call by design —
   * the STORE is what goes login-gated (connectedField is cleared by
   * auth/session.ts's resetSessionState(), which always runs immediately
   * before this), not the shim's private knowledge of the field. Also
   * flips the session-active flag off: a host textChanged that arrives in
   * the window between this call and the next republish() (the user is
   * logged out but the host page keeps running) must not publish tracked
   * findings or doc metrics into the store — see syncBuffer(). */
  resetSession(): void
  /** Re-publishes the currently connected field's state to the store —
   * wired to auth/session.ts's login() via embed/activateSlot.ts. A field
   * can connect while the login form is still showing (the bridge attaches
   * regardless of auth status), and a cross-user login's resetSessionState()
   * clears store.connectedField/tracked/docWords/docChars even though this
   * shim is still connected — the strip would show "waiting" forever and
   * the connect-time check would never re-fire. A no-op while unconnected,
   * so it is safe to call unconditionally on every login. Deliberately NOT
   * teardown: the host still believes it is connected and has no reconnect
   * affordance, so the fix is to make the store agree with the shim again,
   * not to disconnect.
   *
   * Also the counterpart to resetSession()'s session-active flip: this is
   * the one path (besides fieldConnected) that turns the flag back on, so
   * a textChanged that arrives after this point resumes publishing to the
   * store normally. Writing a fresh connectedField object is what makes
   * EmbedApp.tsx's connect effect re-fire the check (it's keyed on the
   * object's identity, not fieldId alone — see that effect's comment). */
  republish(): void
}

interface Splice {
  from: number
  to: number
  insert: string
}

/**
 * Derive the single splice that turns `oldText` into `newText`: longest
 * common prefix `p`, then the longest common suffix `s` bounded by
 * `s <= min(oldLen, newLen) - p` (INCLUSIVE). The strict form is off by
 * one: a pure insertion/deletion has `p + s === min(oldLen, newLen)`
 * exactly, and clamping `s` one short widens the splice by one character,
 * wrongly dropping an adjacent finding that CodeMirror's insertion mapping
 * keeps (see hostDoc.test.ts, the "the cat" -> "theX cat" vector).
 */
function deriveSplice(oldText: string, newText: string): Splice {
  const oldLen = oldText.length
  const newLen = newText.length
  const maxCommon = Math.min(oldLen, newLen)
  let p = 0
  while (p < maxCommon && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++
  const bound = maxCommon - p
  let s = 0
  while (
    s < bound &&
    oldText.charCodeAt(oldLen - 1 - s) === newText.charCodeAt(newLen - 1 - s)
  ) {
    s++
  }
  return { from: p, to: oldLen - s, insert: newText.slice(p, newLen - s) }
}

/** Same predicate `touchesRange` uses: overlap OR boundary adjacency. */
function touchesSplice(item: TrackedFinding, splice: Splice): boolean {
  return item.from <= splice.to && splice.from <= item.to
}

/**
 * Map tracked findings through a splice, porting findingsField's
 * docChanged branch: findings entirely before the splice are untouched,
 * findings entirely after shift by the length delta, and anything
 * overlapping OR adjacent to the splice is dropped — but only when the
 * splice is a real change (a no-op textChanged, e.g. a redundant host
 * echo, derives an empty splice and must not touch anything).
 */
function mapThroughSplice(items: TrackedFinding[], splice: Splice): TrackedFinding[] {
  const isRealChange = splice.from < splice.to || splice.insert.length > 0
  const delta = splice.insert.length - (splice.to - splice.from)
  const mapped: TrackedFinding[] = []
  for (const item of items) {
    if (isRealChange && touchesSplice(item, splice)) continue // dropped
    if (item.to < splice.from) {
      mapped.push(item)
    } else if (item.from > splice.to) {
      mapped.push({ ...item, from: item.from + delta, to: item.to + delta })
    } else {
      mapped.push(item) // touches a boundary, but not a real change
    }
  }
  return mapped.filter((item) => item.from < item.to)
}

function toTracked(findings: Finding[], bufferLength: number): TrackedFinding[] {
  return findings
    .filter((f) => f.span.start < f.span.end && f.span.end <= bufferLength)
    .map((f) => ({ finding: f, from: f.span.start, to: f.span.end }))
}

interface PendingReplace {
  resolve: (result: ApplyResult) => void
  timer: ReturnType<typeof setTimeout>
}

export function createHostDoc(outbound: HostDocOutbound): HostDoc {
  let fieldId: string | null = null
  let caps: HostCapabilities | null = null
  let buffer = ''
  // The page URL from fieldConnected's meta, kept alongside fieldId/caps/
  // buffer purely so republish() can re-write store.connectedField without
  // the caller having to pass meta again — mirrors setConnectedField's own
  // {fieldId, url} shape (state/store.ts).
  let connectedUrl: string | null = null
  let items: TrackedFinding[] = []
  let selectedId: string | null = null
  let requestSeq = 0
  const pending = new Map<string, PendingReplace>()
  // Off only in the window between resetSession() and the next republish()/
  // fieldConnected() — the host page keeps running (and can still send
  // textChanged) while the user is logged out. Gates syncBuffer()'s store
  // publish so a post-logout host edit cannot leak tracked findings or doc
  // metrics into a store the login-gated UI shouldn't be showing anyway.
  // Starts true: a hostDoc that has never gone through a session reset
  // (every pre-existing call site/test) behaves exactly as before.
  let sessionActive = true

  function toMarkingSpans(): MarkingSpan[] {
    return items.map((item) => ({
      id: item.finding.id,
      from: item.from,
      to: item.to,
      severity: item.finding.severity,
      category: item.finding.category,
    }))
  }

  function publishFindings() {
    useStore.getState().setTracked(items, selectedId)
    if (fieldId) outbound.sendFindings(fieldId, toMarkingSpans())
  }

  function doSelectFinding(id: string | null) {
    selectedId = id
    useStore.getState().setTracked(items, selectedId)
    if (fieldId) outbound.sendSelectFinding(fieldId, id)
  }

  function currentFinding(id: string): TrackedFinding | null {
    return items.find((item) => item.finding.id === id) ?? null
  }

  function settlePending(requestId: string, result: ApplyResult) {
    const p = pending.get(requestId)
    if (!p) return
    pending.delete(requestId)
    clearTimeout(p.timer)
    p.resolve(result)
  }

  /** Resolves every outstanding replacement as 'refused' and clears their
   * timers — a pending applySuggestion/applyRewrite from a field that is
   * about to disappear (a new fieldConnected, a fieldDisconnected, or a
   * full session teardown) will never see its echo. */
  function settleAllPending() {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.resolve('refused')
    }
    pending.clear()
  }

  /** Shared by fieldConnected, fieldDisconnected, and resetSession: clears
   * tracked findings from the store and the wire (sent to the still-current
   * fieldId, before the caller nulls it — symmetric with how fieldConnected
   * announces a fresh, empty finding set), resets doc metrics, drops a
   * stale scorecard, and settles any in-flight replacement as 'refused'. */
  function resetConnectionState() {
    items = []
    selectedId = null
    const store = useStore.getState()
    store.setTracked([], null)
    store.setDocWords(0)
    store.setDocChars(0)
    store.clearScorecard()
    if (fieldId) outbound.sendFindings(fieldId, [])
    settleAllPending()
  }

  /** Full disconnection: resetConnectionState() plus clearing connectedField
   * and the shim's own field identity — used by fieldDisconnected
   * (field-matched: the host itself is telling us the field is gone). NOT
   * used by resetSession(): a session ending must not discard the shim's
   * own knowledge of a field the host still believes is connected — see
   * resetSession()'s comment. */
  function teardown() {
    resetConnectionState()
    useStore.getState().setConnectedField(null)
    fieldId = null
    caps = null
    buffer = ''
    connectedUrl = null
  }

  /** Apply a fresh host-truth text snapshot: derive the splice, map
   * findings through it, resync the buffer, and republish — used by both
   * textChanged and a replaceResult echo (the host's echoed text is a
   * fresh textChanged in every way that matters here).
   *
   * A refused replaceResult echoes the text back UNCHANGED (see
   * replaceResult's ok:false branch) — that's not a real edit, so it must
   * not re-arm the check scheduler (onInput) or mark metrics/the scorecard
   * dirty. Without this guard, a refused suggestion looks exactly like the
   * user having typed something, scheduling an unwanted LLM check.
   *
   * The buffer/items resync always runs, even while !sessionActive (a host
   * edit during the logged-out window is still real and must not be lost
   * or diffed against stale text once republish() reactivates the
   * session) — but publishing (onInput, doc metrics, the scorecard, and
   * the tracked-findings message) is skipped: nothing must leak into the
   * store, or re-arm the check scheduler, for a session nobody is logged
   * into right now. */
  function syncBuffer(text: string) {
    if (text === buffer) return
    const splice = deriveSplice(buffer, text)
    items = mapThroughSplice(items, splice)
    buffer = text
    if (!sessionActive) return
    outbound.onInput()
    const store = useStore.getState()
    store.setDocWords(wordCount(text))
    store.setDocChars(codePoints(text))
    store.markScorecardStale()
    publishFindings()
  }

  function sendReplace(from: number, to: number, insert: string): Promise<ApplyResult> {
    // A field whose capabilities declare replace: 'none' (e.g. mark-only,
    // no programmatic edit support) can never honor an applyReplacement —
    // resolve refused immediately rather than post a wire message the host
    // will never answer and wait out the full 2s timeout for nothing.
    if (caps?.replace === 'none') return Promise.resolve('refused')
    requestSeq += 1
    const requestId = `r${requestSeq}`
    const expectedText = buffer.slice(from, to)
    const currentFieldId = fieldId ?? ''
    const promise = new Promise<ApplyResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve('refused')
      }, REPLACE_TIMEOUT_MS)
      pending.set(requestId, { resolve, timer })
    })
    outbound.sendApplyReplacement({
      requestId, fieldId: currentFieldId, from, to, insert, expectedText,
    })
    return promise
  }

  return {
    hasDocument: () => fieldId !== null,
    connected: () => fieldId !== null,
    capabilities: () => caps,
    getText: () => buffer,
    setDocument: () => {}, // document manager never runs in the embed
    currentFinding,
    serverSpan(id) {
      const item = currentFinding(id)
      return item ? toCodePointSpan(buffer, item.from, item.to) : null
    },
    mergeFindings(replaceSources: Source[], findings: Finding[]) {
      const converted = convertFindingOffsets(buffer, findings)
      const tracked = toTracked(converted, buffer.length)
      const previous = items.find((item) => item.finding.id === selectedId)
      items = items
        .filter((item) => !replaceSources.includes(item.finding.source))
        .concat(tracked)
      if (!items.some((item) => item.finding.id === selectedId)) {
        selectedId = findEquivalent(items, previous)?.finding.id ?? null
      }
      publishFindings()
    },
    selectFinding: doSelectFinding,
    markingClicked(fid, id) {
      if (fieldId !== fid) return
      // A delayed click can arrive as a postMessage that was already in
      // flight when the tracked findings changed underneath it (a fresh
      // check's mergeFindings, or an edit that dropped/shifted the
      // finding) — guard against selecting (and echoing back) an id that
      // no longer names a currently tracked finding.
      if (!currentFinding(id)) return
      doSelectFinding(id)
    },
    applySuggestion(id, suggestion) {
      const item = currentFinding(id)
      if (!item) return Promise.resolve('not-found')
      return sendReplace(item.from, item.to, suggestion)
    },
    applyRewrite(id, original, replacement) {
      const item = currentFinding(id)
      if (!item) return Promise.resolve('not-found')
      for (
        let index = buffer.indexOf(original);
        index !== -1;
        index = buffer.indexOf(original, index + 1)
      ) {
        const end = index + original.length
        if (index < item.to && item.from < end) {
          return sendReplace(index, end, replacement)
        }
      }
      return Promise.resolve('not-found')
    },
    fieldConnected(fid, text, capabilities, meta) {
      // resetConnectionState() runs FIRST, while fieldId is still the OLD
      // field (Copilot round 5): it addresses its empty-findings clear to
      // whichever field is currently connected, so the field that is about
      // to disappear gets told to drop its overlays — installing the new
      // fieldId before this call sent that clear to the field that was
      // about to connect instead, leaving the old field's adapter stuck
      // with stale marks it would never receive another update for.
      resetConnectionState() // whole-document replacement: no "old text"/findings/pending left to describe
      fieldId = fid
      caps = capabilities
      buffer = text
      connectedUrl = meta?.url ?? null
      // A fresh connect is always an active session as far as this shim is
      // concerned (see sessionActive's own comment) — resets the flag in
      // case the field that just connected is a NEW one arriving while a
      // prior field's session was left inactive by resetSession().
      sessionActive = true
      const store = useStore.getState()
      store.setDocWords(wordCount(text))
      store.setDocChars(codePoints(text))
      store.setConnectedField({ fieldId: fid, url: connectedUrl })
    },
    fieldDisconnected(fid) {
      if (fieldId !== fid) return
      teardown() // sends the cleared findings before fieldId inside it goes null
    },
    resetSession() {
      resetConnectionState() // findings/pending/selection/metrics/scorecard — NOT fieldId/caps/buffer/connectedUrl, see this method's own doc comment
      sessionActive = false
    },
    republish() {
      if (fieldId === null) return
      sessionActive = true
      const store = useStore.getState()
      store.setConnectedField({ fieldId, url: connectedUrl })
      store.setDocWords(wordCount(buffer))
      store.setDocChars(codePoints(buffer))
      store.setTracked(items, selectedId)
    },
    textChanged(fid, text) {
      if (fieldId !== fid) return
      syncBuffer(text)
    },
    replaceResult(requestId, ok, text, fid) {
      if (fieldId !== fid) return // foreign-field echo: ignored entirely
      settlePending(requestId, ok ? 'ok' : 'refused')
      syncBuffer(text)
    },
  }
}
