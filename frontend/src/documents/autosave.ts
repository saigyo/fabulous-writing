import {
  generateDocumentName,
  HttpError,
  updateDocument,
} from '../api/client'
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
// preserving the stale snapshot as a recovered copy.
let onConflict: ((snapshot: DocSnapshot) => Promise<void>) | null = null
const titleAttempted = new Set<number>()

// Bumped by invalidateDocumentWork() (auth/session.ts, via
// documents.ts). Cancelling the debounce and retry timers stops future
// writes, but a push already in flight when a session ends is still
// awaiting `updateDocument()` — its completion captures this counter and
// no-ops if it no longer matches, so it cannot recreate the buffer for a
// user who has since logged out or been replaced.
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

export function setConflictHandler(
  handler: (snapshot: DocSnapshot) => Promise<void>,
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
  // Captured before the request goes out: invalidateDocumentWork() (logout,
  // expiry, or a login that changes the user) bumps this while the PUT is
  // in flight. Cancelling the debounce/retry timers cannot stop a fetch
  // already awaited, so the completion below must check for itself.
  const gen = currentGeneration()
  saving = true
  let succeeded = false
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
        await onConflict?.(snapshot)
      } catch {
        // Silent: buffer stays as the handler left it.
      }
    } else {
      scheduleRetry()
    }
  } finally {
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

/** Fire the one-shot LLM titling once a fallback-named doc has enough text. */
async function maybeGenerateTitle(snapshot: DocSnapshot): Promise<void> {
  const meta = useStore.getState().docMeta
  if (!meta || meta.id !== snapshot.docId) return
  if (meta.nameSource !== 'fallback') return
  if (titleAttempted.has(meta.id)) return
  if (wordCount(snapshot.text) < TITLE_WORD_THRESHOLD) return
  titleAttempted.add(meta.id)
  try {
    const doc = await generateDocumentName(meta.id)
    const store = useStore.getState()
    if (store.docMeta?.id === doc.id) {
      store.patchDocMeta({ name: doc.name, nameSource: doc.name_source })
    }
    useStore.getState().patchDocumentSummary(doc.id, { name: doc.name })
  } catch {
    // Silent per spec; a later session may retry.
  }
}
