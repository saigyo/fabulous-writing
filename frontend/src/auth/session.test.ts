// @vitest-environment happy-dom
// The session flow reads and writes real localStorage keys — the token
// key and the per-user preference blobs (prefsStorage.ts) — which the
// default "node" test environment has no window/localStorage for.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, type LoginResponse, type MeResponse } from '../api/client'
import type { DocSnapshot } from '../documents/buffer'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postLogin: vi.fn(),
  postRefresh: vi.fn(),
  postLogout: vi.fn(),
  getMe: vi.fn(),
}))
// documents.ts pulls in hydration.ts -> checking/controller.ts; session.ts
// only needs these two exports, so the module is replaced outright rather
// than partially mocked (matching how controller.test.ts mocks api/client).
vi.mock('../documents/documents', () => ({
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))

import { getMe, postLogin, postLogout, postRefresh } from '../api/client'
import { setCancelCheckHandler } from '../checking/cancelSlot'
import { clearLegacyText, invalidateDocumentWork } from '../documents/documents'
import { clearSnapshot, readSnapshot, writeSnapshot } from '../documents/buffer'
import { initPrefsPersistence, PREFS_DEFAULTS } from '../state/prefsPersistence'
import {
  readPrefs,
  readRefreshToken,
  readToken,
  readTokenExpiresAt,
  writePrefs,
} from '../state/prefsStorage'
import {
  expireSession,
  login,
  logout,
  refreshSession,
  refreshUser,
  restoreSession,
  sessionGeneration,
} from './session'

initPrefsPersistence()

function user(id: number, overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id,
    email: `user${id}@example.com`,
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
    ...overrides,
  }
}

function snapshotFor(ownerId: number | undefined): DocSnapshot {
  return {
    docId: 1,
    revision: 1,
    dirty: true,
    name: 'Doc',
    text: 'buffered text',
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
    ownerId,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  // resetAllMocks() wipes any implementation, so postLogout must be
  // re-armed every test: a logout()/expireSession() test set up with a
  // real token calls the real logout path, and an unresolved postLogout()
  // would throw on the missing .catch().
  vi.mocked(postLogout).mockResolvedValue(undefined)
  localStorage.clear()
  clearSnapshot()
  setCancelCheckHandler(() => {})
  useStore.setState({
    token: null,
    refreshToken: null,
    tokenExpiresAt: null,
    user: null,
    authStatus: 'unknown',
    sessionExpired: false,
    restoreFailed: false,
    uiLocale: null,
    currentDocId: null,
    checkPhase: 'idle',
    tracked: [],
    documents: [],
    folders: [],
    scorecard: null,
  })
})

