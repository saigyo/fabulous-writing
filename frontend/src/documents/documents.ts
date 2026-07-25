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
  setConflictHandler,
} from './autosave'
import { clearSnapshot, readSnapshot, writeSnapshot } from './buffer'
import { applyFolderDefaults } from './folders'
import { hydrateFromBuffer, hydrateFromDocument, recoverSnapshot } from './hydration'
import { refreshDocuments, refreshFolders, summaryOf } from './list'
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
 * that has since ended, and clears the memoised initDocuments() run. That
 * last part matters on its own: without it, a logout mid-initDocuments()
 * leaves `initInFlight` holding the stale (already-invalidated) run, so the
 * next mount's `initInFlight ??=` hands the new user's mount that same
 * stale promise instead of starting a fresh run — the new user's document
 * list and folders then never initialise at all. Called by logout() and
 * expireSession() (auth/session.ts), never directly by UI code. */
export function invalidateDocumentWork(): void {
  cancelDebounce()
  cancelRetry()
  bumpGeneration()
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
  let moved: DocumentFull
  try {
    moved = await apiMoveDocument(id, folderId)
  } catch (error) {
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
  const store = useStore.getState()
  store.setDocuments(
    store.documents.map((d) =>
      d.id === id ? { ...d, folder_id: moved.folder_id } : d,
    ),
  )
}

export async function openDocument(id: number): Promise<void> {
  await flush()
  const doc = await getDocument(id)
  await hydrateFromDocument(doc)
}

export async function createNewDocument(folderId?: number): Promise<void> {
  await flush()
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
  useStore.getState().setDocuments([summaryOf(doc), ...state.documents])
  await hydrateFromDocument(doc)
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

export async function removeDocument(id: number): Promise<void> {
  // A dirty buffered snapshot for the document being deleted must not
  // survive the delete: left in place, it would later replay via
  // replayOrphanedSnapshot, 404 against the now-gone document, and
  // resurrect it as a "(recovered)" copy.
  if (readSnapshot()?.docId === id) {
    cancelRetry()
    clearSnapshot()
  }
  await apiDeleteDocument(id)
  const store = useStore.getState()
  const remaining = store.documents.filter((d) => d.id !== id)
  store.setDocuments(remaining)
  if (store.docMeta?.id !== id) return
  if (remaining.length > 0) {
    const doc = await getDocument(remaining[0].id)
    await hydrateFromDocument(doc)
  } else {
    useStore.getState().setDocMeta(null)
    await createNewDocument()
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
        await recoverSnapshot(buffered)
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
      await hydrateFromBuffer(snapshot)
      // The buffer is dirty (offline edits pending) and hydrateFromBuffer
      // restored that dirty truth: arm the backoff retry loop now so the
      // push happens as soon as the backend comes back, even with no
      // further user input. Without this, a dirty buffer at offline
      // startup would sit inert until the user typed again.
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
      await hydrateFromDocument(doc)
      return
    }
    if (!stillCurrent()) return
    await createNewDocument()
    return
  }

  clearLegacyText()
  useStore.getState().setDocuments(documents)
  const persistedId = useStore.getState().currentDocId
  const target = documents.find((d) => d.id === persistedId) ?? documents[0]
  const doc = await getDocument(target.id)
  if (!stillCurrent()) return
  await hydrateFromDocument(doc)
}
