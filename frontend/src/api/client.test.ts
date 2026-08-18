// @vitest-environment happy-dom
// Store needs real localStorage at import time to read the session token key
// via prefsStorage.ts's readToken() at store creation.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expireSession } from '../auth/session'
import { clearSnapshot, readSnapshot, writeSnapshot } from '../documents/buffer'
import { useStore } from '../state/store'
import {
  ADMIN_MIN_PASSWORD_LENGTH,
  HttpError,
  type MeResponse,
  getAdminTiers,
  getAdminUsers,
  patchAdminUser,
  postAdminUser,
  postLogin,
  postPasswordChange,
  postRefresh,
  request,
  setUnauthorizedHandler,
} from './client'

function user(id: number): MeResponse {
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
    db_backend: 'sqlite',
  }
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  clearSnapshot()
  useStore.setState({
    token: null,
    user: null,
    authStatus: 'unknown',
    sessionExpired: false,
    restoreFailed: false,
  })
  // session.ts registers expireSession as the real handler at module load;
  // re-assert it here in case an earlier test in this file swapped in a spy.
  setUnauthorizedHandler(expireSession)
})

describe('request() headers', () => {
  it('sends Authorization and Content-Type when a token is present', async () => {
    useStore.setState({ token: 'tok-abc' })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { ok: true }))

    await request('/api/whatever')

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-abc',
    })
  })

  it('sends no Authorization header when there is no token', async () => {
    useStore.setState({ token: null })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {}))

    await request('/api/whatever')

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('merges caller-supplied headers instead of replacing Content-Type', async () => {
    useStore.setState({ token: 'tok-abc' })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {}))

    await request('/api/whatever', { headers: { 'X-Custom': '1' } })

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-abc',
      'X-Custom': '1',
    })
  })
})

describe('HttpError.code', () => {
  it('parses a string code from an object detail on a non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(422, { detail: { code: 'wrong_current_password', message: 'x' } }),
    )

    const error = await request('/api/auth/password', { method: 'POST' }).catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(422)
    expect((error as HttpError).code).toBe('wrong_current_password')
  })

  it('leaves code undefined when the error body is not JSON, without losing the status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', { status: 500 }),
    )

    const error = await request('/api/documents').catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(500)
    expect((error as HttpError).code).toBeUndefined()
  })
})

describe('401 handling', () => {
  it('routes a 401 from a normal endpoint through expireSession(), preserving the document buffer', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    writeSnapshot({
      docId: 1,
      revision: 1,
      dirty: true,
      name: 'Doc',
      text: 'unsaved text',
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
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {}))

    await expect(request('/api/documents')).rejects.toBeInstanceOf(HttpError)

    const state = useStore.getState()
    expect(state.authStatus).toBe('anonymous')
    expect(state.sessionExpired).toBe(true)
    expect(readSnapshot()).not.toBeNull() // the buffer survives
  })

  it('a 401 from postLogin does not clear auth state and the HttpError reaches the caller', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, {}))

    await expect(postLogin('a@example.com', 'wrong')).rejects.toBeInstanceOf(HttpError)

    const state = useStore.getState()
    expect(state.authStatus).toBe('authenticated')
    expect(state.sessionExpired).toBe(false)
    // keepSessionOn401 must have exactly one effect (skipping the
    // clear-auth branch) and never touch header construction — a call that
    // happens to carry a token (as this one does, mid-session) must still
    // send it, even though this endpoint is exempt from the 401 handling.
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('a 401 from postPasswordChange clears auth state (not exempt)', async () => {
    // Re-seated on the real function (Task 8) rather than calling request()
    // against the path directly: postPasswordChange didn't exist when this
    // test was first written (Task 4), so it exercised the seam through the
    // bare path string. The real function is the better seam now — it pins
    // the actual call site's behavior, not just a stand-in URL.
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {}))

    await expect(postPasswordChange('wrong', 'new-password')).rejects.toBeInstanceOf(HttpError)

    expect(useStore.getState().authStatus).toBe('anonymous')
  })

  it('does not clear auth state on a 429 (transient — spec §8)', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(429, {}))

    await expect(request('/api/documents')).rejects.toBeInstanceOf(HttpError)

    expect(useStore.getState().authStatus).toBe('authenticated')
  })

  it('does not clear auth state on a 500', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(500, {}))

    await expect(request('/api/documents')).rejects.toBeInstanceOf(HttpError)

    expect(useStore.getState().authStatus).toBe('authenticated')
  })

  it('a delayed 401 carrying a token that is no longer current does not clear the fresh session', async () => {
    useStore.setState({ token: 'old-token', user: user(1), authStatus: 'authenticated' })

    let resolveFetch!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )

    // Request goes out carrying 'old-token'.
    const pending = request('/api/documents')

    // The session expires and the user logs back in with a new token while
    // that request is still in flight.
    expireSession()
    useStore.setState({
      token: 'new-token',
      user: user(1),
      authStatus: 'authenticated',
      sessionExpired: false,
    })

    // The stale request's 401 lands now, long after 'old-token' died.
    resolveFetch(jsonResponse(401, {}))
    await expect(pending).rejects.toBeInstanceOf(HttpError)

    const state = useStore.getState()
    expect(state.token).toBe('new-token')
    expect(state.authStatus).toBe('authenticated')
    expect(state.sessionExpired).toBe(false)
  })

  it('a 401 with no token in flight does not expire a session that never existed', async () => {
    // A visitor who never signed in: no token was ever sent, and the store
    // has none either. A mount-time request (providers, languages, ...)
    // 401ing here must not raise the "your session has ended" notice for
    // someone who was never signed in to begin with.
    useStore.setState({ token: null, user: null, authStatus: 'anonymous' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {}))

    await expect(request('/api/providers')).rejects.toBeInstanceOf(HttpError)

    const state = useStore.getState()
    expect(state.authStatus).toBe('anonymous')
    expect(state.sessionExpired).toBe(false)
  })
})

