import {
  generateDocumentName,
  HttpError,
  updateDocument,
} from '../api/client'
import { refreshUserNow } from '../auth/refreshSlot'
import { getEditorView } from '../editor/editorRef'
import { wordCount } from '../scoring/score'
import { useStore } from '../state/store'
import { readSnapshot, writeSnapshot, type DocSnapshot } from './buffer'
import { settingsPayload } from './settings'

const DEBOUNCE_MS = 1500
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30000
const TITLE_WORD_THRESHOLD = 20

let timer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RETRY_BASE_MS
let saving = false
let pending = false
let hydrating = false
// The promise of the push currently in flight, chained through any
// follow-up push triggered by `pending`. Awaited by flush() so callers
// (e.g. openDocument) that need the save to have actually landed before
// switching documents get a promise that only resolves once the whole
// chain — including the queued follow-up — has settled.
let inFlight: Promise<void> | null = null
// Injected by documents.ts (avoids a module cycle): resolves a 409/404 by
// preserving the stale snapshot as a recovered copy. Takes push()'s own
// captured generation (the second argument) so recoverSnapshot checks
// against the generation this specific push started under, rather than
// reading a fresh value that would trivially match "whatever is current".
let onConflict: ((snapshot: DocSnapshot, gen: number) => Promise<void>) | null = null
// Deliberately NOT cleared by invalidateDocumentWork(): it holds document ids
// only, never content, so unlike every other piece of state in this module
// there is nothing here for a session end to leak across users. Leaving it
// populated across a session boundary just means a fallback-named document
// that already attempted (and, say, failed) auto-titling won't retry within
// the same browser tab's lifetime — a minor, same-document-only quirk, not a
// cross-user concern.
const titleAttempted = new Set<number>()

// Bumped by invalidateDocumentWork() (documents.ts), called from logout()
// and expireSession() only — never from login(), which never invalidates.
// Cancelling the debounce and retry timers stops future writes, but a push
// already in flight when a session ends is still awaiting
// `updateDocument()` — its completion captures this counter and no-ops if
// it no longer matches, so it cannot recreate the buffer for a user who has
// since logged out or whose token has expired.
let generation = 0
export function currentGeneration(): number {
  return generation
}
export function bumpGeneration(): void {
  generation++
}

/** Cancel the pending debounce timer (the backoff retry timer has its own
 * cancelRetry()). Called by documents.ts' invalidateDocumentWork(). */
export function cancelDebounce(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** Releases the coordination locks a push() in flight holds — `saving`,
 * `pending` and `inFlight` — so a save genuinely in flight when the session
 * ends cannot affect the incoming session: without this, `saving` stays
 * true until the stale push's own completion clears it, so every flush()
 * in the next session would wait on that stale request (forever if it
 * hangs) instead of pushing the incoming user's edits, and a `pending`
 * flush queued in the meantime would get silently cleared with
 * `succeeded === false` when the stale push finally settles. The stale
 * push's own finally block (see push() below) checks its captured
 * generation before touching this state again, so it cannot re-set what
 * this just cleared. Called by documents.ts' invalidateDocumentWork()
 * alongside the generation bump — the existing per-write generation guards
 * already stop stale *writes*; this stops the stale *coordination state*
 * from starving or clobbering the next session. */
export function resetCoordinationState(): void {
  saving = false
  pending = false
  inFlight = null
}

export function setConflictHandler(
  handler: (snapshot: DocSnapshot, gen: number) => Promise<void>,
): void {
  onConflict = handler
}

/** Suppress autosave while a document is being loaded into the editor. */
export function beginHydration(): void {
  hydrating = true
}

export function endHydration(): void {
  hydrating = false
}

export function resetAutosaveForTests(): void {
  if (timer) clearTimeout(timer)
  if (retryTimer) clearTimeout(retryTimer)
  timer = retryTimer = null
  retryDelay = RETRY_BASE_MS
  saving = pending = hydrating = false
  inFlight = null
  onConflict = null
  titleAttempted.clear()
  generation = 0
}

/** Assemble the current document's full state from editor + store. */
export function collectSnapshot(): DocSnapshot | null {
  const state = useStore.getState()
  const view = getEditorView()
  if (!view || !state.docMeta || !state.user) return null
  return {
    docId: state.docMeta.id,
    revision: state.docMeta.revision,
    dirty: true,
    name: state.docMeta.name,
    text: view.state.doc.toString(),
    findings: state.tracked.map((t) => ({
      finding: {
        ...t.finding,
        span: { ...t.finding.span, start: t.from, end: t.to },
      },
      from: t.from,
      to: t.to,
    })),
    scorecard: state.scorecard
      ? { card: state.scorecard, stale: state.scorecardStale }
      : null,
    ownerId: state.user.id,
    settings: settingsPayload(state),
  }
}

/** True when two snapshots carry the same document content — everything a
 * PUT would actually change (name, text, findings, scorecard, settings). */
function sameContent(a: DocSnapshot, b: DocSnapshot): boolean {
  const contentOf = (s: DocSnapshot) =>
    JSON.stringify({
      name: s.name,
      text: s.text,
      findings: s.findings,
      scorecard: s.scorecard,
      settings: s.settings,
    })
  return contentOf(a) === contentOf(b)
}

/** Editor/settings changed: buffer synchronously, save debounced. */
export function noteChange(): void {
  if (hydrating) return
  const snapshot = collectSnapshot()
  if (!snapshot) return
  writeSnapshot(snapshot)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flush(), DEBOUNCE_MS)
}