describe('login', () => {
  it('stores the token and user returned by the API and flips authStatus to authenticated', async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    const ok = await login('ada@example.com', 'pw')
    expect(ok).toBe(true)
    const state = useStore.getState()
    expect(state.token).toBe('tok')
    expect(state.user).toEqual(user(1))
    expect(state.authStatus).toBe('authenticated')
  })

  it('propagates a login error to the caller and leaves authStatus anonymous', async () => {
    useStore.setState({ authStatus: 'anonymous' })
    vi.mocked(postLogin).mockRejectedValue(new HttpError(401, 'Invalid email or password'))
    await expect(login('ada@example.com', 'wrong')).rejects.toThrow('Invalid email or password')
    expect(useStore.getState().authStatus).toBe('anonymous')
  })

  it('clears a document buffer belonging to a different user', async () => {
    writeSnapshot(snapshotFor(99))
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    expect(readSnapshot()).toBeNull()
  })

  it('keeps a document buffer already belonging to the signing-in user', async () => {
    writeSnapshot(snapshotFor(1))
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    expect(readSnapshot()).not.toBeNull()
  })

  it('clears a buffer with no ownerId at all (written by an older build)', async () => {
    writeSnapshot(snapshotFor(undefined))
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    expect(readSnapshot()).toBeNull()
  })

  it('preserves the persisted settings when signing in as the same user', async () => {
    useStore.setState({ user: user(1), uiLocale: 'de', currentDocId: 42 })
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok2', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    expect(useStore.getState().uiLocale).toBe('de')
    expect(useStore.getState().currentDocId).toBe(42)
  })

  it('resets in-memory state to defaults when signing in as a different user with no stored preferences', async () => {
    useStore.setState({
      user: user(1),
      uiLocale: 'de',
      currentDocId: 42,
      tracked: [{ finding: {}, from: 0, to: 1 }] as never,
      documents: [{ id: 1, name: 'X' }] as never,
      folders: [{ id: 1, name: 'F' }] as never,
      scorecard: { overall: 50 } as never,
    })
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok2', refresh_token: null, expires_at: null, user: user(2) })
    await login('b@example.com', 'pw')
    const state = useStore.getState()
    expect(state.uiLocale).toBeNull()
    expect(state.currentDocId).toBeNull()
    expect(state.tracked).toEqual([])
    expect(state.documents).toEqual([])
    expect(state.folders).toEqual([])
    expect(state.scorecard).toBeNull()
  })

  it('clears the legacy text key on a foreign or unowned login', async () => {
    writeSnapshot(snapshotFor(99))
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    expect(clearLegacyText).toHaveBeenCalled()
  })

  it('persists the token under the token key; logout removes it', async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    expect(localStorage.getItem('fabulous-writing-token')).toBe('tok')
    logout()
    expect(localStorage.getItem('fabulous-writing-token')).toBeNull()
  })

  it('returns false and commits nothing when logout() runs while postLogin is in flight', async () => {
    let resolvePostLogin!: (v: LoginResponse) => void
    vi.mocked(postLogin).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePostLogin = resolve
        }),
    )
    useStore.setState({ token: null, user: null, authStatus: 'anonymous' })

    const pending = login('a@example.com', 'pw')
    logout() // fires while postLogin is still in flight

    resolvePostLogin({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    const result = await pending

    expect(result).toBe(false)
    const state = useStore.getState()
    expect(state.token).toBeNull()
    expect(state.user).toBeNull()
    expect(state.authStatus).toBe('anonymous')
  })

  it('persists the refresh-token triple and schedules a refresh ahead of expiry', async () => {
    vi.useFakeTimers()
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + 300
      vi.mocked(postLogin).mockResolvedValue({
        token: 'tok',
        refresh_token: 'rt',
        expires_at: expiresAt,
        user: user(1),
      })
      await login('a@example.com', 'pw')

      expect(readToken()).toBe('tok')
      expect(readRefreshToken()).toBe('rt')
      expect(readTokenExpiresAt()).toBe(expiresAt)
      const state = useStore.getState()
      expect(state.refreshToken).toBe('rt')
      expect(state.tokenExpiresAt).toBe(expiresAt)

      vi.mocked(postRefresh).mockResolvedValue({
        token: 'tok2',
        refresh_token: 'rt2',
        expires_at: expiresAt + 300,
        user: user(1),
      })
      await vi.advanceTimersByTimeAsync(300_000 - 120_000) // expiry - REFRESH_MARGIN_MS
      expect(postRefresh).toHaveBeenCalledTimes(1)
      expect(postRefresh).toHaveBeenCalledWith('rt')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never schedules a refresh when the response carries no refresh triple (local mode)', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(postLogin).mockResolvedValue({
        token: 'tok',
        refresh_token: null,
        expires_at: null,
        user: user(1),
      })
      await login('a@example.com', 'pw')

      expect(readRefreshToken()).toBeNull()
      expect(readTokenExpiresAt()).toBeNull()
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000) // a full day
      expect(postRefresh).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('logout', () => {
  it('clears token, user, in-memory settings and the document buffer, resets checkPhase, and sets anonymous', () => {
    useStore.setState({
      token: 'tok',
      user: user(1),
      authStatus: 'authenticated',
      checkPhase: 'llm',
      uiLocale: 'de',
    })
    writeSnapshot(snapshotFor(1))

    logout()

    const state = useStore.getState()
    expect(state.token).toBeNull()
    expect(state.user).toBeNull()
    expect(state.authStatus).toBe('anonymous')
    expect(state.checkPhase).toBe('idle')
    expect(state.uiLocale).toBeNull()
    expect(readSnapshot()).toBeNull()
  })

  it('calls invalidateDocumentWork() and clearLegacyText()', () => {
    logout()
    expect(invalidateDocumentWork).toHaveBeenCalledTimes(1)
    expect(clearLegacyText).toHaveBeenCalledTimes(1)
  })

  it('calls the registered cancelInFlightCheck handler', () => {
    const spy = vi.fn()
    setCancelCheckHandler(spy)
    logout()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('fires postLogout while the store token is still set, before clearing it, and clears the refresh-token pair', () => {
    useStore.setState({
      token: 'tok',
      refreshToken: 'rt',
      tokenExpiresAt: 1_900_000_000,
      user: user(1),
      authStatus: 'authenticated',
    })
    localStorage.setItem('fabulous-writing-refresh-token', 'rt')
    localStorage.setItem('fabulous-writing-token-expires', '1900000000')
    let tokenAtCallTime: string | null | undefined
    vi.mocked(postLogout).mockImplementation(() => {
      tokenAtCallTime = useStore.getState().token
      return Promise.resolve()
    })

    logout()

    expect(postLogout).toHaveBeenCalledTimes(1)
    expect(tokenAtCallTime).toBe('tok')
    expect(readRefreshToken()).toBeNull()
    expect(readTokenExpiresAt()).toBeNull()
    // Finding 2 (final review): storage alone is not enough -- the pair
    // must also die in the STORE, or an orphaned refresh timer can still
    // read a live refreshToken back off useStore and rematerialise a
    // session for the departed user.
    expect(useStore.getState().refreshToken).toBeNull()
    expect(useStore.getState().tokenExpiresAt).toBeNull()
  })

  it('does not call postLogout for a visitor who was never signed in', () => {
    useStore.setState({ token: null, user: null, authStatus: 'anonymous' })
    logout()
    expect(postLogout).not.toHaveBeenCalled()
  })
})

describe('expireSession', () => {
  it('clears in-memory settings but keeps the document buffer', () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated', uiLocale: 'de' })
    writeSnapshot(snapshotFor(1))

    expireSession()

    const state = useStore.getState()
    expect(state.token).toBeNull()
    expect(state.user).toBeNull()
    expect(state.authStatus).toBe('anonymous')
    expect(state.sessionExpired).toBe(true)
    expect(state.uiLocale).toBeNull()
    expect(readSnapshot()).not.toBeNull() // the buffer survives
  })

  it('calls invalidateDocumentWork()', () => {
    expireSession()
    expect(invalidateDocumentWork).toHaveBeenCalledTimes(1)
  })

  it('calls the registered cancelInFlightCheck handler', () => {
    const spy = vi.fn()
    setCancelCheckHandler(spy)
    expireSession()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('removes the token key', () => {
    localStorage.setItem('fabulous-writing-token', 'tok')
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    expireSession()
    expect(localStorage.getItem('fabulous-writing-token')).toBeNull()
  })

  it('removes the refresh-token and token-expiry keys', () => {
    localStorage.setItem('fabulous-writing-refresh-token', 'rt')
    localStorage.setItem('fabulous-writing-token-expires', '1900000000')
    useStore.setState({
      token: 'tok',
      refreshToken: 'rt',
      tokenExpiresAt: 1_900_000_000,
      user: user(1),
      authStatus: 'authenticated',
    })
    expireSession()
    expect(readRefreshToken()).toBeNull()
    expect(readTokenExpiresAt()).toBeNull()
    // Finding 2 (final review): same store-level assertion as logout()'s test.
    expect(useStore.getState().refreshToken).toBeNull()
    expect(useStore.getState().tokenExpiresAt).toBeNull()
  })
})

describe('refresh engine (refreshSession/scheduleRefresh)', () => {
  async function loginWithTriple(expiresAt: number, refreshToken = 'rt'): Promise<void> {
    vi.mocked(postLogin).mockResolvedValue({
      token: 'tok',
      refresh_token: refreshToken,
      expires_at: expiresAt,
      user: user(1),
    })
    await login('a@example.com', 'pw')
  }

  it('a successful refresh rotates the store and storage and reschedules the next one', async () => {
    vi.useFakeTimers()
    try {
      // Deliberately far out: login()'s own scheduleRefresh() arms a timer
      // for THIS expiry, and it must not be the one that fires below — that
      // would pass even with doRefresh()'s own reschedule call deleted. Only
      // a reschedule keyed off the ROTATED (near) expiry set after the
      // manual refreshSession() call can fire inside this test's window.
      const farExpiresAt = Math.floor(Date.now() / 1000) + 100_000
      await loginWithTriple(farExpiresAt)

      const nearExpiresAt = Math.floor(Date.now() / 1000) + 300
      vi.mocked(postRefresh).mockResolvedValue({
        token: 'tok2',
        refresh_token: 'rt2',
        expires_at: nearExpiresAt,
        user: user(1),
      })
      await refreshSession()

      expect(postRefresh).toHaveBeenCalledWith('rt')
      const state = useStore.getState()
      expect(state.token).toBe('tok2')
      expect(state.refreshToken).toBe('rt2')
      expect(state.tokenExpiresAt).toBe(nearExpiresAt)
      expect(readToken()).toBe('tok2')
      expect(readRefreshToken()).toBe('rt2')
      expect(readTokenExpiresAt()).toBe(nearExpiresAt)

      // Reschedule check: only fires if doRefresh()'s success path re-armed
      // scheduleRefresh() off the rotated (near) expiry above.
      vi.mocked(postRefresh).mockClear()
      vi.mocked(postRefresh).mockResolvedValue({
        token: 'tok3',
        refresh_token: 'rt3',
        expires_at: nearExpiresAt + 300,
        user: user(1),
      })
      await vi.advanceTimersByTimeAsync(300_000 - 120_000) // nearExpiresAt - REFRESH_MARGIN_MS
      expect(postRefresh).toHaveBeenCalledTimes(1)
      expect(postRefresh).toHaveBeenCalledWith('rt2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a 401 on refresh ends the session through expireSession()', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    await loginWithTriple(expiresAt)

    vi.mocked(postRefresh).mockRejectedValue(new HttpError(401, 'refresh token revoked'))
    await refreshSession()

    const state = useStore.getState()
    expect(state.sessionExpired).toBe(true)
    expect(state.token).toBeNull()
    expect(state.authStatus).toBe('anonymous')
    expect(readToken()).toBeNull()
    expect(readRefreshToken()).toBeNull()
    expect(readTokenExpiresAt()).toBeNull()
  })

  it('a network error on refresh retries after 60s rather than ending the session', async () => {
    vi.useFakeTimers()
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + 300
      await loginWithTriple(expiresAt)

      vi.mocked(postRefresh).mockRejectedValueOnce(new TypeError('offline'))
      await refreshSession()
      expect(postRefresh).toHaveBeenCalledTimes(1)
      expect(useStore.getState().sessionExpired).toBe(false)

      vi.mocked(postRefresh).mockResolvedValue({
        token: 'tok2',
        refresh_token: 'rt2',
        expires_at: expiresAt + 300,
        user: user(1),
      })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(postRefresh).toHaveBeenCalledTimes(1) // not due yet
      await vi.advanceTimersByTimeAsync(30_000) // 60s total
      expect(postRefresh).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a second retry cancels the first retry timer instead of leaking it (finding 3)', async () => {
    vi.useFakeTimers()
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + 300
      await loginWithTriple(expiresAt)

      // First network failure arms a retry timer (T1), due 60s from now.
      vi.mocked(postRefresh).mockRejectedValueOnce(new TypeError('offline'))
      await refreshSession()
      expect(postRefresh).toHaveBeenCalledTimes(1)

      // 10s later -- T1 is still 50s out -- a second failure must CANCEL T1
      // and arm a fresh timer T2 (due 60s from NOW, i.e. 10s after T1's
      // original target) rather than orphaning it. An arming site that
      // bypasses cancelScheduledRefresh() leaks T1 as an uncancellable
      // duplicate that keeps running on its own schedule.
      await vi.advanceTimersByTimeAsync(10_000)
      vi.mocked(postRefresh).mockRejectedValueOnce(new TypeError('offline'))
      await refreshSession()
      expect(postRefresh).toHaveBeenCalledTimes(2)

      vi.mocked(postRefresh).mockResolvedValue({
        token: 'tok2',
        refresh_token: 'rt2',
        expires_at: expiresAt + 300,
        user: user(1),
      })
      // Just past T1's original target, still short of T2's: if T1 leaked,
      // it fires here and postRefresh is called a third time already.
      await vi.advanceTimersByTimeAsync(50_001)
      expect(postRefresh).toHaveBeenCalledTimes(2)

      // Now past T2's target as well.
      await vi.advanceTimersByTimeAsync(9_999)
      expect(postRefresh).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fresh generation issues its own refresh even while an older one is hung (finding 4)', async () => {
    vi.useFakeTimers()
    try {
      const expiresAt1 = Math.floor(Date.now() / 1000) + 300
      await loginWithTriple(expiresAt1, 'rt-old')

      // postRefresh never resolves -- models a hung request with no
      // timeout. The in-flight slot is now pinned to THIS generation.
      vi.mocked(postRefresh).mockImplementationOnce(() => new Promise(() => {}))
      void refreshSession()

      logout()
      const nearExpiresAt = Math.floor(Date.now() / 1000) + 300
      vi.mocked(postLogin).mockResolvedValue({
        token: 'tok-new',
        refresh_token: 'rt-new',
        expires_at: nearExpiresAt,
        user: user(2),
      })
      // A new generation, with its own scheduleRefresh() timer.
      await login('bea@example.com', 'pw')

      vi.mocked(postRefresh).mockResolvedValue({
        token: 'tok-new-2',
        refresh_token: 'rt-new-2',
        expires_at: nearExpiresAt + 300,
        user: user(2),
      })
      await vi.advanceTimersByTimeAsync(300_000 - 120_000) // nearExpiresAt - REFRESH_MARGIN_MS

      // Without generation-scoping the single-flight slot, this timer's
      // refreshSession() call would be handed the still-pending promise
      // from the OLD generation and never issue a second POST -- the new
      // user's session would silently end up with no working refresh timer.
      expect(postRefresh).toHaveBeenCalledTimes(2)
      expect(postRefresh).toHaveBeenLastCalledWith('rt-new')
    } finally {
      vi.useRealTimers()
    }
  })

  it('concurrent refreshSession() calls share one in-flight request', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    await loginWithTriple(expiresAt)

    let resolvePostRefresh!: (v: LoginResponse) => void
    vi.mocked(postRefresh).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePostRefresh = resolve
        }),
    )

    const p1 = refreshSession()
    const p2 = refreshSession()
    resolvePostRefresh({
      token: 'tok2',
      refresh_token: 'rt2',
      expires_at: expiresAt + 300,
      user: user(1),
    })
    await Promise.all([p1, p2])

    expect(postRefresh).toHaveBeenCalledTimes(1)
    expect(useStore.getState().token).toBe('tok2')
  })

  it('a refresh completing after logout() does not commit a stale token', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    await loginWithTriple(expiresAt)

    let resolvePostRefresh!: (v: LoginResponse) => void
    vi.mocked(postRefresh).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePostRefresh = resolve
        }),
    )
    const pending = refreshSession()
    logout() // fires while postRefresh is still in flight; bumps generation

    resolvePostRefresh({
      token: 'tok2',
      refresh_token: 'rt2',
      expires_at: expiresAt + 300,
      user: user(1),
    })
    await pending

    const state = useStore.getState()
    expect(state.token).toBeNull()
    expect(state.authStatus).toBe('anonymous')
  })
})

