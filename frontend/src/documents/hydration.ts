import {
  createDocument as apiCreateDocument,
  getDocument,
  HttpError,
  updateDocument,
  type DocumentFull,
} from '../api/client'
import { cancelCheck } from '../checking/controller'
import { getEditorView } from '../editor/editorRef'
import { setFindingsEffect } from '../editor/findings'
import { currentMessages } from '../i18n'
import { useStore } from '../state/store'
import {
  beginHydration,
  cancelRetry,
  collectSnapshot,
  currentGeneration,
  endHydration,
} from './autosave'
import {
  clearSnapshot,
  readSnapshot,
  writeSnapshot,
  type DocSnapshot,
} from './buffer'
import { refreshDocuments } from './list'
import { setProfileApplySuppressed } from './profileApply'

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

/** The fields hydration actually consumes — the offline path must not have
 * to fabricate owner ids or timestamps it doesn't have. */
export type HydrateSource = Omit<
  DocumentFull,
  'owner_id' | 'created_at' | 'updated_at' | 'edited_at' | 'checked_at' | 'folder_id'
>

/** Load a document into store + editor. The editor change and the restored
 * findings ride ONE transaction, so spans apply to the new text. */
export async function hydrateFromDocument(doc: HydrateSource): Promise<void> {
  // Callers on the deferred-init path (documents.ts' runInit()) already
  // check freshness immediately before calling in here — but
  // replayOrphanedSnapshot below makes its own network call (a PUT), and a
  // session ending during that call is not caught by the caller's earlier
  // check. Everything this function writes afterwards is synchronous, so
  // one guard right after that await covers the rest of the function.
  const gen = currentGeneration()
  cancelCheck() // any in-flight check belongs to the outgoing document
  await replayOrphanedSnapshot(doc.id)
  if (gen !== currentGeneration()) return // session ended while replaying the orphan
  beginHydration()
  try {
    const store = useStore.getState()
    setProfileApplySuppressed(doc.language !== store.language)
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
export async function hydrateFromBuffer(snapshot: DocSnapshot): Promise<void> {
  await hydrateFromDocument({
    id: snapshot.docId,
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
  })
  // hydrate marked the buffer clean; restore the dirty truth so the retry
  // loop keeps pushing it.
  writeSnapshot(snapshot)
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
export async function recoverSnapshot(snapshot: DocSnapshot): Promise<void> {
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
