import {
  generateDocumentName,
  HttpError,
  updateDocument,
} from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { wordCount } from '../scoring/score'
import { useStore } from '../state/store'
import { writeSnapshot, type DocSnapshot } from './buffer'

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
}

/** Assemble the current document's full state from editor + store. */
export function collectSnapshot(): DocSnapshot | null {
  const state = useStore.getState()
  const view = getEditorView()
  if (!view || !state.docMeta) return null
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
    settings: {
      language: state.language,
      profile_id: state.profileId,
      domain_ids: state.domainIds,
      llm_provider: state.tier === null ? state.provider : null,
      llm_model: state.tier === null ? state.model : null,
      llm_tier: state.tier,
      llm_auto: state.llmAuto,
    },
  }
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
  writeSnapshot(snapshot)
  inFlight = push(snapshot)
  await inFlight
}

async function push(snapshot: DocSnapshot): Promise<void> {
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
    retryDelay = RETRY_BASE_MS
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    const store = useStore.getState()
    if (store.docMeta?.id === snapshot.docId) {
      store.patchDocMeta({ revision: updated.revision })
      writeSnapshot({ ...snapshot, revision: updated.revision, dirty: false })
      store.touchDocument(snapshot.docId)
    }
    await maybeGenerateTitle(snapshot)
    succeeded = true
  } catch (error) {
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
    store.touchDocument(doc.id, doc.name)
  } catch {
    // Silent per spec; a later session may retry.
  }
}