describe('sessionGeneration', () => {
  it('bumps on every session transition', () => {
    const start = sessionGeneration()
    logout()
    expect(sessionGeneration()).toBe(start + 1)
    expireSession()
    expect(sessionGeneration()).toBe(start + 2)
  })
})

describe('restoreSession', () => {
  it('sets anonymous without calling the API when there is no token', async () => {
    useStore.setState({ token: null, authStatus: 'unknown' })
    await restoreSession()
    expect(useStore.getState().authStatus).toBe('anonymous')
    expect(getMe).not.toHaveBeenCalled()
  })

  it('calls expireSession() and sets anonymous when the server rejects the token (401)', async () => {
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    vi.mocked(getMe).mockRejectedValue(new HttpError(401, 'Not authenticated'))
    await restoreSession()
    expect(useStore.getState().authStatus).toBe('anonymous')
    expect(useStore.getState().sessionExpired).toBe(true)
    expect(invalidateDocumentWork).toHaveBeenCalled()
  })

  it('keeps the token and sets restoreFailed on a 500 or network error, leaving authStatus unknown', async () => {
    useStore.setState({ token: 'tok', authStatus: 'unknown', restoreFailed: false })
    vi.mocked(getMe).mockRejectedValue(new TypeError('offline'))
    await restoreSession()
    const state = useStore.getState()
    expect(state.token).toBe('tok')
    expect(state.authStatus).toBe('unknown')
    expect(state.restoreFailed).toBe(true)
  })

  it('a later successful restore clears restoreFailed', async () => {
    useStore.setState({ token: 'tok', authStatus: 'unknown', restoreFailed: true })
    vi.mocked(getMe).mockResolvedValue(user(1))
    await restoreSession()
    expect(useStore.getState().restoreFailed).toBe(false)
    expect(useStore.getState().authStatus).toBe('authenticated')
  })

  it('two concurrent calls issue exactly one /api/auth/me request and both resolve', async () => {
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    let resolveMe!: (u: MeResponse) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMe = resolve
        }),
    )
    const p1 = restoreSession()
    const p2 = restoreSession()
    resolveMe(user(1))
    await Promise.all([p1, p2])
    expect(getMe).toHaveBeenCalledTimes(1)
    expect(useStore.getState().authStatus).toBe('authenticated')
  })

  it('does not commit setAuth when logout() runs while getMe() is in flight', async () => {
    useStore.setState({ token: 'tok', user: null, authStatus: 'unknown' })
    let resolveMe!: (u: MeResponse) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMe = resolve
        }),
    )
    const pending = restoreSession()
    logout() // fires while getMe() is still in flight

    resolveMe(user(1))
    await pending

    const state = useStore.getState()
    expect(state.token).toBeNull()
    expect(state.user).toBeNull()
    expect(state.authStatus).toBe('anonymous')
  })

  it('refreshes a stale-expiry token before calling getMe(), and commits the rotated token', async () => {
    const callOrder: string[] = []
    const expiresAt = Math.floor(Date.now() / 1000) + 60 // inside the 120s margin
    useStore.setState({
      token: 'old-tok',
      refreshToken: 'rt',
      tokenExpiresAt: expiresAt,
      authStatus: 'unknown',
    })
    vi.mocked(postRefresh).mockImplementation(async (refreshToken) => {
      callOrder.push('refresh')
      expect(refreshToken).toBe('rt')
      return { token: 'new-tok', refresh_token: 'rt2', expires_at: expiresAt + 300, user: user(1) }
    })
    vi.mocked(getMe).mockImplementation(async () => {
      callOrder.push('getMe')
      return user(1)
    })

    await restoreSession()

    expect(callOrder).toEqual(['refresh', 'getMe'])
    const state = useStore.getState()
    expect(state.token).toBe('new-tok')
    expect(state.refreshToken).toBe('rt2')
    expect(state.authStatus).toBe('authenticated')
  })
})