describe('admin endpoints', () => {
  it('getAdminUsers GETs /api/admin/users with the bearer header', async () => {
    useStore.setState({ token: 'tok-admin' })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, []))

    await getAdminUsers()

    const url = fetchMock.mock.calls[0][0] as string
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; method?: string }
    expect(url).toContain('/api/admin/users')
    expect(init.method).toBeUndefined() // GET is default
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok-admin',
    })
  })

  it('postAdminUser POSTs the create payload', async () => {
    useStore.setState({ token: 'tok-admin' })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { id: 1, email: 'a@b.c', display_name: null, tier: 'basic', is_admin: false, is_active: true, created_at: '2026-07-28T00:00:00Z', external_id: null, password_changed_at: null }))

    const payload = { email: 'a@b.c', password: 'p'.repeat(12), tier: 'basic', is_admin: false }
    await postAdminUser(payload)

    const init = fetchMock.mock.calls[0][1] as { method: string; body: string }
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(payload)
  })

  it('patchAdminUser PATCHes the given fields only', async () => {
    useStore.setState({ token: 'tok-admin' })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { id: 7, email: 'user@example.com', display_name: null, tier: 'premium', is_admin: false, is_active: true, created_at: '2026-07-28T00:00:00Z', external_id: null, password_changed_at: null }))

    await patchAdminUser(7, { tier: 'premium' })

    const url = fetchMock.mock.calls[0][0] as string
    const init = fetchMock.mock.calls[0][1] as { method: string; body: string }
    expect(url).toContain('/api/admin/users/7')
    expect(init.method).toBe('PATCH')
    expect(init.body).toBe('{"tier":"premium"}')
  })

  it('getAdminTiers GETs /api/admin/tiers with the bearer header', async () => {
    useStore.setState({ token: 'tok-admin' })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, ['basic', 'premium', 'enterprise']))

    await getAdminTiers()

    const url = fetchMock.mock.calls[0][0] as string
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; method?: string }
    expect(url).toContain('/api/admin/tiers')
    expect(init.method).toBeUndefined() // GET is default
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok-admin',
    })
  })

  it('admin password floor mirrors the backend', () => {
    expect(ADMIN_MIN_PASSWORD_LENGTH).toBe(12)
  })
})

describe('postRefresh timeout wiring', () => {
  // A refresh request that never settles pins session.ts's refreshInFlight
  // for the current generation forever (auth/session.ts doRefresh's catch
  // only runs on rejection). This test pins down the wiring that prevents
  // that: an AbortSignal, freshly minted per call, must reach fetch(). The
  // 15s countdown itself is not asserted here -- AbortSignal.timeout is not
  // driven by this repo's fake-timer setup (verified separately), so the
  // strongest assertion available is that the signal is present and not
  // already aborted, i.e. it really is fetch's own abort control, not some
  // unrelated already-fired signal.
  it('passes a fresh, not-yet-aborted signal through to fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { token: 't', refresh_token: 'r', expires_at: null, user: user(1) }),
    )

    await postRefresh('rt')

    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal }
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })
})

// Compile-time regression check, not a runtime test: keepSessionOn401 must
// stay unreachable through the exported request() — only requestWithOptions
// (internal to client.ts, postLogin's sole caller) accepts it. The function
// below is never called (a real invocation would hit an unmocked fetch);
// its only job is to fail `tsc -b` two ways — as a real type error if
// RequestOptions is ever widened to include this flag (the suppression
// directive just below stops matching anything and TypeScript reports it
// as unused), and right now via that same directive, confirming the
// property genuinely isn't there.
function _keepSessionOn401IsNotPublic(): void {
  // @ts-expect-error keepSessionOn401 only exists on client.ts's internal
  // RequestOptionsInternal, not on the RequestOptions request() accepts.
  void request('/api/whatever', { keepSessionOn401: true })
}
void _keepSessionOn401IsNotPublic