/** Save now (document switch, completed check, beforeunload). Waits for a
 * push already in flight (and the follow-up it queues) rather than firing a
 * concurrent PUT — a document switch needs the save to have truly landed
 * before it moves on. */
export async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (saving) {
    pending = true
    // The in-flight push's own finally block owns the follow-up push (see
    // `push` below); we just wait for the whole chain to settle instead of
    // starting a second, concurrent one.
    while (saving && inFlight) {
      await inFlight
    }
    return
  }
  const snapshot = collectSnapshot()
  if (!snapshot) return
  const buffered = readSnapshot()
  if (
    buffered &&
    !buffered.dirty &&
    buffered.docId === snapshot.docId &&
    buffered.revision === snapshot.revision &&
    sameContent(buffered, snapshot)
  ) {
    // Nothing changed since the last successful save: a redundant PUT here
    // (e.g. from an unconditional beforeunload flush on a plain reload)
    // could still be aborted client-side after the server durably applies
    // it, leaving the buffer dirty with a stale revision — see the
    // duplicate-recovered-document bug this guards against.
    return
  }
  writeSnapshot(snapshot)
  inFlight = push(snapshot)
  await inFlight
}

async function push(snapshot: DocSnapshot): Promise<void> {
  // Captured before the request goes out: invalidateDocumentWork() (logout
  // or expiry — login never calls it, see auth/session.ts) bumps this while
  // the PUT is in flight. Cancelling the debounce/retry timers cannot stop
  // a fetch already awaited, so the completion below must check for itself.
  const gen = currentGeneration()
  saving = true
  let succeeded = false
  let overLimit = false
  try {
    const updated = await updateDocument(snapshot.docId, {
      revision: snapshot.revision,
      content: {
        text: snapshot.text,
        findings: snapshot.findings,
        scorecard: snapshot.scorecard,
      },
      settings: snapshot.settings,
    })
    if (gen !== currentGeneration()) return // session ended: do not write
    retryDelay = RETRY_BASE_MS
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    const store = useStore.getState()
    if (store.docMeta?.id === snapshot.docId) {
      store.patchDocMeta({ revision: updated.revision })
      writeSnapshot({ ...snapshot, revision: updated.revision, dirty: false })
      store.patchDocumentSummary(snapshot.docId, {
        edited_at: updated.edited_at,
        checked_at: updated.checked_at,
      })
    }
    await maybeGenerateTitle(snapshot)
    succeeded = true
  } catch (error) {
    if (gen !== currentGeneration()) return // session ended: no retry, no recovery
    if (
      error instanceof HttpError &&
      (error.status === 409 || error.status === 404)
    ) {
      try {
        await onConflict?.(snapshot, gen)
      } catch {
        // Silent: buffer stays as the handler left it.
      }
    } else if (error instanceof HttpError && error.status === 413) {
      // Every 413 is permanent for the CURRENT snapshot, coded or not: over
      // limits.max_document_chars ('document_too_large') is deterministic
      // until the text shrinks back under the cap, but the byte-budget
      // middleware's uncoded 413 (the whole JSON body — text + findings +
      // scorecard — crosses its own budget, even with text under the char
      // cap) is equally deterministic for THIS snapshot: re-sending the
      // identical oversized payload every ~30s is just as futile. So no
      // backoff retry is scheduled here for either case. The snapshot is
      // left dirty (as written before this push started); any edit OR a
      // completed check produces a new snapshot (different text, findings,
      // or scorecard), and that snapshot's own noteChange()/flush() call
      // naturally triggers a fresh save attempt, which succeeds once the new
      // snapshot is back under budget. The Task 9 char-count threshold mark
      // already gives the user a visible signal for the char-cap case.
      // (`overLimit` lets the `finally` below tell this apart from the other
      // failure branches, which each already have their own way of picking
      // a pending edit back up — see the comment there.)
      //
      // The backend's structured `document_too_large` code is still kept —
      // it remains the right vocabulary for future UI surfacing (e.g.
      // distinguishing the two causes in a message) — but the retry
      // decision no longer branches on it: every 413 takes this branch.
      overLimit = true
    } else {
      scheduleRetry()
    }
  } finally {
    // Guarded by the captured generation: invalidateDocumentWork() may have
    // already reset `saving`/`pending`/`inFlight` for the incoming session
    // (resetCoordinationState() above) while this push was still awaiting
    // its request. If so, this push's own generation no longer matches and
    // this block must leave that state alone rather than clobbering
    // whatever the incoming session has since done with it.
    if (gen === currentGeneration()) {
      saving = false
      if (pending) {
        pending = false
        // A failed push already scheduled a backoff retry timer (or handed
        // off to the conflict handler); firing an immediate flush here would
        // bypass that backoff. The already-scheduled retry re-collects the
        // latest snapshot, so no edits are lost.
        if (succeeded) {
          // Awaited (not fire-and-forget): keeps `inFlight` — and hence any
          // flush() callers waiting on it — pending until this follow-up
          // push has also settled.
          await flush()
        } else if (overLimit) {
          // The 413 branch above deliberately schedules no retry — but
          // `pending` firing here means some *other* flush() call (e.g. the
          // debounce timer from a further edit) arrived while this doomed
          // PUT was in flight, and its own debounce timer has already fired
          // getting it here, so nothing else will pick it up. Only act if
          // that edit actually changed the content: an unrelated flush()
          // (say, beforeunload) that saw nothing new must stay passive
          // rather than re-send this same rejected snapshot. Scheduled
          // through the normal debounce, not an immediate flush, so it goes
          // through the same path (and cap check) as any other edit.
          const buffered = readSnapshot()
          if (buffered && !sameContent(buffered, snapshot)) {
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => void flush(), DEBOUNCE_MS)
          }
        }
      }
    }
  }
}