describe('refreshUser', () => {
  it('returns without calling the API when there is no token', async () => {
    useStore.setState({ token: null, user: null })
    await refreshUser()
    expect(getMe).not.toHaveBeenCalled()
  })

  it('commits the fresh user under the same token on a clean round trip', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    vi.mocked(getMe).mockResolvedValue(
      user(1, { usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 1 }] } }),
    )
    await refreshUser()
    const state = useStore.getState()
    expect(state.token).toBe('tok')
    expect(state.user).toEqual(
      user(1, { usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 1 }] } }),
    )
  })

  it('drops the response when logout() runs while getMe() is in flight', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    let resolveMe!: (u: MeResponse) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMe = resolve
        }),
    )
    const pending = refreshUser()
    logout() // fires while getMe() is still in flight; bumps generation

    resolveMe(user(2))
    await pending

    const state = useStore.getState()
    expect(state.token).toBeNull()
    expect(state.user).toBeNull()
  })

  it("drops the response when the store's token has moved on mid-flight", async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    let resolveMe!: (u: MeResponse) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMe = resolve
        }),
    )
    const pending = refreshUser()
    // A token change with no generation bump: refreshUser()'s own
    // token-equality guard is what has to catch this, not the generation
    // check restoreSession()/login() rely on.
    useStore.setState({ token: 'other-tok' })

    resolveMe(user(2))
    await pending

    const state = useStore.getState()
    expect(state.token).toBe('other-tok')
    expect(state.user).toEqual(user(1))
  })

  it('leaves auth state untouched when getMe() rejects', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    vi.mocked(getMe).mockRejectedValue(new HttpError(500, 'boom'))
    await expect(refreshUser()).resolves.toBeUndefined()
    const state = useStore.getState()
    expect(state.token).toBe('tok')
    expect(state.user).toEqual(user(1))
    expect(state.authStatus).toBe('authenticated')
  })

  it('keeps the newer of two overlapping refreshes even when the older one resolves last', async () => {
    // Two LLM completions can each trigger their own refreshUser() call; both
    // pass the generation/token guards untouched, so without the seq counter
    // the older response landing last would regress the usage windows back down.
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    let resolveFirst!: (u: MeResponse) => void
    let resolveSecond!: (u: MeResponse) => void
    vi.mocked(getMe)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )

    const first = refreshUser()
    const second = refreshUser()

    // The second (newer) refresh resolves first, with the higher used_percent.
    resolveSecond(
      user(1, { usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 4 }] } }),
    )
    await second
    // The first (older) refresh resolves last, with stale, lower data.
    resolveFirst(
      user(1, { usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 1 }] } }),
    )
    await first

    expect(useStore.getState().user).toEqual(
      user(1, { usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 4 }] } }),
    )
  })
})

