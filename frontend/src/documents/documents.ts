import {
  createDocument as apiCreateDocument,
  createFolder as apiCreateFolder,
  deleteDocument as apiDeleteDocument,
  deleteFolder as apiDeleteFolder,
  renameFolder as apiRenameFolder,
  getDocument,
  HttpError,
  listDocuments,
  listFolders,
  moveDocument as apiMoveDocument,
  putFolderDefaults,
  updateDocument,
  type DocumentCreatePayload,
  type DocumentFull,
  type DocumentSummary,
  type Folder,
  type FolderDefaults,
} from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { setFindingsEffect } from '../editor/findings'
import { currentMessages } from '../i18n'
import { useStore } from '../state/store'
import type { Profile } from '../types'
import {
  beginHydration,
  cancelRetry,
  collectSnapshot,
  endHydration,
  flush,
  setConflictHandler,
} from './autosave'
import {
  clearSnapshot,
  readSnapshot,
  writeSnapshot,
  type DocSnapshot,
} from './buffer'

const LEGACY_TEXT_KEY = 'fabulous-writing-text'

// One-shot flag: opening a document that switches the language must not let
// the Header's profile effect overwrite the document's own LLM settings.
let suppressProfileApply = false

export function consumeProfileApplySuppression(): boolean {
  const value = suppressProfileApply
  suppressProfileApply = false
  return value
}

/** Header's language-switch effect calls this once it has picked which
 * profile to show. Normally a real language switch applies the profile's
 * values to the header selectors (autosaving them onto the document). But
 * when opening a document supplied no profile (profileId is still null —
 * e.g. its profile_id was pruned server-side because the profile was
 * deleted) and this apply is suppressed (see consumeProfileApplySuppression),
 * the selection is for DISPLAY only: still show `chosen` as selected, but do
 * not let the settings-autosave subscription (App.tsx) persist it onto the
 * document. beginHydration/endHydration gate that subscription's noteChange
 * call for the (synchronous, zustand v5) duration of the state update. */
export function applyHeaderProfileSelection(
  selectProfile: (profile: Profile, apply: boolean) => void,
  chosen: Profile,
  isSwitch: boolean,
): void {
  const suppressed = consumeProfileApplySuppression()
  if (suppressed && useStore.getState().profileId === null) {
    beginHydration()
    try {
      selectProfile(chosen, false)
    } finally {
      endHydration()
    }
  } else {
    selectProfile(chosen, isSwitch && !suppressed)
  }
}

/** Mirrors the backend rule in app/services/naming.py. */
export function fallbackName(text: string): string | null {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return words.slice(0, 6).join(' ').slice(0, 40).trim() || null
}

function summaryOf(doc: DocumentFull): DocumentSummary {
  return {
    id: doc.id,
    name: doc.name,
    language: doc.language,
    folder_id: doc.folder_id,
    created_at: doc.created_at,
    edited_at: doc.edited_at,
    checked_at: doc.checked_at,
    updated_at: doc.updated_at,
  }
}

function currentSettings() {
  const state = useStore.getState()
  return {
    profile_id: state.profileId,
    domain_ids: state.domainIds,
    llm_provider: state.tier === null ? state.provider : null,
    llm_model: state.tier === null ? state.model : null,
    llm_tier: state.tier,
    llm_auto: state.llmAuto,
  }
}

// Set while an orphan-replay's conflict recovery is running so recoverSnapshot
// doesn't also re-hydrate: we're already in the middle of hydrating a
// different, unrelated target document and must not re-enter hydration for
// the document the orphaned snapshot belonged to.
let skipRecoveryHydrate = false

/** The buffer is a single slot for the CURRENT document only. If it still
 * holds a dirty snapshot for a document other than the one about to be
 * hydrated (e.g. the user switched documents while a save was failing),
 * that snapshot is about to be silently overwritten. Give it one direct
 * replay attempt first so the edits aren't lost. */
async function replayOrphanedSnapshot(targetDocId: number): Promise<void> {
  const existing = readSnapshot()
  if (!existing?.dirty || existing.docId === targetDocId) return
  // Take sole ownership of the orphaned snapshot: a pending backoff retry
  // for the previous document would otherwise race this direct PUT.
  cancelRetry()
  try {
    await updateDocument(existing.docId, {
      revision: existing.revision,
      content: {
        text: existing.text,
        findings: existing.findings,
        scorecard: existing.scorecard,
      },
      settings: existing.settings,
    })
  } catch (error) {
    if (
      error instanceof HttpError &&
      (error.status === 409 || error.status === 404)
    ) {
      skipRecoveryHydrate = true
      try {
        await recoverSnapshot(existing)
      } finally {
        skipRecoveryHydrate = false
      }
    }
    // Any other failure (offline/network): accepted limitation per spec —
    // the buffer is a single slot by design (current document only), so an
    // unsaved snapshot cannot survive an offline document switch. Drop it;
    // hydrating the target document below overwrites the buffer anyway.
  }
}