function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flush()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
}

/** Cancel a pending backoff retry; the caller takes over responsibility
 * for the buffered snapshot (e.g. the orphan replay on document switch). */
export function cancelRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  retryDelay = RETRY_BASE_MS
}

/** Fire the one-shot LLM titling once a fallback-named doc has enough text.
 * Called from push() after push()'s own generation check already passed,
 * but this makes its own network call (generateDocumentName) and so needs
 * its own guard on the write after that call resolves — push()'s check,
 * taken before this function was even called, cannot cover an invalidation
 * that happens during this await. */
async function maybeGenerateTitle(snapshot: DocSnapshot): Promise<void> {
  const meta = useStore.getState().docMeta
  if (!meta || meta.id !== snapshot.docId) return
  if (meta.nameSource !== 'fallback') return
  if (titleAttempted.has(meta.id)) return
  if (wordCount(snapshot.text) < TITLE_WORD_THRESHOLD) return
  titleAttempted.add(meta.id)
  const gen = currentGeneration()
  try {
    const doc = await generateDocumentName(meta.id)
    // Naming spends quota — including a backend-silent provider-failure
    // fallback, which still returns 200 — so the indicator must refresh on
    // every resolution, success or fallback alike, not just a written one.
    refreshUserNow()
    if (gen !== currentGeneration()) return // session ended: do not write
    const store = useStore.getState()
    if (store.docMeta?.id === doc.id) {
      store.patchDocMeta({ name: doc.name, nameSource: doc.name_source })
    }
    useStore.getState().patchDocumentSummary(doc.id, { name: doc.name })
  } catch (error) {
    // Silent per spec; a later session may retry. A 429 is transient (the
    // gate's own concurrency/quota backpressure, newly reachable in M5), so
    // undo the attempted-mark and let a later save try again; any other
    // failure keeps the suppression for the rest of this session.
    if (error instanceof HttpError && error.status === 429) {
      titleAttempted.delete(meta.id)
    }
  }
}
