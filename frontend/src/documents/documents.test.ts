// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HttpError,
  type DocumentCreatePayload,
  type DocumentFull,
  type Folder,
} from '../api/client'
import { useStore } from '../state/store'
import type { Profile } from '../types'
import { clearSnapshot, readSnapshot, writeSnapshot, type DocSnapshot } from './buffer'
import { currentGeneration, flush, noteChange, resetAutosaveForTests } from './autosave'
import {
  createNewDocument,
  fallbackName,
  initDocuments,
  invalidateDocumentWork,
  moveDocumentToFolder,
  openDocument,
  removeDocument,
  removeFolder,
} from './documents'
import { recoverSnapshot } from './hydration'
import { addFolder, applyFolderDefaults, saveFolderDefaults } from './folders'
import {
  applyHeaderProfileSelection,
  consumeProfileApplySuppression,
  setProfileApplySuppressed,
} from './profileApply'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  listFolders: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  moveDocument: vi.fn(),
  putFolderDefaults: vi.fn(),
}))
import {
  createDocument,
  createFolder,
  deleteDocument,
  deleteFolder,
  getDocument,
  listDocuments,
  listFolders,
  moveDocument,
  putFolderDefaults,
  updateDocument,
} from '../api/client'
import { setDocumentPort, type DocumentPort } from '../checking/documentPort'

const dispatched: unknown[] = []
let viewText = 'view text'
const fakePort: DocumentPort = {
  hasDocument: () => true,
  getText: () => viewText,
  setDocument: (text, findings) => dispatched.push({ text, findings }),
  currentFinding: () => null,
  serverSpan: () => null,
  mergeFindings: () => {},
  selectFinding: () => {},
  applySuggestion: () => Promise.resolve('not-found'),
  applyRewrite: () => Promise.resolve('not-found'),
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
    folder_id: null,
    revision: 5,
    created_at: '2026-07-10T00:00:00+00:00',
    updated_at: '2026-07-10T00:00:00+00:00',
    edited_at: '2026-07-10T00:00:00+00:00',
    checked_at: null,
    ...over,
  }
}

function summaryOf(d: DocumentFull) {
  return {
    id: d.id,
    name: d.name,
    language: d.language,
    folder_id: d.folder_id,
    created_at: d.created_at,
    edited_at: d.edited_at,
    checked_at: d.checked_at,
    updated_at: d.updated_at,
  }
}

const USER = {
  id: 1,
  email: 'ada@example.com',
  display_name: null,
  tier: 'basic',
  is_admin: false,
  policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
  usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
  limits: {
    max_document_chars: 200000,
    max_llm_document_chars: 200000,
    concurrent_llm_runs: 5,
  },
  allow_additional_admins: false,
  db_backend: 'sqlite',
}

beforeEach(() => {
  resetAutosaveForTests()
  clearSnapshot()
  dispatched.length = 0
  viewText = 'view text'
  localStorage.clear()
  useStore.getState().setDocMeta(null)
  useStore.getState().setDocuments([])
  useStore.setState({ user: USER })
  setDocumentPort(fakePort)
})

