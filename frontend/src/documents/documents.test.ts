// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, type DocumentFull } from '../api/client'
import { useStore } from '../state/store'
import { clearSnapshot, readSnapshot, writeSnapshot } from './buffer'
import { flush, resetAutosaveForTests } from './autosave'
import {
  consumeProfileApplySuppression,
  fallbackName,
  initDocuments,
  openDocument,
  removeDocument,
} from './documents'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
}))
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => fakeView,
}))

import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from '../api/client'

const dispatched: unknown[] = []
const fakeView = {
  state: { doc: { toString: () => 'view text', length: 9 } },
  dispatch: (tr: unknown) => dispatched.push(tr),
}

function doc(id: number, over: Partial<DocumentFull> = {}): DocumentFull {
  return {
    id,
    owner_id: 1,
    name: `Doc ${id}`,
    name_source: 'fallback',
    text: 'stored text',
    language: 'de',
    profile_id: 4,
    domain_ids: [1],
    llm_provider: null,
    llm_model: null,
    llm_tier: 'balanced',
    llm_auto: true,
    last_findings: [],
    scorecard: { card: { overall: 70 } as never, stale: true },
    revision: 5,
    created_at: '2026-07-10T00:00:00+00:00',
    updated_at: '2026-07-10T00:00:00+00:00',
    ...over,
  }
}

function summaryOf(d: DocumentFull) {
  return { id: d.id, name: d.name, language: d.language, updated_at: d.updated_at }
}

beforeEach(() => {
  resetAutosaveForTests()
  clearSnapshot()
  dispatched.length = 0
  localStorage.clear()
  useStore.getState().setDocMeta(null)
  useStore.getState().setDocuments([])
})

afterEach(() => vi.clearAllMocks())

describe('openDocument', () => {
  it('hydrates settings, meta, scorecard and suppresses profile apply on language switch', async () => {
    useStore.setState({ language: 'en' })
    vi.mocked(getDocument).mockResolvedValue(doc(3))
    await openDocument(3)
    const s = useStore.getState()
    expect(s.language).toBe('de')
    expect(s.tier).toBe('balanced')
    expect(s.profileId).toBe(4)
    expect(s.lastProfileByLanguage.de).toBe(4)
    expect(s.docMeta).toEqual({ id: 3, name: 'Doc 3', nameSource: 'fallback', revision: 5 })
    expect(s.scorecard).toEqual({ overall: 70 })
    expect(s.scorecardStale).toBe(true)
    expect(consumeProfileApplySuppression()).toBe(true)
    expect(consumeProfileApplySuppression()).toBe(false) // one-shot
    expect(readSnapshot()?.dirty).toBe(false)
    expect(dispatched.length).toBe(1) // text + findings in one transaction
  })

  it('does not arm suppression when the language is unchanged', async () => {
    useStore.setState({ language: 'de' })
    vi.mocked(getDocument).mockResolvedValue(doc(3))
    await openDocument(3)
    expect(consumeProfileApplySuppression()).toBe(false)
  })

  it('replays another document\'s dirty buffered snapshot before hydrating the target', async () => {
    writeSnapshot({
      docId: 1, revision: 4, dirty: true, name: 'Doc 1',
      text: 'orphaned text', findings: [], scorecard: null,
      settings: {
        language: 'de', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: 'balanced', llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockResolvedValue(doc(1, { revision: 5 }))
    vi.mocked(getDocument).mockResolvedValue(doc(2))
    await openDocument(2)
    expect(updateDocument).toHaveBeenCalledWith(1, expect.objectContaining({ revision: 4 }))
    expect(useStore.getState().docMeta?.id).toBe(2)
  })

  it('recovers the orphaned snapshot as a copy on conflict, then still hydrates the target', async () => {
    writeSnapshot({
      docId: 1, revision: 4, dirty: true, name: 'Doc 1',
      text: 'orphaned text', findings: [], scorecard: null,
      settings: {
        language: 'de', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: 'balanced', llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockRejectedValue(new HttpError(409, 'stale'))
    vi.mocked(createDocument).mockResolvedValue(
      doc(11, { name: 'Doc 1 (recovered)', name_source: 'user' }),
    )
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(11)), summaryOf(doc(2))])
    vi.mocked(getDocument).mockResolvedValue(doc(2))
    await openDocument(2)
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'orphaned text',
        name_source: 'user',
        name: expect.stringContaining('recovered'),
      }),
    )
    // The target document is still the one that ends up hydrated.
    expect(useStore.getState().docMeta?.id).toBe(2)
  })
})

