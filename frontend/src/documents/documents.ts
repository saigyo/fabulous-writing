import {
  createDocument as apiCreateDocument,
  deleteDocument as apiDeleteDocument,
  deleteFolder as apiDeleteFolder,
  getDocument,
  HttpError,
  listDocuments,
  moveDocument as apiMoveDocument,
  updateDocument,
  type DocumentCreatePayload,
  type DocumentFull,
  type DocumentSummary,
} from '../api/client'
import { currentMessages } from '../i18n'
import { useStore } from '../state/store'
import {
  bumpGeneration,
  cancelDebounce,
  cancelRetry,
  currentGeneration,
  flush,
  resetCoordinationState,
  setConflictHandler,
} from './autosave'
import { clearSnapshot, readSnapshot, writeSnapshot } from './buffer'
import { applyFolderDefaults } from './folders'
import { hydrateFromBuffer, hydrateFromDocument, recoverSnapshot } from './hydration'
import { refreshDocuments, refreshFolders, summaryOf } from './list'
import { resetProfileApplySuppression } from './profileApply'
import { settingsPayload } from './settings'

const LEGACY_TEXT_KEY = 'fabulous-writing-text'

// Memoises the run started by initDocuments() so StrictMode's double mount
// effect (and any other re-entrant caller) shares one run instead of
// double-creating documents and double-replaying the dirty buffer. Cleared
// by that run's own `.finally()` — see initDocuments() — and also by
// invalidateDocumentWork() below, since a stale run's `.finally` clearing it
// again (after a fresh one has already started) would otherwise clobber the
// fresh run's slot; the `.finally` guards against that by only clearing the
// slot if it still points at itself.
let initInFlight: Promise<void> | null = null

/** Removes the pre-multi-document editor buffer. Exported for auth/session.ts
 * — documents.ts is the module that owns LEGACY_TEXT_KEY. */
export function clearLegacyText(): void {
  localStorage.removeItem(LEGACY_TEXT_KEY)
}

/** Invalidates all pending and in-flight document work: cancels the
 * debounce and backoff-retry timers so no queued write fires again, bumps
 * the generation counter so work already in flight — which cancelling a
 * timer cannot stop — no-ops instead of recreating the buffer for a session
 * that has since ended, releases autosave's coordination locks (`saving`,
 * `pending`, `inFlight`) so a save genuinely in flight cannot block or drop
 * the incoming session's own flush() (see resetCoordinationState()), and
 * clears the memoised initDocuments() run. That last part matters on its
 * own: without it, a logout mid-initDocuments() leaves `initInFlight`
 * holding the stale (already-invalidated) run, so the next mount's
 * `initInFlight ??=` hands the new user's mount that same stale promise
 * instead of starting a fresh run — the new user's document list and
 * folders then never initialise at all. Also resets the one-shot
 * profile-apply suppression (see profileApply.ts's
 * resetProfileApplySuppression()): otherwise a suppression armed by the
 * outgoing session's hydration and still pending when it ends could be
 * consumed by the incoming session's own profile fetch instead. Called by
 * logout(), expireSession(), and login()'s user-change branch (Copilot
 * round 12 — a cross-user login leaves an in-flight check's SSE
 * subscription and the generation guard it relies on otherwise untouched,
 * see session.ts's own comment) — auth/session.ts, never directly by UI
 * code. */
export function invalidateDocumentWork(): void {
  cancelDebounce()
  cancelRetry()
  bumpGeneration()
  resetCoordinationState()
  resetProfileApplySuppression()
  initInFlight = null
}

/** Mirrors the backend rule in app/services/naming.py. */
export function fallbackName(text: string): string | null {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return words.slice(0, 6).join(' ').slice(0, 40).trim() || null
}

export async function removeFolder(id: number): Promise<void> {
  await apiDeleteFolder(id)
  // Members moved to ungrouped server-side; refresh both lists.
  await refreshFolders()
  await refreshDocuments()
}

export async function moveDocumentToFolder(
  id: number,
  folderId: number | null,
): Promise<void> {
  // Captured before the request goes out: a session ending mid-request must
  // not land a false error banner into the incoming user's sidebar. The 422
  // branch's own refreshFolders()/refreshDocuments() calls already guard
  // their writes internally (see list.ts), so the plain error write below
  // needs its own check. The success-path write further down needs none: it
  // re-reads the store fresh (not a pre-await closure) and updates by id, the
  // same reasoning removeDocument() spells out below.
  const gen = currentGeneration()
  let moved: DocumentFull
  try {
    moved = await apiMoveDocument(id, folderId)
  } catch (error) {
    if (gen !== currentGeneration()) return // session ended: nothing to report
    if (error instanceof HttpError && error.status === 422) {
      // The target folder vanished meanwhile: drop the stale entry from
      // the submenu and re-sync memberships.
      await refreshFolders()
      await refreshDocuments()
    } else {
      useStore.getState().setDocListError(true)
    }
    return
  }
  // Fresh read (not a pre-await closure) and an id-keyed .map: a stale
  // `store.documents` here still only ever updates `id` within whatever the
  // store *currently* holds, so this needs no generation check of its own.
  const store = useStore.getState()
  store.setDocuments(
    store.documents.map((d) =>
      d.id === id ? { ...d, folder_id: moved.folder_id } : d,
    ),
  )
}