afterEach(() => {
  vi.clearAllMocks()
  setDocumentPort(null)
})

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
    expect(readSnapshot()?.ownerId).toBe(1)
    expect(dispatched.length).toBe(1) // text + findings in one transaction
  })

  it('does not arm suppression when the language is unchanged', async () => {
    useStore.setState({ language: 'de' })
    vi.mocked(getDocument).mockResolvedValue(doc(3))
    await openDocument(3)
    expect(consumeProfileApplySuppression()).toBe(false)
  })

  it('doc language differing from persisted language keeps the doc profile', async () => {
    // Simulates loadUserPrefs having restored a persisted language ('de')
    // that differs from the document being opened.
    useStore.setState({ language: 'de' })
    vi.mocked(getDocument).mockResolvedValue(doc(3, { language: 'en', profile_id: 5 }))
    await openDocument(3)
    const s = useStore.getState()
    expect(s.language).toBe('en') // the doc's own language wins
    expect(s.profileId).toBe(5) // the doc's own profile, not clobbered
    expect(s.lastProfileByLanguage.en).toBe(5)
    // Suppression was armed by the language mismatch and is still there for
    // the header's own profile-apply effect to consume.
    expect(consumeProfileApplySuppression()).toBe(true)
  })

  it('doc language differing from persisted language, doc without profile', async () => {
    useStore.setState({ language: 'de', lastProfileByLanguage: {} })
    vi.mocked(getDocument).mockResolvedValue(doc(3, { language: 'en', profile_id: null }))
    await openDocument(3)
    expect(useStore.getState().language).toBe('en')
    expect(useStore.getState().profileId).toBeNull()

    const chosen: Profile = {
      id: 7,
      language: 'en',
      name: 'Formal',
      is_standard: true,
      categories_off: [],
      rule_exceptions: [],
      packs_on: [],
      domain_ids: [],
      llm_provider: null,
      llm_model: null,
      llm_tier: null,
      llm_instructions: '',
      example_text: '',
      is_global: true,
    }
    applyHeaderProfileSelection(useStore.getState().selectProfile, chosen, true)
    // applyHeaderProfileSelection's early-return branch: suppressed and no
    // profile on the document -> the fallback is never adopted.
    expect(useStore.getState().profileId).toBeNull()
    expect(useStore.getState().lastProfileByLanguage).toEqual({})
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

  it('arms the retry loop on offline startup with a dirty buffer (no user input needed)', async () => {
    vi.useFakeTimers()
    try {
      writeSnapshot({
        docId: 9, revision: 1, dirty: true, name: 'Buffered',
        text: 'offline text', findings: [], scorecard: null,
        settings: {
          language: 'en', profile_id: null, domain_ids: [],
          llm_provider: null, llm_model: null, llm_tier: 'cheap', llm_auto: true,
        },
      })
      vi.mocked(listDocuments).mockRejectedValue(new TypeError('offline'))
      // The first updateDocument call (startup replay) and the armed flush's
      // immediate push both fail (backend is offline), then the backend comes
      // back and subsequent calls succeed. This forces the backoff retry to
      // actually trigger and verify the void flush() fix is necessary.
      vi.mocked(updateDocument)
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValue(doc(9, { revision: 2 }))

      await initDocuments()
      // After initDocuments, the first replay attempt should have failed
      expect(updateDocument).toHaveBeenCalledWith(9, expect.objectContaining({ revision: 1 }))
      expect(updateDocument).toHaveBeenCalledTimes(2) // replay + armed flush immediate attempt

      // Now advance the timer to trigger the backoff retry
      await vi.advanceTimersByTimeAsync(2000)

      // The backoff retry should have been called
      expect(updateDocument).toHaveBeenCalledTimes(3)
      expect(updateDocument).toHaveBeenLastCalledWith(9, expect.objectContaining({ revision: 1 }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the legacy text in place and flags the list when the migration create fails', async () => {
    localStorage.setItem('fabulous-writing-text', 'old legacy words here')
    vi.mocked(listDocuments).mockResolvedValue([])
    vi.mocked(createDocument).mockRejectedValue(new TypeError('offline'))
    await initDocuments()
    expect(localStorage.getItem('fabulous-writing-text')).toBe('old legacy words here')
    expect(useStore.getState().docListError).toBe(true)
    expect(useStore.getState().docMeta).toBeNull()
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

describe('invalidateDocumentWork', () => {
  it('resets the one-shot profile-apply suppression so it cannot leak into the next session', () => {
    // If user A's hydration armed the suppression (a language-change profile
    // fetch was still pending) and A logs out before that fetch resolves,
    // neither resetSessionState() nor a bare generation bump clears this
    // flag on its own — invalidateDocumentWork() must do it explicitly, or
    // user B's own profile response would consume A's leftover flag and
    // skip/misapply B's selection.
    setProfileApplySuppressed(true)
    invalidateDocumentWork()
    expect(consumeProfileApplySuppression()).toBe(false)
  })

  it('cancels a pending debounced save and a pending backoff retry', async () => {
    vi.useFakeTimers()
    try {
      useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 4 })
      vi.mocked(updateDocument).mockRejectedValueOnce(new TypeError('offline'))
      await flush() // fails: schedules a backoff retry
      expect(updateDocument).toHaveBeenCalledTimes(1)

      noteChange() // arms a fresh debounce timer too
      invalidateDocumentWork()

      await vi.advanceTimersByTimeAsync(60000)
      expect(updateDocument).toHaveBeenCalledTimes(1) // neither timer fired
    } finally {
      vi.useRealTimers()
    }
  })

  it('an initDocuments() run still in flight when the session ends writes nothing', async () => {
    let resolveList!: (docs: ReturnType<typeof summaryOf>[]) => void
    vi.mocked(listDocuments).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        }) as never,
    )

    const pending = initDocuments() // starts, now awaiting listDocuments()
    invalidateDocumentWork() // simulates logout()/expireSession() firing mid-flight

    resolveList([summaryOf(doc(1))])
    await pending

    // The stale run's fetch resolved after invalidation: its writes must
    // have been dropped rather than landing the first user's document list.
    expect(useStore.getState().documents).toEqual([])
    expect(useStore.getState().docMeta).toBeNull()
  })

  it('frees the memoised initDocuments() run so the next call starts fresh, without waiting for the stale one first', async () => {
    let resolveFirstList!: (docs: ReturnType<typeof summaryOf>[]) => void
    vi.mocked(listDocuments).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstList = resolve
        }) as never,
    )

    const stale = initDocuments() // user A's run: starts, awaiting listDocuments()
    invalidateDocumentWork() // user A logs out mid-flight

    // Deliberately NOT awaiting `stale` here: if invalidateDocumentWork()
    // hadn't cleared initInFlight, the next call below would just return
    // this same still-pending promise instead of starting user B's own run
    // — leaving user B's sidebar and editor uninitialised forever.
    vi.mocked(listDocuments).mockResolvedValueOnce([summaryOf(doc(2))])
    vi.mocked(getDocument).mockResolvedValueOnce(doc(2))
    const fresh = initDocuments()
    expect(fresh).not.toBe(stale)

    await fresh
    expect(useStore.getState().docMeta?.id).toBe(2)
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([2])

    // The stale run resolving afterwards must still not clobber user B's
    // already-landed state.
    resolveFirstList([summaryOf(doc(1))])
    await stale
    expect(useStore.getState().docMeta?.id).toBe(2)
  })

  it('a login as another user mid-initDocuments() never surfaces the first user\'s content', async () => {
    let resolveGet: ((d: DocumentFull) => void) | undefined
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(7))])
    vi.mocked(getDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve
        }) as never,
    )

    const pending = initDocuments() // starts; will reach `await getDocument(7)`
    await vi.waitFor(() => {
      if (!resolveGet) throw new Error('getDocument not called yet')
    })

    invalidateDocumentWork() // user 1 logs out
    useStore.setState({ user: { ...USER, id: 2 } }) // user 2 signs in

    resolveGet!(doc(7, { text: 'user 1 private text' }))
    await pending

    // hydrateFromDocument must never have run for the stale fetch: user 1's
    // document never gets opened into the editor for user 2's session.
    expect(useStore.getState().docMeta).toBeNull()
    expect(dispatched).toHaveLength(0)
  })

  it('createNewDocument() does not resurrect the outgoing user\'s stale document list when the session turns over mid-create', async () => {
    // Captured into createNewDocument's `state` closure before its await —
    // the write must not resurrect this once the session has moved on,
    // even though nothing re-reads the store to notice it's stale.
    useStore.getState().setDocuments([summaryOf(doc(1))])
    let resolveCreate: ((d: DocumentFull) => void) | undefined
    vi.mocked(createDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }) as never,
    )

    const pending = createNewDocument() // starts; will reach `await apiCreateDocument`
    await vi.waitFor(() => {
      if (!resolveCreate) throw new Error('createDocument not called yet')
    })

    invalidateDocumentWork() // the session that started this create has ended
    useStore.getState().setDocuments([summaryOf(doc(2))]) // a wholly different, incoming list

    resolveCreate!(doc(9))
    await pending

    // Must still be exactly the incoming list — not [doc(9), doc(1)], which
    // would be the outgoing user's stale `state.documents` closure
    // resurrected on top of it.
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([2])
  })

  it('createNewDocument() does not POST at all when the session ends while flush() is awaiting a save left in flight by the outgoing session', async () => {
    // Distinct from the existing "does not resurrect the outgoing user's
    // stale document list" test above, which starts createNewDocument()
    // already past its own await flush() (createDocument itself in flight).
    // This one puts a *different* session's save in flight first, so that
    // createNewDocument()'s own `await flush()` takes the `while (saving &&
    // inFlight)` branch and is still suspended there when the session ends —
    // exactly the hazard described in review round 2: flush() resuming after
    // a turnover must not let the POST happen at all, since the existing
    // post-request check only hides the result, it does not prevent the
    // server-side write.
    useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 4 })
    let resolveOutgoing!: (v: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOutgoing = resolve
        }) as never,
    )

    void flush() // outgoing session's own save starts and is now in flight
    expect(updateDocument).toHaveBeenCalledTimes(1)

    const pending = createNewDocument() // reaches `await flush()`, joins the in-flight save

    invalidateDocumentWork() // the session that started createNewDocument() ends mid-flush()

    vi.mocked(createDocument).mockResolvedValue(doc(9)) // in case the guard regresses
    resolveOutgoing(doc(1, { revision: 5 })) // lets flush()'s wait resolve
    await pending

    // The critical assertion: no document was ever created on the server —
    // not merely "the UI doesn't show it".
    expect(createDocument).not.toHaveBeenCalled()
  })

  it('openDocument() does not fetch at all when the session ends while flush() is awaiting a save left in flight by the outgoing session', async () => {
    useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 4 })
    let resolveOutgoing!: (v: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOutgoing = resolve
        }) as never,
    )

    void flush() // outgoing session's own save starts and is now in flight
    expect(updateDocument).toHaveBeenCalledTimes(1)

    const pending = openDocument(2) // reaches `await flush()`, joins the in-flight save

    invalidateDocumentWork() // the session that started openDocument() ends mid-flush()

    vi.mocked(getDocument).mockResolvedValue(doc(2)) // in case the guard regresses
    resolveOutgoing(doc(1, { revision: 5 })) // lets flush()'s wait resolve
    await pending

    // The outgoing user's document must never have been fetched under the
    // incoming session.
    expect(getDocument).not.toHaveBeenCalled()
    expect(useStore.getState().docMeta).toEqual({
      id: 1,
      name: 'Doc 1',
      nameSource: 'user',
      revision: 4,
    })
  })

  it('recoverSnapshot() does not create a recovered copy once the session has ended while checking the server', async () => {
    // The most sensitive write in the module: on a 404, this POSTs
    // `snapshot.text` to create a brand-new document. A session turnover
    // while checking the server must stop this before it fires at all.
    const snapshot: DocSnapshot = {
      docId: 1,
      revision: 1,
      dirty: true,
      name: 'Doc 1',
      text: 'private text',
      findings: [],
      scorecard: null,
      settings: {
        language: 'en',
        profile_id: null,
        domain_ids: [],
        llm_provider: null,
        llm_model: null,
        llm_tier: null,
        llm_auto: true,
      },
      ownerId: 1,
    }
    let rejectGet: ((reason?: unknown) => void) | undefined
    vi.mocked(getDocument).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectGet = reject
        }) as never,
    )

    const gen = currentGeneration()
    const pending = recoverSnapshot(snapshot, gen)
    await vi.waitFor(() => {
      if (!rejectGet) throw new Error('getDocument not called yet')
    })

    invalidateDocumentWork() // the session that owned this snapshot has ended

    rejectGet!(new HttpError(404, 'gone')) // falls through to the recovered-copy path
    await pending

    expect(createDocument).not.toHaveBeenCalled()
  })

  it('recoverSnapshot(skipHydrate=true) skips the self-write fast path\'s hydrate', async () => {
    // Regression for the shared `skipRecoveryHydrate` module boolean: it
    // used to be toggled by the *caller* (replayOrphanedSnapshot) around its
    // own call, so one overlapping recovery's completion could reset it out
    // from under a different, still-pending recovery. skipHydrate is now a
    // parameter threaded per call — this pins that the self-write branch
    // (server text matches the buffered snapshot) still honours it.
    const snapshot: DocSnapshot = {
      docId: 5, revision: 2, dirty: true, name: 'Orphan',
      text: 'stored text', // matches doc(5)'s default text: a self-write
      findings: [], scorecard: null,
      settings: {
        language: 'en', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: null, llm_auto: true,
      },
      ownerId: 1,
    }
    // docMeta still shows the orphan's own document here — replayOrphanedSnapshot
    // calls recoverSnapshot() for it BEFORE hydrateFromDocument() switches
    // docMeta over to the real target, so the id equals snapshot.docId at
    // this point. That means the separate `docMeta?.id !== snapshot.docId`
    // check below cannot be what stops the hydrate here — only skipHydrate
    // can, which is exactly what this test needs to isolate.
    useStore.getState().setDocMeta({ id: 5, name: 'Orphan', nameSource: 'user', revision: 2 })
    vi.mocked(getDocument).mockResolvedValueOnce(doc(5))
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(5))])

    const gen = currentGeneration()
    await recoverSnapshot(snapshot, gen, true)

    // No hydrate happened: the editor never received the orphan's text.
    expect(dispatched).toHaveLength(0)
  })

  it('recoverSnapshot(skipHydrate=true) recovers a copy but never re-enters hydration for it', async () => {
    const snapshot: DocSnapshot = {
      docId: 5, revision: 2, dirty: true, name: 'Orphan',
      text: 'orphan text', findings: [], scorecard: null,
      settings: {
        language: 'en', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: null, llm_auto: true,
      },
      ownerId: 1,
    }
    // docMeta still shows id 5 (the orphan's own document) — see the
    // self-write test above for why this, not 99, is what isolates
    // skipHydrate rather than the separate docMeta-id check below it.
    useStore.getState().setDocMeta({ id: 5, name: 'Orphan', nameSource: 'user', revision: 2 })
    // A genuine conflict (server text differs, no exception) falls through
    // to the recovered-copy branch.
    vi.mocked(getDocument).mockResolvedValueOnce(doc(5, { text: 'server-side text' }))
    vi.mocked(createDocument).mockResolvedValueOnce(
      doc(50, { name: 'Orphan (recovered)', name_source: 'user' }),
    )
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(50))])

    const gen = currentGeneration()
    await recoverSnapshot(snapshot, gen, true)

    // The recovery itself still happens (the copy is not lost)...
    expect(createDocument).toHaveBeenCalledTimes(1)
    // ...but it must not re-enter hydration for it: only the one self-write
    // check call to getDocument happened, never the second "fetch original
    // to hydrate" call this branch would otherwise make, and nothing reached
    // the editor.
    expect(getDocument).toHaveBeenCalledTimes(1)
    expect(dispatched).toHaveLength(0)
  })

  it('removeDocument()\'s hydrate of the next document does not run once the session has ended', async () => {
    // removeDocument() has no pre-check of its own before calling
    // hydrateFromDocument() (its own setDocuments() write re-derives from
    // live store state, confirmed fine in the previous review round) — so
    // this exercises hydrateFromDocument()'s own entry guard in isolation,
    // with no caller-side check to confound it.
    useStore.getState().setDocuments([summaryOf(doc(1)), summaryOf(doc(2))])
    useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 0 })
    vi.mocked(deleteDocument).mockResolvedValue(undefined)
    let resolveGet: ((d: DocumentFull) => void) | undefined
    vi.mocked(getDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve
        }) as never,
    )

    const pending = removeDocument(1) // starts; will reach `await getDocument(2)`
    await vi.waitFor(() => {
      if (!resolveGet) throw new Error('getDocument not called yet')
    })

    invalidateDocumentWork() // the session that started this delete has ended

    resolveGet!(doc(2))
    await pending

    // invalidateDocumentWork() alone (unlike a real logout()/expireSession())
    // does not touch docMeta — only resetSessionState() does that. So the
    // correct outcome here is that docMeta stays exactly what it was before
    // this call (doc 1's, already unrelated to the delete target), not that
    // it gets overwritten with doc 2's data from the stale hydrate.
    expect(useStore.getState().docMeta).toEqual({
      id: 1,
      name: 'Doc 1',
      nameSource: 'user',
      revision: 0,
    })
    expect(dispatched).toHaveLength(0)
  })

  it('a next-session flush() is neither blocked by, nor has its work dropped by, a save still in flight when the session ends (liveness)', async () => {
    // Outgoing session: a save genuinely in flight when invalidateDocumentWork()
    // fires (logout()/expireSession()). Before the fix, autosave's `saving`
    // flag stays true until this stale request's own completion clears it —
    // so the very next flush() (a different user, a different document)
    // would queue behind it via `pending` and wait on the same `inFlight`
    // promise, forever if the stale request hangs.
    useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 4 })
    let resolveStale!: (value: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve
        }) as never,
    )

    void flush() // outgoing session's save starts and is now in flight
    expect(updateDocument).toHaveBeenCalledTimes(1)

    invalidateDocumentWork() // outgoing session ends mid-flight

    // Incoming session: a different user opens a different document.
    useStore.setState({ user: { ...USER, id: 2 } })
    useStore.getState().setDocMeta({ id: 2, name: 'Doc 2', nameSource: 'user', revision: 0 })
    vi.mocked(updateDocument).mockResolvedValueOnce(doc(2, { revision: 1 }))

    let nextFlushSettled = false
    const nextFlush = flush().then(() => {
      nextFlushSettled = true
    })

    // Must not hang waiting on the stale in-flight push: a real-time race
    // against a short timeout stands in for "forever" — if the fix regresses
    // and flush() blocks on the stale request, this timeout wins instead.
    await Promise.race([
      nextFlush,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ])
    expect(nextFlushSettled).toBe(true)
    // The incoming session's own edit must actually have been pushed, not
    // silently queued-then-dropped behind the stale request.
    expect(updateDocument).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ revision: 0 }),
    )

    // The stale request resolving afterwards must not clobber the incoming
    // session's now-successfully-saved state.
    resolveStale(doc(1, { revision: 5 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useStore.getState().docMeta?.id).toBe(2)
    expect(useStore.getState().docMeta?.revision).toBe(1)
  })

  it("an outgoing session's stale push settling while the incoming session's own push is still in flight does not drop the incoming session's queued follow-up edit", async () => {
    // Distinguishes resetCoordinationState() (session 2 never has to wait on
    // session 1's stale push at all) from the separate guard this test
    // pins: push()'s own `finally` block must also check its captured
    // generation before touching `saving`/`pending`, because session 2 can
    // start (and still be awaiting) its *own* push by the time session 1's
    // stale push finally settles.
    useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 4 })
    let rejectStale!: (reason?: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStale = reject
        }) as never,
    )
    void flush() // outgoing session's push #1 starts, in flight
    expect(updateDocument).toHaveBeenCalledTimes(1)

    invalidateDocumentWork() // outgoing session ends mid-flight

    // Incoming session opens its own document and starts its own push.
    useStore.setState({ user: { ...USER, id: 2 } })
    useStore.getState().setDocMeta({ id: 2, name: 'Doc 2', nameSource: 'user', revision: 0 })
    let resolveIncoming!: (value: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIncoming = resolve
        }) as never,
    )
    void flush() // incoming session's own push #2 starts, also in flight
    expect(updateDocument).toHaveBeenCalledTimes(2)

    // A further edit arrives while push #2 is still in flight: this must
    // queue a follow-up (`pending`), not start a concurrent third PUT.
    viewText = 'view text, edited by session 2'
    void flush()

    // The outgoing session's stale push #1 now settles — well after the
    // generation has moved on to session 2 — and fails.
    vi.mocked(updateDocument).mockResolvedValueOnce(doc(2, { revision: 2 }))
    rejectStale(new TypeError('offline'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Session 2's own push #2 now completes successfully.
    resolveIncoming(doc(2, { revision: 1 }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // The queued edit must still have been pushed as its own PUT — not
    // silently dropped by push #1's completion clearing `pending` first
    // (push #1 belongs to a generation that ended before push #2 even
    // started).
    expect(updateDocument).toHaveBeenCalledTimes(3)
    expect(vi.mocked(updateDocument).mock.calls[2][1].content?.text).toBe(
      'view text, edited by session 2',
    )
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

  it('cancels a pending backoff retry and clears the buffer when the retrying document is deleted', async () => {
    vi.useFakeTimers()
    try {
      useStore.getState().setDocuments([summaryOf(doc(1)), summaryOf(doc(2))])
      useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 4 })
      vi.mocked(updateDocument).mockRejectedValueOnce(new TypeError('offline'))
      await flush() // fails: buffer stays dirty for doc 1, a backoff retry is scheduled
      expect(updateDocument).toHaveBeenCalledTimes(1)
      expect(readSnapshot()?.dirty).toBe(true)

      // Simulate having moved off doc 1 entirely (its dirty snapshot and
      // backoff retry still sit in the single buffer slot) before deleting
      // it from the sidebar.
      useStore.getState().setDocMeta(null)

      // Deleting doc 1 must not let that stale dirty snapshot survive: left
      // in place it would later replay via replayOrphanedSnapshot, 404
      // against the now-gone document, and resurrect it as a "(recovered)"
      // copy.
      vi.mocked(deleteDocument).mockResolvedValue(undefined)
      await removeDocument(1)
      expect(readSnapshot()).toBeNull()

      // The stale retry must have been cancelled by the delete, not fired.
      await vi.advanceTimersByTimeAsync(60000)
      expect(updateDocument).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an unrelated dirty buffered snapshot alone when deleting a different document', async () => {
    writeSnapshot({
      docId: 2, revision: 1, dirty: true, name: 'Doc 2',
      text: 'unsaved edits on doc 2', findings: [], scorecard: null,
      settings: {
        language: 'en', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: 'balanced', llm_auto: true,
      },
    })
    useStore.getState().setDocuments([summaryOf(doc(1)), summaryOf(doc(2))])
    useStore.getState().setDocMeta(null) // neither doc is the currently open one
    vi.mocked(deleteDocument).mockResolvedValue(undefined)
    await removeDocument(1)
    expect(readSnapshot()?.docId).toBe(2)
    expect(readSnapshot()?.dirty).toBe(true)
  })
})

describe('applyHeaderProfileSelection', () => {
  const chosen: Profile = {
    id: 7,
    language: 'de',
    name: 'Formal',
    is_standard: true,
    categories_off: [],
    rule_exceptions: [],
    packs_on: [],
    domain_ids: [],
    llm_provider: null,
    llm_model: null,
    llm_tier: null,
    llm_instructions: '',
    example_text: '',
    is_global: true,
  }

  it('leaves a just-opened null-profile document with no profile selected (does not adopt the fallback)', async () => {
    vi.useFakeTimers()
    try {
      // Wire the same settings-autosave subscription App.tsx installs, so
      // this exercises the actual hydration-gate mechanism rather than just
      // the `apply` argument passed to selectProfile.
      let previous = useStore.getState()
      const unsubscribe = useStore.subscribe((state) => {
        const changed = state.profileId !== previous.profileId
        previous = state
        if (changed && state.docMeta) noteChange()
      })
      try {
        useStore.setState({ language: 'en', lastProfileByLanguage: {} })
        vi.mocked(getDocument).mockResolvedValue(doc(3, { profile_id: null }))
        await openDocument(3) // language switch en -> de arms the suppression
        expect(useStore.getState().profileId).toBeNull()

        applyHeaderProfileSelection(useStore.getState().selectProfile, chosen, true)
        // A pruned document has no profile; the fallback must NOT be
        // adopted into the store, even for display only — that would be
        // deferred corruption once the next autosave persists it.
        expect(useStore.getState().profileId).toBeNull()
        expect(useStore.getState().lastProfileByLanguage).toEqual({})

        // No autosave was queued either.
        await vi.advanceTimersByTimeAsync(5000)
        expect(updateDocument).not.toHaveBeenCalled()
      } finally {
        unsubscribe()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts the profile without applying its values when suppressed but the document already has a profile', async () => {
    useStore.setState({ language: 'en' })
    // The opened document supplies its own profile (id 4), so
    // hydrateFromDocument leaves profileId non-null.
    vi.mocked(getDocument).mockResolvedValue(
      doc(3, { profile_id: 4, domain_ids: [9] }),
    )
    await openDocument(3) // language switch en -> de arms the suppression
    expect(useStore.getState().profileId).toBe(4)

    applyHeaderProfileSelection(useStore.getState().selectProfile, chosen, true)
    // Adopted (selectProfile with apply=false: profileId/lastProfileByLanguage
    // update but the profile's own values are not copied onto the header)...
    expect(useStore.getState().profileId).toBe(7)
    expect(useStore.getState().lastProfileByLanguage.de).toBe(7)
    // ...so the document's own header values must not be overwritten.
    expect(useStore.getState().domainIds).toEqual([9])
  })

  it('applies and autosaves a profile pick normally when no suppression is armed', async () => {
    vi.useFakeTimers()
    try {
      let previous = useStore.getState()
      const unsubscribe = useStore.subscribe((state) => {
        const changed = state.profileId !== previous.profileId
        previous = state
        if (changed && state.docMeta) noteChange()
      })
      try {
        useStore.getState().setDocMeta({ id: 3, name: 'Doc 3', nameSource: 'user', revision: 5 })
        useStore.setState({ profileId: 4 })
        vi.mocked(updateDocument).mockResolvedValue(doc(3, { revision: 6 }))

        applyHeaderProfileSelection(useStore.getState().selectProfile, chosen, true)
        expect(useStore.getState().profileId).toBe(7)

        await vi.advanceTimersByTimeAsync(5000)
        expect(updateDocument).toHaveBeenCalled()
      } finally {
        unsubscribe()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fallbackName', () => {
  it('mirrors the backend rule', () => {
    expect(fallbackName('a b c d e f g h')).toBe('a b c d e f')
    expect(fallbackName('   ')).toBeNull()
  })
})

describe('folders', () => {
  it('moveDocumentToFolder updates the summary in place', async () => {
    useStore.getState().setDocuments([
      { ...summaryOf(doc(1)), folder_id: null },
      { ...summaryOf(doc(2)), folder_id: null },
    ])
    vi.mocked(moveDocument).mockResolvedValue(doc(2, { folder_id: 5 }))
    await moveDocumentToFolder(2, 5)
    const docs = useStore.getState().documents
    expect(docs.find((d) => d.id === 2)?.folder_id).toBe(5)
    expect(docs.find((d) => d.id === 1)?.folder_id).toBeNull()
    // Order untouched — moves never reorder recency.
    expect(docs.map((d) => d.id)).toEqual([1, 2])
  })

  it('moveDocumentToFolder refreshes folders and documents on a 422 (target folder vanished)', async () => {
    const docs = [
      { ...summaryOf(doc(1)), folder_id: null },
      { ...summaryOf(doc(2)), folder_id: null },
    ]
    useStore.getState().setDocuments(docs)
    vi.mocked(moveDocument).mockRejectedValue(new HttpError(422, 'folder gone'))
    vi.mocked(listFolders).mockResolvedValue([])
    vi.mocked(listDocuments).mockResolvedValue(docs)
    await moveDocumentToFolder(2, 5)
    expect(listFolders).toHaveBeenCalled()
    expect(listDocuments).toHaveBeenCalled()
    const stored = useStore.getState().documents
    expect(stored.find((d) => d.id === 2)?.folder_id).toBeNull()
    expect(stored.find((d) => d.id === 1)?.folder_id).toBeNull()
    expect(useStore.getState().docListError).toBe(false)
  })

  it('moveDocumentToFolder sets docListError on non-422 failures without refreshing', async () => {
    const docs = [
      { ...summaryOf(doc(1)), folder_id: null },
      { ...summaryOf(doc(2)), folder_id: null },
    ]
    useStore.getState().setDocuments(docs)
    vi.mocked(moveDocument).mockRejectedValue(new TypeError('offline'))
    await moveDocumentToFolder(2, 5)
    expect(listFolders).not.toHaveBeenCalled()
    expect(listDocuments).not.toHaveBeenCalled()
    const stored = useStore.getState().documents
    expect(stored.find((d) => d.id === 2)?.folder_id).toBeNull()
    expect(stored.find((d) => d.id === 1)?.folder_id).toBeNull()
    expect(useStore.getState().docListError).toBe(true)
  })

  it('moveDocumentToFolder does not set docListError once the session already ended', async () => {
    const docs = [
      { ...summaryOf(doc(1)), folder_id: null },
      { ...summaryOf(doc(2)), folder_id: null },
    ]
    useStore.getState().setDocuments(docs)
    useStore.getState().setDocListError(false)
    let rejectMove!: (err: unknown) => void
    vi.mocked(moveDocument).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectMove = reject
        }),
    )
    const call = moveDocumentToFolder(2, 5)
    invalidateDocumentWork() // simulates logout()/expireSession() firing mid-flight
    rejectMove(new TypeError('offline'))
    await call
    expect(useStore.getState().docListError).toBe(false)
  })

  it('removeFolder refreshes folders and documents', async () => {
    vi.mocked(deleteFolder).mockResolvedValue(undefined)
    vi.mocked(listFolders).mockResolvedValue([])
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(1))])
    await removeFolder(3)
    expect(deleteFolder).toHaveBeenCalledWith(3)
    expect(listFolders).toHaveBeenCalled()
    expect(listDocuments).toHaveBeenCalled()
  })

  it('addFolder inserts keeping name order and rethrows conflicts', async () => {
    useStore.getState().setFolders([
      { id: 1, name: 'alpha', created_at: '' },
      { id: 2, name: 'Zulu', created_at: '' },
    ] as never[])
    vi.mocked(createFolder).mockResolvedValue({ id: 3, name: 'Mango', created_at: '' } as never)
    await addFolder('  Mango  ')
    expect(createFolder).toHaveBeenCalledWith('Mango')
    expect(useStore.getState().folders.map((f) => f.name)).toEqual([
      'alpha',
      'Mango',
      'Zulu',
    ])
    vi.mocked(createFolder).mockRejectedValue(new HttpError(409, 'dup'))
    await expect(addFolder('Mango')).rejects.toThrow('dup')
  })

  it('addFolder() does not append the outgoing user\'s new folder once the session has ended', async () => {
    useStore.getState().setFolders([{ id: 1, name: 'alpha', created_at: '' }] as never[])
    let resolveCreate: ((f: Folder) => void) | undefined
    vi.mocked(createFolder).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }) as never,
    )

    const pending = addFolder('Mango') // starts; will reach `await apiCreateFolder`
    await vi.waitFor(() => {
      if (!resolveCreate) throw new Error('createFolder not called yet')
    })

    invalidateDocumentWork() // the session that started this create has ended
    useStore.getState().setFolders([{ id: 2, name: 'incoming', created_at: '' }] as never[]) // a wholly different, incoming list

    resolveCreate!({ id: 3, name: 'Mango', created_at: '' } as never)
    await pending

    // Must still be exactly the incoming list — not with "Mango" appended,
    // which would be the outgoing user's newly created folder leaking into
    // the incoming user's live list.
    expect(useStore.getState().folders.map((f) => f.name)).toEqual(['incoming'])
  })

  it('createNewDocument places the document in the given folder', async () => {
    useStore.getState().setDocMeta(null)
    vi.mocked(createDocument).mockResolvedValue(doc(9, { folder_id: 4 }))
    await createNewDocument(4)
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ folder_id: 4 }),
    )
    expect(useStore.getState().documents[0].folder_id).toBe(4)
  })
})