/** Load a document into store + editor. The editor change and the restored
 * findings ride ONE transaction, so spans apply to the new text. */
async function hydrateFromDocument(doc: DocumentFull): Promise<void> {
  await replayOrphanedSnapshot(doc.id)
  beginHydration()
  try {
    const store = useStore.getState()
    suppressProfileApply = doc.language !== store.language
    useStore.setState({
      language: doc.language,
      domainIds: doc.domain_ids,
      provider: doc.llm_provider ?? store.provider,
      model: doc.llm_model,
      tier: doc.llm_tier,
      llmAuto: doc.llm_auto,
      profileId: doc.profile_id,
      ...(doc.profile_id !== null
        ? {
            lastProfileByLanguage: {
              ...store.lastProfileByLanguage,
              [doc.language]: doc.profile_id,
            },
          }
        : {}),
    })
    useStore.getState().setDocMeta({
      id: doc.id,
      name: doc.name,
      nameSource: doc.name_source,
      revision: doc.revision,
    })
    const view = getEditorView()
    if (view) {
      const findings = doc.last_findings.map((saved) => ({
        ...saved.finding,
        span: { ...saved.finding.span, start: saved.from, end: saved.to },
      }))
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc.text },
        effects: setFindingsEffect.of(findings),
      })
    }
    if (doc.scorecard) {
      useStore.getState().setScorecard(doc.scorecard.card)
      if (doc.scorecard.stale) useStore.getState().markScorecardStale()
    } else {
      useStore.getState().clearScorecard()
    }
    const snapshot = collectSnapshot()
    if (snapshot) writeSnapshot({ ...snapshot, dirty: false })
  } finally {
    endHydration()
  }
}

/** Offline path: bring the buffered document up without a backend. */
async function hydrateFromBuffer(snapshot: DocSnapshot): Promise<void> {
  await hydrateFromDocument({
    id: snapshot.docId,
    owner_id: 1,
    name: snapshot.name,
    name_source: 'user', // conservative: no auto-titling while offline
    text: snapshot.text,
    language: snapshot.settings.language,
    profile_id: snapshot.settings.profile_id,
    domain_ids: snapshot.settings.domain_ids,
    llm_provider: snapshot.settings.llm_provider,
    llm_model: snapshot.settings.llm_model,
    llm_tier: snapshot.settings.llm_tier,
    llm_auto: snapshot.settings.llm_auto,
    last_findings: snapshot.findings,
    scorecard: snapshot.scorecard,
    folder_id: null,
    revision: snapshot.revision,
    created_at: '',
    updated_at: '',
    edited_at: '',
    checked_at: null,
  })
  // hydrate marked the buffer clean; restore the dirty truth so the retry
  // loop keeps pushing it.
  writeSnapshot(snapshot)
}

export async function refreshDocuments(): Promise<void> {
  try {
    useStore.getState().setDocuments(await listDocuments())
    useStore.getState().setDocListError(false)
  } catch {
    useStore.getState().setDocListError(true)
  }
}

export async function refreshFolders(): Promise<void> {
  try {
    useStore.getState().setFolders(await listFolders())
  } catch {
    useStore.getState().setDocListError(true)
  }
}

