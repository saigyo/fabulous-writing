// @vitest-environment happy-dom
// Unlike session.test.ts, this file does NOT mock documents/documents.ts
// (or documents/autosave.ts). session.test.ts proves each piece is *wired
// up* — invalidateDocumentWork() and clearLegacyText() get called — but
// with those modules replaced by vi.fn()s, nothing there proves the real
// composition actually behaves: that a save landing after a real logout()
// truly writes nothing, or that logging out for real actually removes
// fabulous-writing-text from localStorage rather than just calling a mock
// that claims to.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { clearSnapshot, readSnapshot } from '../documents/buffer'
import { resetAutosaveForTests, flush } from '../documents/autosave'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postLogin: vi.fn(),
  updateDocument: vi.fn(),
}))
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => ({ state: { doc: { toString: () => 'hello world' } } }),
}))

import { postLogin, updateDocument } from '../api/client'
import { login, logout } from './session'

const USER: MeResponse = {
  id: 1,
  email: 'ada@example.com',
  display_name: null,
  tier: 'basic',
  is_admin: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAutosaveForTests()
  localStorage.clear()
  clearSnapshot()
  useStore.setState({
    token: 'tok',
    user: USER,
    authStatus: 'authenticated',
    sessionExpired: false,
    restoreFailed: false,
    checkPhase: 'idle',
  })
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
})

describe('a real logout() vs. a real save in flight', () => {
  it('a push that fails after a real logout() does not schedule a retry', async () => {
    vi.useFakeTimers()
    try {
      let rejectPut!: (reason?: unknown) => void
      vi.mocked(updateDocument).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPut = reject
          }) as never,
      )

      void flush() // the real push() starts and is now in flight
      expect(updateDocument).toHaveBeenCalledTimes(1)

      logout() // the real logout(): invalidateDocumentWork -> bumpGeneration

      rejectPut(new TypeError('offline'))
      await vi.advanceTimersByTimeAsync(60000)

      // Only the real generation guard in push()'s catch branch prevents
      // this: docMeta is null after logout() too, but that check doesn't
      // gate scheduleRetry() — the generation check is the only thing that
      // does.
      expect(updateDocument).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a push that succeeds after a real logout() does not write the buffer back', async () => {
    let resolvePut!: (v: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePut = resolve
        }) as never,
    )

    const pending = flush() // the real push() starts and is now in flight
    logout() // clears the buffer for real; the stale push must not recreate it

    resolvePut({
      id: 5,
      revision: 3,
      name: 'Doc',
      name_source: 'user',
      edited_at: '2026-07-11T00:00:00+00:00',
      checked_at: null,
    })
    await pending

    expect(readSnapshot()).toBeNull()
  })
})

describe('the failed-legacy-migration handoff, against real localStorage', () => {
  it('a real logout() removes fabulous-writing-text', () => {
    localStorage.setItem('fabulous-writing-text', 'previous user private text')
    logout()
    expect(localStorage.getItem('fabulous-writing-text')).toBeNull()
  })

  it('a real login() as a different (or unowned) user also removes fabulous-writing-text', async () => {
    localStorage.setItem('fabulous-writing-text', 'previous user private text')
    vi.mocked(postLogin).mockResolvedValue({
      token: 'tok2',
      user: { ...USER, id: 2 },
    })
    await login('b@example.com', 'pw')
    expect(localStorage.getItem('fabulous-writing-text')).toBeNull()
  })
})