function folderWith(overrides: Partial<Folder>): Folder {
  return {
    id: 1,
    name: 'F',
    created_at: '',
    default_language: null,
    default_profile_id: null,
    default_domain_ids: null,
    default_llm_provider: null,
    default_llm_model: null,
    default_llm_tier: null,
    default_llm_auto: null,
    ...overrides,
  }
}

function basePayload(): DocumentCreatePayload {
  return {
    name: 'Untitled',
    language: 'en',
    profile_id: 7,
    domain_ids: [1, 2],
    llm_provider: null,
    llm_model: null,
    llm_tier: 'balanced',
    llm_auto: true,
  }
}

describe('applyFolderDefaults', () => {
  it('no folder or no defaults: payload unchanged', () => {
    expect(applyFolderDefaults(basePayload(), undefined)).toEqual(basePayload())
    expect(applyFolderDefaults(basePayload(), folderWith({}))).toEqual(
      basePayload(),
    )
  })

  it('overrides exactly the set fields', () => {
    const folder = folderWith({
      default_language: 'en',
      default_profile_id: 42,
      default_llm_auto: false,
    })
    const out = applyFolderDefaults(basePayload(), folder)
    expect(out.language).toBe('en')
    expect(out.profile_id).toBe(42)
    expect(out.llm_auto).toBe(false)
    // Unset defaults leave the header values alone.
    expect(out.domain_ids).toEqual([1, 2])
    expect(out.llm_tier).toBe('balanced')
  })

  it('a language default without a profile default clears a cross-language header profile', () => {
    // Header is en with profile 7; the folder pins de but no profile. The en
    // profile must not leak onto a de document.
    const out = applyFolderDefaults(
      basePayload(),
      folderWith({ default_language: 'de' }),
    )
    expect(out.language).toBe('de')
    expect(out.profile_id).toBeNull()
  })

  it('a language default equal to the header language keeps the header profile', () => {
    const out = applyFolderDefaults(
      basePayload(),
      folderWith({ default_language: 'en' }),
    )
    expect(out.profile_id).toBe(7)
  })

  it('empty domains default overrides ([] is set, not unset)', () => {
    const out = applyFolderDefaults(
      basePayload(),
      folderWith({ default_domain_ids: [] }),
    )
    expect(out.domain_ids).toEqual([])
  })

  it('the LLM triple applies as one unit (tier default)', () => {
    const header: DocumentCreatePayload = {
      ...basePayload(),
      llm_provider: 'ollama',
      llm_model: 'llama3',
      llm_tier: null,
    }
    const out = applyFolderDefaults(
      header,
      folderWith({ default_llm_tier: 'cheap' }),
    )
    expect(out.llm_tier).toBe('cheap')
    expect(out.llm_provider).toBeNull()
    expect(out.llm_model).toBeNull()
  })

  it('the LLM triple applies as one unit (pinned default)', () => {
    const out = applyFolderDefaults(
      basePayload(),
      folderWith({
        default_llm_provider: 'openai',
        default_llm_model: 'gpt-4o',
        default_llm_tier: null,
      }),
    )
    expect(out.llm_provider).toBe('openai')
    expect(out.llm_model).toBe('gpt-4o')
    expect(out.llm_tier).toBeNull()
  })
})

describe('saveFolderDefaults', () => {
  it('updates the folder in place in the store', async () => {
    const before = folderWith({ id: 5, name: 'Blog' })
    const other = folderWith({ id: 6, name: 'Work' })
    useStore.setState({ folders: [before, other] })
    const after = folderWith({ id: 5, name: 'Blog', default_language: 'de' })
    vi.mocked(putFolderDefaults).mockResolvedValue(after)
    await saveFolderDefaults(5, after)
    expect(useStore.getState().folders).toEqual([after, other])
  })

  it('rethrows failures without touching the store', async () => {
    const folder = folderWith({ id: 5 })
    useStore.setState({ folders: [folder] })
    vi.mocked(putFolderDefaults).mockRejectedValue(new HttpError(404, 'gone'))
    await expect(saveFolderDefaults(5, folder)).rejects.toThrow()
    expect(useStore.getState().folders).toEqual([folder])
  })
})
