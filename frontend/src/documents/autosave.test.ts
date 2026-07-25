// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../api/client'
import { useStore } from '../state/store'
import { readSnapshot, clearSnapshot } from './buffer'
import {
  beginHydration,
  bumpGeneration,
  cancelDebounce,
  endHydration,
  flush,
  noteChange,
  resetAutosaveForTests,
  setConflictHandler,
} from './autosave'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  updateDocument: vi.fn(),
  generateDocumentName: vi.fn(),
}))
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => ({ state: { doc: { toString: () => docText } } }),
}))

import { generateDocumentName, updateDocument } from '../api/client'

let docText = 'hello world'

const USER = { id: 1, email: 'ada@example.com', display_name: null, tier: 'basic', is_admin: false }

function seedStore(): void {
  useStore.getState().setDocMeta({ id: 5, name: 'Doc', nameSource: 'user', revision: 2 })
  useStore.getState().setDocuments([
    {
      id: 5,
      name: 'Doc',
      language: 'en',
      folder_id: null,
      created_at: '2026-07-10T00:00:00+00:00',
      edited_at: '2026-07-10T00:00:00+00:00',
      checked_at: null,
      updated_at: '2026-07-10T00:00:00+00:00',
    },
  ])
  useStore.setState({ user: USER })
}

function serverDoc(revision: number) {
  return {
    id: 5,
    revision,
    name: 'Doc',
    name_source: 'user',
    edited_at: '2026-07-11T00:00:00+00:00',
    checked_at: null,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetAutosaveForTests()
  localStorage.clear()
  clearSnapshot()
  docText = 'hello world'
  seedStore()
  vi.mocked(updateDocument).mockResolvedValue(serverDoc(3) as never)
  vi.mocked(generateDocumentName).mockResolvedValue(serverDoc(3) as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('autosave', () => {
  it('noteChange writes a dirty snapshot synchronously and debounces the PUT', async () => {
    noteChange()
    expect(readSnapshot()?.dirty).toBe(true)
    expect(readSnapshot()?.text).toBe('hello world')
    expect(updateDocument).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(updateDocument).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateDocument).mock.calls[0][1].revision).toBe(2)
    // Success: buffer clean, revision advanced.
    expect(readSnapshot()?.dirty).toBe(false)
    expect(useStore.getState().docMeta?.revision).toBe(3)
  })

  it('rapid noteChange calls collapse into one PUT', async () => {
    noteChange()
    await vi.advanceTimersByTimeAsync(500)
    noteChange()
    await vi.advanceTimersByTimeAsync(1500)
    expect(updateDocument).toHaveBeenCalledTimes(1)
  })

  it('hydration suppresses noteChange', () => {
    beginHydration()
    noteChange()
    endHydration()
    expect(readSnapshot()).toBeNull()
  })

  it('network failure keeps the buffer dirty and retries with backoff', async () => {
    vi.mocked(updateDocument).mockRejectedValueOnce(new TypeError('offline'))
    await flush()
    expect(readSnapshot()?.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(2000) // first retry
    expect(updateDocument).toHaveBeenCalledTimes(2)
    expect(readSnapshot()?.dirty).toBe(false)
  })

  it('409 routes to the conflict handler instead of retrying', async () => {
    const onConflict = vi.fn().mockResolvedValue(undefined)
    setConflictHandler(onConflict)
    vi.mocked(updateDocument).mockRejectedValueOnce(new HttpError(409, 'stale'))
    await flush()
    expect(onConflict).toHaveBeenCalledTimes(1)
    expect(onConflict.mock.calls[0][0].docId).toBe(5)
    await vi.advanceTimersByTimeAsync(60000)
    expect(updateDocument).toHaveBeenCalledTimes(1) // no retry loop
  })

  it('generates a title once when a fallback-named doc passes 20 words', async () => {
    useStore.getState().patchDocMeta({ nameSource: 'fallback' })
    docText = Array.from({ length: 21 }, (_, i) => `w${i}`).join(' ')
    vi.mocked(generateDocumentName).mockResolvedValue({
      ...serverDoc(3),
      name: 'Generated Title',
      name_source: 'llm',
    } as never)
    await flush()
    expect(generateDocumentName).toHaveBeenCalledTimes(1)
    expect(useStore.getState().docMeta?.name).toBe('Generated Title')
    expect(useStore.getState().documents[0].name).toBe('Generated Title')
    await flush()
    expect(generateDocumentName).toHaveBeenCalledTimes(1) // once per session
  })

  it('does not title short or already-named documents', async () => {
    docText = 'only four words here'
    useStore.getState().patchDocMeta({ nameSource: 'fallback' })
    await flush()
    docText = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ')
    useStore.getState().patchDocMeta({ nameSource: 'user' })
    await flush()
    expect(generateDocumentName).not.toHaveBeenCalled()
  })

  it('a flush during an in-flight save queues exactly one follow-up (content changed meanwhile)', async () => {
    let resolveFirst!: (value: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }) as never,
    )

    void flush() // save #1 starts and is now in flight
    expect(updateDocument).toHaveBeenCalledTimes(1)
    // The queued follow-up only produces a real PUT if something actually
    // changed in the meantime — otherwise the no-op guard suppresses it.
    docText = 'hello world, edited'
    void flush() // in flight: just sets pending
    void flush() // still in flight: pending already set

    resolveFirst(serverDoc(3))
    await vi.advanceTimersByTimeAsync(0)

    expect(updateDocument).toHaveBeenCalledTimes(2)
  })

  it('flush() awaited during an in-flight push resolves only after that push and its follow-up complete', async () => {
    let resolveFirst!: (value: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }) as never,
    )

    const p1 = flush() // save #1 starts and is now in flight
    expect(updateDocument).toHaveBeenCalledTimes(1)
    // As above: the follow-up only PUTs again if content actually changed.
    docText = 'hello world, edited'

    let callsWhenP2Resolved = -1
    const p2 = flush().then(() => {
      // By the time an awaited flush() resolves, the follow-up push it
      // queued must already have happened too.
      callsWhenP2Resolved = vi.mocked(updateDocument).mock.calls.length
    })

    resolveFirst(serverDoc(3))
    await vi.advanceTimersByTimeAsync(0)
    await p1
    await p2

    expect(callsWhenP2Resolved).toBe(2)
    expect(updateDocument).toHaveBeenCalledTimes(2)
  })

  it('flush() no-ops when nothing changed since the last successful save; a real edit lifts the guard', async () => {
    await flush()
    expect(updateDocument).toHaveBeenCalledTimes(1)
    expect(readSnapshot()?.dirty).toBe(false)

    await flush() // nothing changed: must not PUT again
    expect(updateDocument).toHaveBeenCalledTimes(1)

    docText = 'hello world, edited'
    await flush() // a real edit: the guard must not stick
    expect(updateDocument).toHaveBeenCalledTimes(2)
  })

  it('a failed in-flight save does not fire the queued flush immediately', async () => {
    let rejectFirst!: (reason?: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject
        }) as never,
    )

    void flush() // save #1 starts and is now in flight
    void flush() // in flight: sets pending

    rejectFirst(new TypeError('offline'))
    await vi.advanceTimersByTimeAsync(0)

    // The failed push scheduled a backoff retry; the queued flush must not
    // fire immediately (that would bypass the backoff).
    expect(updateDocument).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2000) // the scheduled retry fires
    expect(updateDocument).toHaveBeenCalledTimes(2)
    expect(readSnapshot()?.dirty).toBe(false)
  })
})

