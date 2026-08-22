// @vitest-environment happy-dom
// Unlike session.test.ts, this file does NOT mock documents/documents.ts
// (or documents/autosave.ts). session.test.ts proves each piece is *wired
// up* — invalidateDocumentWork() and clearLegacyText() get called — but
// with those modules replaced by vi.fn()s, nothing there proves the real
// composition actually behaves: that a save landing after a real logout()
// truly writes nothing, or that logging out for real actually removes
// fabulous-writing-text from localStorage rather than just calling a mock
// that claims to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { clearSnapshot, readSnapshot } from '../documents/buffer'
import { resetAutosaveForTests, flush } from '../documents/autosave'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postLogin: vi.fn(),
  // Resolved once here (see App.domains-guard.test.tsx's comment): this
  // file's beforeEach uses clearAllMocks(), which preserves the
  // implementation, and every logout() below runs with a real token.
  postLogout: vi.fn().mockResolvedValue(undefined),
  updateDocument: vi.fn(),
}))
import { postLogin, updateDocument } from '../api/client'
import { setDocumentPort, type DocumentPort } from '../checking/documentPort'
import { login, logout } from './session'

const fakePort: DocumentPort = {
  hasDocument: () => true,
  getText: () => 'hello world',
  setDocument: () => {},
  currentFinding: () => null,
  serverSpan: () => null,
  mergeFindings: () => {},
  selectFinding: () => {},
  applySuggestion: () => Promise.resolve('not-found'),
  applyRewrite: () => Promise.resolve('not-found'),
}

const USER: MeResponse = {
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
  vi.clearAllMocks()
  resetAutosaveForTests()
  localStorage.clear()
  clearSnapshot()
  setDocumentPort(fakePort)
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

afterEach(() => {
  setDocumentPort(null)
})

// A real logout() (and login() as a different user) resets `user` and
// `docMeta` to null/reset values. That means a save that lands afterwards
// is *already* blocked by push()'s own `docMeta?.id === snapshot.docId`
// check (success path) or by collectSnapshot() returning null once the
// retry's own flush() re-collects (catch path) — REGARDLESS of whether
// push()'s generation guards (autosave.ts) are present. An earlier version
// of these two tests logged out and asserted "nothing was written", which
// passed even with both generation guards deleted, for exactly that reason.
//
// To isolate the generation check as the only remaining line of defense,
// both tests below log out AND log back in as a *different* user, then
// deliberately set that user's docMeta to point at the SAME numeric
// document id (5) the outgoing user's save was for — plausible once a
// per-user id space exists, and exactly the setup the generation guard is
// for regardless: docMeta?.id matches again (for the wrong reason), and
// collectSnapshot() would return a real, non-null snapshot for the
// *incoming* user's document if asked. With user/docMeta both live and
// matching, only the generation check stands between the outgoing user's
// stale save and overwriting the incoming user's currently-open document.
describe('a real logout()+login() turnover vs. a real save started under the outgoing user', () => {
  async function switchToADifferentUserWithTheSameDocIdOpen(): Promise<void> {
    logout() // the real logout()
    vi.mocked(postLogin).mockResolvedValue({
      token: 'tok2',
      refresh_token: null,
      expires_at: null,
      user: { ...USER, id: 2 },
    })
    await login('b@example.com', 'pw') // the real login(), as a different user
    useStore.getState().setDocMeta({ id: 5, name: "B's doc", nameSource: 'user', revision: 9 })
  }

  it('a push that fails after the turnover does not retry into the new user\'s document', async () => {
    vi.useFakeTimers()
    try {
      let rejectPut!: (reason?: unknown) => void
      vi.mocked(updateDocument).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPut = reject
          }) as never,
      )

      void flush() // user A's real push() starts (doc 5, revision 2), now in flight
      expect(updateDocument).toHaveBeenCalledTimes(1)

      await switchToADifferentUserWithTheSameDocIdOpen()

      rejectPut(new TypeError('offline'))
      await vi.advanceTimersByTimeAsync(60000)

      // Without the generation guard, scheduleRetry() fires unconditionally;
      // the retry's own flush() would then find a live, matching docMeta
      // and a real collectSnapshot() and genuinely re-save — landing an
      // unrelated, stale-revision write on user B's document.
      expect(updateDocument).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a push that succeeds after the turnover does not overwrite the new user\'s document', async () => {
    let resolvePut!: (v: unknown) => void
    vi.mocked(updateDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePut = resolve
        }) as never,
    )

    const pending = flush() // user A's real push() starts (doc 5, revision 2), now in flight
    await switchToADifferentUserWithTheSameDocIdOpen()

    resolvePut({
      id: 5,
      revision: 3,
      name: 'Doc',
      name_source: 'user',
      edited_at: '2026-07-11T00:00:00+00:00',
      checked_at: null,
    })
    await pending

    // Without the generation guard, this would patch docMeta's revision to
    // 3 (user A's server response) and rewrite the localStorage buffer with
    // user A's stale text, dirty: false, under user B's document.
    expect(useStore.getState().docMeta).toEqual({
      id: 5,
      name: "B's doc",
      nameSource: 'user',
      revision: 9,
    })
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
      refresh_token: null,
      expires_at: null,
      user: { ...USER, id: 2 },
    })
    await login('b@example.com', 'pw')
    expect(localStorage.getItem('fabulous-writing-text')).toBeNull()
  })
})
