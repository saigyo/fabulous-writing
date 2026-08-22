import {
  createDocument as apiCreateDocument,
  getDocument,
  HttpError,
  updateDocument,
  type DocumentFull,
} from '../api/client'
import { cancelCheck } from '../checking/controller'
import { getDocumentPort } from '../checking/documentPort'
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

/** The buffer is a single slot for the CURRENT document only. If it still
 * holds a dirty snapshot for a document other than the one about to be
 * hydrated (e.g. the user switched documents while a save was failing),
 * that snapshot is about to be silently overwritten. Give it one direct
 * replay attempt first so the edits aren't lost.
 *
 * `gen` is the caller's generation, captured before that caller's *first*
 * await — never re-read here — so a turnover that happened before this
 * function was even called is caught too, not just one that happens during
 * this function's own await. */
async function replayOrphanedSnapshot(targetDocId: number, gen: number): Promise<void> {
  const existing = readSnapshot()
  if (!existing?.dirty || existing.docId === targetDocId) return
  if (gen !== currentGeneration()) return // the session that owned this snapshot has ended
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
    if (gen !== currentGeneration()) return
    if (
      error instanceof HttpError &&
      (error.status === 409 || error.status === 404)
    ) {
      // skipHydrate=true: we're already in the middle of hydrating a
      // different, unrelated target document (the caller of
      // replayOrphanedSnapshot), so recoverSnapshot must not re-enter
      // hydration for the document this orphaned snapshot belonged to. This
      // is passed as a call-scoped argument rather than shared module state
      // — see recoverSnapshot's own doc comment for why a shared boolean
      // here previously let two overlapping recoveries corrupt each other.
      await recoverSnapshot(existing, gen, true)
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
 * findings ride ONE transaction, so spans apply to the new text.
 *
 * `gen` must be the CALLER's generation, captured before the caller's own
 * first await (e.g. documents.ts' openDocument() captures it before
 * `getDocument()`, not after) — never read fresh here. A generation read at
 * this function's own entry would equal "whatever is current right now" by
 * definition and could never detect that the `doc` this function was
 * *handed* already belongs to a session that ended while the caller was
 * still fetching it. Threading the caller's value is what makes this
 * function safe to call with already-stale data, not just data that goes
 * stale during its own execution. */
export async function hydrateFromDocument(doc: HydrateSource, gen: number): Promise<void> {
  if (gen !== currentGeneration()) return // already stale before we even started
  cancelCheck() // any in-flight check belongs to the outgoing document
  await replayOrphanedSnapshot(doc.id, gen)
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
    const port = getDocumentPort()
    if (port.hasDocument()) {
      const findings = doc.last_findings.map((saved) => ({
        ...saved.finding,
        span: { ...saved.finding.span, start: saved.from, end: saved.to },
      }))
      port.setDocument(doc.text, findings)
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
export async function hydrateFromBuffer(snapshot: DocSnapshot, gen: number): Promise<void> {
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
  }, gen)
  if (gen !== currentGeneration()) return // hydrateFromDocument no-op'd; nothing to restore
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
 * byte-identical to what's already on the server — nothing to recover.
 *
 * `gen` is threaded from the caller (push()'s conflict handler, or
 * replayOrphanedSnapshot()/runInit() directly) rather than read fresh
 * here — this is the most sensitive function in the module: the
 * recovered-copy branch below POSTs `snapshot.text` (another user's
 * buffered document text) to create a brand-new document. A generation
 * check gates every await in between, including immediately before that
 * POST, so a session turnover never causes it to fire on stale content —
 * but note the POST itself cannot be un-issued once started; the check
 * before it prevents *starting* a stale one, the checks after resolve
 * prevent *acting* on the response of one that was already in flight when
 * the turnover happened (see the audit in the Task 3 report for why that's
 * the architectural limit of a client-side guard against an in-flight
 * network call).
 *
 * `skipHydrate` is likewise threaded from the caller rather than kept as
 * shared module state: replayOrphanedSnapshot() passes `true` because it is
 * already mid-hydration of a different, unrelated target document when it
 * calls this for the orphaned snapshot's own conflict, and re-entering
 * hydration here would hydrate the WRONG document in the middle of that.
 * A module-level boolean toggled around that one call used to serve this
 * purpose, but it was shared across every call to this function — while one
 * caller's recovery was still awaiting the network, a second, unrelated
 * recovery (e.g. a different orphaned snapshot recovered concurrently) could
 * flip the shared flag out from under the first, and the first's own
 * `finally` could just as easily reset it out from under the second before
 * the second ever reached its own check. Threading the intent as a
 * parameter per call makes that interference impossible instead of merely
 * unlikely. */
export async function recoverSnapshot(
  snapshot: DocSnapshot,
  gen: number,
  skipHydrate = false,
): Promise<void> {
  if (gen !== currentGeneration()) return // already stale before we even started
  try {
    const server = await getDocument(snapshot.docId)
    if (gen !== currentGeneration()) return
    if (server.text === snapshot.text) {
      clearSnapshot()
      await refreshDocuments()
      if (gen !== currentGeneration()) return
      if (skipHydrate) return
      if (useStore.getState().docMeta?.id !== snapshot.docId) return
      await hydrateFromDocument(server, gen)
      return
    }
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 404)) throw error
    // The document is genuinely gone server-side: fall through to the
    // recovered-copy logic below, same as the existing 404 handling.
  }

  if (gen !== currentGeneration()) return // do not create a recovered copy for a dead session
  const copy = await apiCreateDocument({
    name: currentMessages().docRecovered(snapshot.name),
    name_source: 'user',
    text: snapshot.text,
    findings: snapshot.findings,
    scorecard: snapshot.scorecard,
    ...snapshot.settings,
  })
  if (gen !== currentGeneration()) return // the copy now exists server-side regardless; there
  // is nothing left to do frontend-side for a session that has since ended
  clearSnapshot()
  await refreshDocuments()
  // Reached via replayOrphanedSnapshot: we're mid-hydration of an unrelated
  // target document, so this snapshot's own document must not be re-entered.
  if (gen !== currentGeneration()) return
  if (skipHydrate) return
  if (useStore.getState().docMeta?.id !== snapshot.docId) return
  try {
    const original = await getDocument(snapshot.docId)
    if (gen !== currentGeneration()) return
    await hydrateFromDocument(original, gen)
  } catch {
    // The original is gone server-side; the recovered copy takes over.
    await hydrateFromDocument(copy, gen)
  }
}