function sortedByName(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/** Overlay a folder's set defaults on a document-create payload. Unset
 * (null) defaults leave the header-derived values alone. Creation-time
 * only: moves never touch settings. */
export function applyFolderDefaults(
  payload: DocumentCreatePayload,
  folder: Folder | undefined,
): DocumentCreatePayload {
  if (!folder) return payload
  const out = { ...payload }
  if (folder.default_language !== null) {
    if (
      folder.default_language !== payload.language &&
      folder.default_profile_id === null
    ) {
      // The header profile belongs to the header language; it must not
      // leak onto a document created in a different default language.
      out.profile_id = null
    }
    out.language = folder.default_language
  }
  if (folder.default_profile_id !== null)
    out.profile_id = folder.default_profile_id
  if (folder.default_domain_ids !== null)
    out.domain_ids = folder.default_domain_ids
  const llmSet =
    folder.default_llm_provider !== null ||
    folder.default_llm_model !== null ||
    folder.default_llm_tier !== null
  if (llmSet) {
    // One composite unit, mirroring the header selector's pin-vs-tier model.
    out.llm_provider = folder.default_llm_provider
    out.llm_model = folder.default_llm_model
    out.llm_tier = folder.default_llm_tier
  }
  if (folder.default_llm_auto !== null) out.llm_auto = folder.default_llm_auto
  return out
}

/** Persist a folder's defaults (full replace) and update it in place.
 * Errors are rethrown: the defaults dialog shows them inline. */
export async function saveFolderDefaults(
  id: number,
  defaults: FolderDefaults,
): Promise<void> {
  const updated = await putFolderDefaults(id, defaults)
  const store = useStore.getState()
  store.setFolders(store.folders.map((f) => (f.id === id ? updated : f)))
}

/** Create a folder. Errors are rethrown: the sidebar shows a 409 inline. */
export async function addFolder(name: string): Promise<void> {
  const folder = await apiCreateFolder(name.trim())
  const store = useStore.getState()
  store.setFolders(sortedByName([...store.folders, folder]))
}

export async function renameFolderById(id: number, name: string): Promise<void> {
  const renamed = await apiRenameFolder(id, name.trim())
  const store = useStore.getState()
  store.setFolders(
    sortedByName(store.folders.map((f) => (f.id === id ? renamed : f))),
  )
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
    language: state.language,
    ...currentSettings(),
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

/** 409/404 resolution: the local snapshot becomes a recovered copy; the
 * server version wins in place. Lossless, deterministic, no dialogs.
 *
 * Before doing that, check whether this "conflict" is actually our own
 * write racing itself: a beforeunload flush can be aborted client-side
 * during navigation teardown after the server already durably applied it,
 * leaving the buffer dirty with a stale revision. The next replay of that
 * stale revision then gets a genuine 409/404 against content that is
 * byte-identical to what's already on the server — nothing to recover. */
async function recoverSnapshot(snapshot: DocSnapshot): Promise<void> {
  try {
    const server = await getDocument(snapshot.docId)
    if (server.text === snapshot.text) {
      clearSnapshot()
      await refreshDocuments()
      if (skipRecoveryHydrate) return
      if (useStore.getState().docMeta?.id !== snapshot.docId) return
      await hydrateFromDocument(server)
      return
    }
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 404)) throw error
    // The document is genuinely gone server-side: fall through to the
    // recovered-copy logic below, same as the existing 404 handling.
  }

  const copy = await apiCreateDocument({
    name: currentMessages().docRecovered(snapshot.name),
    name_source: 'user',
    text: snapshot.text,
    findings: snapshot.findings,
    scorecard: snapshot.scorecard,
    ...snapshot.settings,
  })
  clearSnapshot()
  await refreshDocuments()
  // Reached via replayOrphanedSnapshot: we're mid-hydration of an unrelated
  // target document, so this snapshot's own document must not be re-entered.
  if (skipRecoveryHydrate) return
  if (useStore.getState().docMeta?.id !== snapshot.docId) return
  try {
    const original = await getDocument(snapshot.docId)
    await hydrateFromDocument(original)
  } catch {
    // The original is gone server-side; the recovered copy takes over.
    await hydrateFromDocument(copy)
  }
}

let initInFlight: Promise<void> | null = null

/** App startup: replay dirty buffer, fetch list, migrate legacy text,
 * open the last-open (or most recent) document. */
export function initDocuments(): Promise<void> {
  // StrictMode double-invokes the mount effect; concurrent runs would
  // double-create documents and double-replay the dirty buffer.
  initInFlight ??= runInit().finally(() => {
    initInFlight = null
  })
  return initInFlight
}

async function runInit(): Promise<void> {
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
      writeSnapshot({ ...buffered, revision: updated.revision, dirty: false })
    } catch (error) {
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
  useStore.getState().setDocListError(false)
  await refreshFolders()

  if (documents.length === 0) {
    const legacy = localStorage.getItem(LEGACY_TEXT_KEY)
    if (legacy?.trim()) {
      const state = useStore.getState()
      let doc: DocumentFull
      try {
        doc = await apiCreateDocument({
          name: fallbackName(legacy) ?? currentMessages().docUntitled,
          language: state.language,
          text: legacy,
          ...currentSettings(),
        })
      } catch {
        // The migration create failed: leave the legacy text in place (it
        // would otherwise be permanently lost) and surface the retry
        // surface via the doc-list error, same as the offline path.
        useStore.getState().setDocListError(true)
        return
      }
      // Only drop the legacy key once the migration has actually landed.
      localStorage.removeItem(LEGACY_TEXT_KEY)
      useStore.getState().setDocuments([summaryOf(doc)])
      await hydrateFromDocument(doc)
      return
    }
    await createNewDocument()
    return
  }

  localStorage.removeItem(LEGACY_TEXT_KEY)
  useStore.getState().setDocuments(documents)
  const persistedId = useStore.getState().currentDocId
  const target = documents.find((d) => d.id === persistedId) ?? documents[0]
  const doc = await getDocument(target.id)
  await hydrateFromDocument(doc)
}