describe('ownership', () => {
  it('stamps the snapshot with the signed-in user id', () => {
    noteChange()
    expect(readSnapshot()?.ownerId).toBe(1)
  })

  it('collects nothing without a signed-in user, same as a missing docMeta', () => {
    useStore.setState({ user: null })
    noteChange()
    expect(readSnapshot()).toBeNull()
  })
})

describe('invalidation (logout / expiry mid-flight)', () => {
  it('a push already in flight when the session ends does not write the buffer back', async () => {
    let resolveFirst!: (value: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }) as never,
    )

    void flush() // save starts and is now in flight
    expect(updateDocument).toHaveBeenCalledTimes(1)

    bumpGeneration() // simulates logout()/expireSession() firing mid-flight

    resolveFirst(serverDoc(3))
    await vi.advanceTimersByTimeAsync(0)

    // The completion must not have rewritten the buffer or docMeta: both
    // still reflect the state from before the (now-stale) push resolved.
    expect(readSnapshot()?.dirty).toBe(true)
    expect(useStore.getState().docMeta?.revision).toBe(2)
  })

  it('a push that fails after the session ends does not schedule a retry', async () => {
    let rejectFirst!: (reason?: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject
        }) as never,
    )

    void flush()
    bumpGeneration()
    rejectFirst(new TypeError('offline'))
    await vi.advanceTimersByTimeAsync(60000)

    expect(updateDocument).toHaveBeenCalledTimes(1) // no retry fired
  })

  it('cancelDebounce cancels a pending debounced save', async () => {
    noteChange()
    cancelDebounce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(updateDocument).not.toHaveBeenCalled()
  })
})
