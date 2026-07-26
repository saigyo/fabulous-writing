// @vitest-environment happy-dom
// happy-dom (not the default "node" environment) so useStore.persist and
// localStorage-backed document buffer both work — matching session.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expireSession } from '../auth/session'
import { clearSnapshot, readSnapshot, writeSnapshot } from '../documents/buffer'
import { useStore } from '../state/store'
import {
  HttpError,
  type MeResponse,
  postLogin,
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

  it('a 401 from POST /api/auth/password clears auth state (not exempt)', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {}))

    await expect(
      request('/api/auth/password', { method: 'POST' }),
    ).rejects.toBeInstanceOf(HttpError)

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