// gen defaults to a fresh currentGeneration() read: called with no argument,
// that's exactly right for a UI-triggered call (the button click is *the*
// start of this operation, nothing came before it to be stale relative to).
// A caller further down this file that is itself mid-operation (runInit(),
// removeDocument()) passes its own already-captured value instead, so this
// function is checked against what its caller started with, not against
// "whatever is current when this function happens to run".
export async function openDocument(id: number, gen: number = currentGeneration()): Promise<void> {
  await flush()
  // flush() can await a save left in flight by the outgoing session; a
  // logout or expiry landing inside that await must stop this before it
  // fetches the outgoing user's document under the incoming session.
  if (gen !== currentGeneration()) return // session ended while flush() was in flight
  const doc = await getDocument(id)
  if (gen !== currentGeneration()) return // session ended while fetching the document
  await hydrateFromDocument(doc, gen)
}

export async function createNewDocument(
  folderId?: number,
  gen: number = currentGeneration(),
): Promise<void> {
  await flush()
  // flush() can await a save left in flight by the outgoing session; a
  // logout or expiry landing inside that await must stop this here, before
  // the POST below — the post-request check further down is too late to
  // prevent the server-side write, it only hides the already-created
  // document from the UI.
  if (gen !== currentGeneration()) return // session ended while flush() was in flight
  const state = useStore.getState()
  const base: DocumentCreatePayload = {
    name: currentMessages().docUntitled,
    ...settingsPayload(state),
    ...(folderId !== undefined ? { folder_id: folderId } : {}),
  }
  const folder =
    folderId !== undefined
      ? state.folders.find((f) => f.id === folderId)
      : undefined
  const doc = await apiCreateDocument(applyFolderDefaults(base, folder))
  // `state` was captured before the await above: if the session turned over
  // while apiCreateDocument was in flight, `state.documents` is the OUTGOING
  // user's stale list, and resetSessionState() has already cleared the real
  // store to []. Writing `[summaryOf(doc), ...state.documents]` here would
  // resurrect that stale list on top of the incoming user's (already
  // correctly empty) one — so this has to be skipped entirely, not merely
  // re-read, when the generation no longer matches.
  if (gen !== currentGeneration()) return
  useStore.getState().setDocuments([summaryOf(doc), ...state.documents])
  await hydrateFromDocument(doc, gen)
}

export async function renameDocument(id: number, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  const meta = useStore.getState().docMeta
  // The open document's revision is known; other documents need a fetch.
  const revision =
    meta?.id === id ? meta.revision : (await getDocument(id)).revision
  const updated = await updateDocument(id, { revision, name: trimmed })
  const store = useStore.getState()
  if (store.docMeta?.id === id) {
    store.patchDocMeta({
      name: updated.name,
      nameSource: updated.name_source,
      revision: updated.revision,
    })
  }
  store.patchDocumentSummary(id, {
    name: updated.name,
    edited_at: updated.edited_at,
  })
}

export async function removeDocument(id: number, gen: number = currentGeneration()): Promise<void> {
  // A dirty buffered snapshot for the document being deleted must not
  // survive the delete: left in place, it would later replay via
  // replayOrphanedSnapshot, 404 against the now-gone document, and
  // resurrect it as a "(recovered)" copy.
  if (readSnapshot()?.docId === id) {
    cancelRetry()
    clearSnapshot()
  }
  await apiDeleteDocument(id)
  // Unlike createNewDocument(), this re-reads the store fresh (not a
  // pre-await closure) and document ids are globally unique, so a stale
  // `remaining` list still only ever removes `id` from whatever the store
  // *currently* holds — already correctly empty for a different session by
  // the time this runs. Nothing here needs its own generation check; `gen`
  // is only threaded through to satisfy hydrateFromDocument()'s /
  // createNewDocument()'s own guards below.
  const store = useStore.getState()
  const remaining = store.documents.filter((d) => d.id !== id)
  store.setDocuments(remaining)
  if (store.docMeta?.id !== id) return
  if (remaining.length > 0) {
    const doc = await getDocument(remaining[0].id)
    await hydrateFromDocument(doc, gen)
  } else {
    useStore.getState().setDocMeta(null)
    await createNewDocument(undefined, gen)
  }
}