describe('per-user preference survival (B1, #34)', () => {
  it("restores the incoming user's stored preferences on login (load runs before setAuth)", async () => {
    writePrefs(2, { ...PREFS_DEFAULTS, uiLocale: 'fr', currentDocId: 9 })
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(2) })
    await login('b@example.com', 'pw')
    expect(useStore.getState().uiLocale).toBe('fr')
    expect(useStore.getState().currentDocId).toBe(9)
  })

  it("restoreSession loads the restored user's preferences", async () => {
    writePrefs(1, { ...PREFS_DEFAULTS, uiLocale: 'fr' })
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    vi.mocked(getMe).mockResolvedValue(user(1))
    await restoreSession()
    expect(useStore.getState().uiLocale).toBe('fr')
  })

  it("keeps the departing user's blob values across logout and restores them on re-login", async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    useStore.getState().setUiLocale('de')   // subscriber writes user 1's blob
    logout()
    // The blob still holds the pre-logout values — a reset that ran while
    // the user was still visible would have overwritten it with defaults.
    expect(readPrefs(1)?.uiLocale).toBe('de')
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok2', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    expect(useStore.getState().uiLocale).toBe('de')
  })

  it('preferences survive session expiry', async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    useStore.getState().setUiLocale('de')
    expireSession()
    expect(readPrefs(1)?.uiLocale).toBe('de')
  })

  it("A→B→A: A's preferences survive B's session and B never sees A's values", async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tokA', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    useStore.getState().setUiLocale('de')
    useStore.getState().toggleDocSidebar()   // docSidebarCollapsed: true
    logout()

    vi.mocked(postLogin).mockResolvedValue({ token: 'tokB', refresh_token: null, expires_at: null, user: user(2) })
    await login('b@example.com', 'pw')
    // The #34 leak, end to end: B has no blob and must see pure defaults.
    expect(useStore.getState().uiLocale).toBeNull()
    expect(useStore.getState().docSidebarCollapsed).toBe(false)
    useStore.getState().setUiLocale('es')
    logout()

    vi.mocked(postLogin).mockResolvedValue({ token: 'tokA2', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    const state = useStore.getState()
    expect(state.uiLocale).toBe('de')
    expect(state.docSidebarCollapsed).toBe(true)
    // B's own choices ended up in B's namespace, not A's.
    expect(readPrefs(2)?.uiLocale).toBe('es')
  })

  it("the incoming user's preferences are already loaded when the user becomes visible", async () => {
    // Pins the load-before-setAuth direction of the ordering invariant
    // directly: it is defense-in-depth (no in-process code path observes
    // the gap today), so no behavioral test can catch a reordering — this
    // subscriber can. If user becomes visible while prefs still hold
    // defaults, the invariant is broken even though login()'s end state
    // looks correct.
    writePrefs(2, { ...PREFS_DEFAULTS, uiLocale: 'fr', currentDocId: 9 })
    const seenAtUserVisible: (string | null)[] = []
    const unsub = useStore.subscribe((state, prev) => {
      if (state.user && !prev.user) seenAtUserVisible.push(state.uiLocale)
    })
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(2) })
    await login('b@example.com', 'pw')
    unsub()
    expect(seenAtUserVisible).toEqual(['fr'])
  })

  it('same-user silent re-login neither resets nor re-reads the blob', async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    useStore.getState().setUiLocale('de')
    // Stale blob on purpose: if the re-login re-read storage, uiLocale
    // would flip to 'it'; if it reset, uiLocale would flip to null.
    writePrefs(1, { ...PREFS_DEFAULTS, uiLocale: 'it' })
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok2', refresh_token: null, expires_at: null, user: user(1) })
    await login('a@example.com', 'pw')
    expect(useStore.getState().uiLocale).toBe('de')
  })

  it('restoreSession authenticates from the token key and retains it', async () => {
    // Seed the KEY (not just the store field) and initialise state from
    // readToken(), mirroring the real boot path — the boot-time read itself
    // (token: readToken() at store creation) is covered in
    // prefsPersistence.test.ts via a fresh module import. Asserting the key
    // still holds the token afterwards pins that a successful restore
    // neither rewrites nor accidentally clears it.
    localStorage.setItem('fabulous-writing-token', 'tok')
    useStore.setState({ token: readToken(), authStatus: 'unknown' })
    vi.mocked(getMe).mockResolvedValue(user(1))
    await restoreSession()
    expect(useStore.getState().authStatus).toBe('authenticated')
    expect(readToken()).toBe('tok')
  })
})