describe('replayOrphanedSnapshot vs. a stale autosave retry', () => {
  it('cancels a pending backoff retry once the orphan replay takes over the snapshot', async () => {
    vi.useFakeTimers()
    try {
      useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 4 })
      vi.mocked(updateDocument).mockRejectedValueOnce(new TypeError('offline'))
      await flush() // fails: buffer stays dirty for doc 1, a backoff retry is scheduled
      expect(updateDocument).toHaveBeenCalledTimes(1)
      expect(readSnapshot()?.dirty).toBe(true)

      // Simulate the user having moved off doc 1 entirely: the orphaned
      // dirty snapshot for doc 1 still sits in the single-slot buffer, and
      // its backoff retry is still pending.
      useStore.getState().setDocMeta(null)

      vi.mocked(updateDocument).mockResolvedValueOnce(doc(1, { revision: 5 }))
      vi.mocked(getDocument).mockResolvedValue(doc(2))
      await openDocument(2)

      // Only the orphan replay's own PUT happened.
      expect(updateDocument).toHaveBeenCalledTimes(2)
      expect(useStore.getState().docMeta?.id).toBe(2)

      // The stale retry must have been cancelled by the replay, not fired.
      await vi.advanceTimersByTimeAsync(60000)
      expect(updateDocument).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('initDocuments', () => {
  it('replays a dirty snapshot before opening', async () => {
    writeSnapshot({
      docId: 3,
      revision: 5,
      dirty: true,
      name: 'Doc 3',
      text: 'buffered',
      findings: [],
      scorecard: null,
      settings: {
        language: 'de',
        profile_id: null,
        domain_ids: [],
        llm_provider: null,
        llm_model: null,
        llm_tier: 'balanced',
        llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockResolvedValue(doc(3, { revision: 6 }))
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(3))])
    vi.mocked(getDocument).mockResolvedValue(doc(3, { revision: 6 }))
    useStore.setState({ currentDocId: 3 })
    await initDocuments()
    expect(updateDocument).toHaveBeenCalledWith(3, expect.objectContaining({ revision: 5 }))
    expect(useStore.getState().docMeta?.revision).toBe(6)
  })

  it('migrates the legacy localStorage text when the backend is empty', async () => {
    localStorage.setItem('fabulous-writing-text', 'old legacy words here')
    vi.mocked(listDocuments).mockResolvedValue([])
    vi.mocked(createDocument).mockResolvedValue(doc(1, { name: 'old legacy words here' }))
    await initDocuments()
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'old legacy words here', name: 'old legacy words here' }),
    )
    expect(localStorage.getItem('fabulous-writing-text')).toBeNull()
  })

  it('creates a fresh document when backend and legacy storage are empty', async () => {
    vi.mocked(listDocuments).mockResolvedValue([])
    vi.mocked(createDocument).mockResolvedValue(doc(1, { text: '' }))
    await initDocuments()
    expect(createDocument).toHaveBeenCalledTimes(1)
    expect(useStore.getState().docMeta?.id).toBe(1)
  })

  it('is re-entrant: two concurrent calls (StrictMode double-invoke) only create one document', async () => {
    vi.mocked(listDocuments).mockResolvedValue([])
    vi.mocked(createDocument).mockResolvedValue(doc(1, { text: '' }))
    const p1 = initDocuments()
    const p2 = initDocuments()
    expect(p2).toBe(p1) // both calls share the same in-flight run
    await Promise.all([p1, p2])
    expect(createDocument).toHaveBeenCalledTimes(1)
    expect(useStore.getState().docMeta?.id).toBe(1)
  })

  it('falls back to the buffered document and flags the list on backend failure', async () => {
    writeSnapshot({
      docId: 9, revision: 1, dirty: true, name: 'Buffered',
      text: 'offline text', findings: [], scorecard: null,
      settings: {
        language: 'en', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: 'cheap', llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockRejectedValue(new TypeError('offline'))
    vi.mocked(listDocuments).mockRejectedValue(new TypeError('offline'))
    await initDocuments()
    expect(useStore.getState().docListError).toBe(true)
    expect(useStore.getState().docMeta?.id).toBe(9)
    expect(readSnapshot()?.dirty).toBe(true) // still awaiting sync
  })

  it('recovers a conflicted replay as a new user-named document (server text differs)', async () => {
    writeSnapshot({
      docId: 3, revision: 4, dirty: true, name: 'Doc 3',
      text: 'diverged text', findings: [], scorecard: null,
      settings: {
        language: 'de', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: 'balanced', llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockRejectedValue(new HttpError(409, 'stale'))
    // getDocument (the self-write check, and later the "hydrate original"
    // fetch) returns the server doc, whose text ('stored text') genuinely
    // differs from the buffered snapshot's ('diverged text') — a real
    // conflict, so the recovered-copy path must still run.
    vi.mocked(getDocument).mockResolvedValue(doc(3))
    vi.mocked(createDocument).mockResolvedValue(doc(11, { name: 'Doc 3 (recovered)', name_source: 'user' }))
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(11)), summaryOf(doc(3))])
    useStore.setState({ currentDocId: 3 })
    await initDocuments()
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'diverged text',
        name_source: 'user',
        name: expect.stringContaining('recovered'),
      }),
    )
    // The server version of the original wins in place.
    expect(useStore.getState().docMeta?.id).toBe(3)
  })

  it('detects a self-write conflict (server already has the buffered content) and skips recovery entirely', async () => {
    writeSnapshot({
      docId: 3, revision: 4, dirty: true, name: 'Doc 3',
      // Identical to doc(3)'s default text: this simulates our own
      // beforeunload PUT having landed server-side before the client saw
      // the response, so the replay's 409 is not a real conflict.
      text: 'stored text', findings: [], scorecard: null,
      settings: {
        language: 'de', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: 'balanced', llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockRejectedValue(new HttpError(409, 'stale'))
    vi.mocked(getDocument).mockResolvedValue(doc(3, { revision: 7 }))
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(3, { revision: 7 }))])
    useStore.setState({ currentDocId: 3 })
    await initDocuments()
    expect(createDocument).not.toHaveBeenCalled()
    expect(useStore.getState().docMeta?.id).toBe(3)
    expect(useStore.getState().docMeta?.revision).toBe(7)
    expect(readSnapshot()?.dirty).toBe(false)
  })
})

describe('removeDocument', () => {
  it('opens the most recent remaining document when deleting the current one', async () => {
    useStore.getState().setDocuments([summaryOf(doc(1)), summaryOf(doc(2))])
    useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 0 })
    vi.mocked(deleteDocument).mockResolvedValue(undefined)
    vi.mocked(getDocument).mockResolvedValue(doc(2))
    await removeDocument(1)
    expect(useStore.getState().docMeta?.id).toBe(2)
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([2])
  })
})

describe('fallbackName', () => {
  it('mirrors the backend rule', () => {
    expect(fallbackName('a b c d e f g h')).toBe('a b c d e f')
    expect(fallbackName('   ')).toBeNull()
  })
})
