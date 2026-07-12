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
import { clearSnapshot, readSnapshot, writeSnapshot } from './buffer'
import { flush, noteChange, resetAutosaveForTests } from './autosave'
import {
  createNewDocument,
  fallbackName,
  initDocuments,
  moveDocumentToFolder,
  openDocument,
  removeDocument,
  removeFolder,
} from './documents'
import { addFolder, applyFolderDefaults, saveFolderDefaults } from './folders'
import {
  applyHeaderProfileSelection,
  consumeProfileApplySuppression,
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
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => fakeView,
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
