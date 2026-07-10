import {
  createDocument as apiCreateDocument,
  deleteDocument as apiDeleteDocument,
  getDocument,
  HttpError,
  listDocuments,
  updateDocument,
  type DocumentFull,
  type DocumentSummary,
} from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { setFindingsEffect } from '../editor/findings'
import { currentMessages } from '../i18n'
import { useStore } from '../state/store'
import {
  beginHydration,
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

/** Load a document into store + editor. The editor change and the restored
 * findings ride ONE transaction, so spans apply to the new text. */
function hydrateFromDocument(doc: DocumentFull): void {
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
function hydrateFromBuffer(snapshot: DocSnapshot): void {
  hydrateFromDocument({
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
    revision: snapshot.revision,
    created_at: '',
    updated_at: '',
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

export async function openDocument(id: number): Promise<void> {
  await flush()
  const doc = await getDocument(id)
  hydrateFromDocument(doc)
}

export async function createNewDocument(): Promise<void> {
  await flush()
  const state = useStore.getState()
  const doc = await apiCreateDocument({
    name: currentMessages().docUntitled,
    language: state.language,
    ...currentSettings(),
  })
  useStore.getState().setDocuments([summaryOf(doc), ...state.documents])
  hydrateFromDocument(doc)
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
  store.touchDocument(id, updated.name)
}

export async function removeDocument(id: number): Promise<void> {
  await apiDeleteDocument(id)
  const store = useStore.getState()
  const remaining = store.documents.filter((d) => d.id !== id)
  store.setDocuments(remaining)
  if (store.docMeta?.id !== id) return
  if (remaining.length > 0) {
    const doc = await getDocument(remaining[0].id)
    hydrateFromDocument(doc)
  } else {
    useStore.getState().setDocMeta(null)
    await createNewDocument()
  }
}

/** 409/404 resolution: the local snapshot becomes a recovered copy; the
 * server version wins in place. Lossless, deterministic, no dialogs. */
async function recoverSnapshot(snapshot: DocSnapshot): Promise<void> {
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
  if (useStore.getState().docMeta?.id !== snapshot.docId) return
  try {
    const original = await getDocument(snapshot.docId)
    hydrateFromDocument(original)
  } catch {
    // The original is gone server-side; the recovered copy takes over.
    hydrateFromDocument(copy)
  }
}

/** App startup: replay dirty buffer, fetch list, migrate legacy text,
 * open the last-open (or most recent) document. */
export async function initDocuments(): Promise<void> {
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
    if (snapshot) hydrateFromBuffer(snapshot)
    return
  }
  useStore.getState().setDocListError(false)

  if (documents.length === 0) {
    const legacy = localStorage.getItem(LEGACY_TEXT_KEY)
    localStorage.removeItem(LEGACY_TEXT_KEY)
    if (legacy?.trim()) {
      const state = useStore.getState()
      const doc = await apiCreateDocument({
        name: fallbackName(legacy) ?? currentMessages().docUntitled,
        language: state.language,
        text: legacy,
        ...currentSettings(),
      })
      useStore.getState().setDocuments([summaryOf(doc)])
      hydrateFromDocument(doc)
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
  hydrateFromDocument(doc)
}