/** App startup: replay dirty buffer, fetch list, migrate legacy text,
 * open the last-open (or most recent) document. */
export function initDocuments(): Promise<void> {
  if (!initInFlight) {
    // StrictMode double-invokes the mount effect; concurrent runs would
    // double-create documents and double-replay the dirty buffer.
    const run: Promise<void> = runInit().finally(() => {
      // Only clear the slot if it still points at this run: if
      // invalidateDocumentWork() already cleared it and a fresh run has
      // since been assigned, this stale run's own completion must not
      // clobber that fresh run's slot.
      if (initInFlight === run) initInFlight = null
    })
    initInFlight = run
  }
  return initInFlight
}

async function runInit(): Promise<void> {
  // Captured before any await: invalidateDocumentWork() (logout or expiry —
  // login never calls it, see auth/session.ts) bumps this while a fetch
  // below is still pending. Every write past an await checks it first, so
  // a run started for one session cannot land its writes into the next.
  const gen = currentGeneration()
  const stillCurrent = () => gen === currentGeneration()

  setConflictHandler(recoverSnapshot)
  const buffered = readSnapshot()
  if (buffered?.dirty) {
    try {
      const updated = await updateDocument(buffered.docId, {
        revision: buffered.revision,
        content: {
          text: buffered.text,
          findings: buffered.findings,
          scorecard: buffered.scorecard,
        },
        settings: buffered.settings,
      })
      if (!stillCurrent()) return
      writeSnapshot({ ...buffered, revision: updated.revision, dirty: false })
    } catch (error) {
      if (!stillCurrent()) return
      if (
        error instanceof HttpError &&
        (error.status === 409 || error.status === 404)
      ) {
        // stillCurrent() above is a fast path only (skip the call entirely
        // when already stale) — the real protection is recoverSnapshot's
        // own internal checks against the threaded `gen`, which cover
        // invalidation happening during recoverSnapshot's own awaits too.
        await recoverSnapshot(buffered, gen)
      }
      // Other failures: backend down; the offline path below takes over.
    }
  }

  let documents: DocumentSummary[]
  try {
    documents = await listDocuments()
  } catch {
    if (!stillCurrent()) return
    useStore.getState().setDocListError(true)
    const snapshot = readSnapshot()
    if (snapshot) {
      await hydrateFromBuffer(snapshot, gen)
      if (!stillCurrent()) return // hydrateFromBuffer no-op'd; nothing to arm
      // The buffer is dirty (offline edits pending) and hydrateFromBuffer
      // restored that dirty truth: arm the backoff retry loop now so the
      // push happens as soon as the backend comes back, even with no
      // further user input. Without this, a dirty buffer at offline
      // startup would sit inert until the user typed again. Guarded above
      // by stillCurrent() rather than relying on collectSnapshot()
      // incidentally returning null once user is nulled — logout()/
      // expireSession() are the only current callers of
      // invalidateDocumentWork(), but this must not depend on that.
      void flush()
    }
    return
  }
  if (!stillCurrent()) return
  useStore.getState().setDocListError(false)
  await refreshFolders()
  if (!stillCurrent()) return

  if (documents.length === 0) {
    const legacy = localStorage.getItem(LEGACY_TEXT_KEY)
    if (legacy?.trim()) {
      const state = useStore.getState()
      let doc: DocumentFull
      try {
        doc = await apiCreateDocument({
          name: fallbackName(legacy) ?? currentMessages().docUntitled,
          text: legacy,
          ...settingsPayload(state),
        })
      } catch {
        // The migration create failed: leave the legacy text in place (it
        // would otherwise be permanently lost) and surface the retry
        // surface via the doc-list error, same as the offline path.
        if (!stillCurrent()) return
        useStore.getState().setDocListError(true)
        return
      }
      if (!stillCurrent()) return
      // Only drop the legacy key once the migration has actually landed.
      clearLegacyText()
      useStore.getState().setDocuments([summaryOf(doc)])
      await hydrateFromDocument(doc, gen)
      return
    }
    if (!stillCurrent()) return
    await createNewDocument(undefined, gen)
    return
  }

  clearLegacyText()
  useStore.getState().setDocuments(documents)
  const persistedId = useStore.getState().currentDocId
  const target = documents.find((d) => d.id === persistedId) ?? documents[0]
  const doc = await getDocument(target.id)
  if (!stillCurrent()) return
  await hydrateFromDocument(doc, gen)
}
