// @vitest-environment happy-dom
// happy-dom so useStore.persist works, matching client.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expireSession } from '../auth/session'
import { clearSnapshot } from '../documents/buffer'
import { useStore } from '../state/store'
import type { CheckEventHandlers } from './client'
import { setUnauthorizedHandler, subscribeCheck } from './client'

// tsconfig.app.json (which tsc -b type-checks this file under) declares
// only `"types": ["vite/client"]`, not "node" — pulling in @types/node
// globally to type this one Node runtime global (present at test-run time
// regardless) is a bigger footprint than this file needs, so it is typed
// locally instead.
declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void
}

function user(id: number) {
  return {
    id,
    email: `user${id}@example.com`,
    display_name: null,
    tier: 'basic',
    is_admin: false,
  }
}

/** A ReadableStream<Uint8Array> whose chunks the test pushes on demand, so
 * framing can be split across chunk boundaries under test control. */
function controllableStream(): {
  stream: ReadableStream<Uint8Array>
  push: (chunk: Uint8Array) => void
  close: () => void
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    // Once the consumer calls reader.cancel() (our done-handling does, on
    // the `done` event), the controller is already closed from the
    // consumer's side — exactly like a real connection that has been torn
    // down. Further pushes/closes from the "server" side are then no-ops,
    // not test bugs, so swallow the resulting error rather than let it fail
    // the test.
    push: (chunk) => {
      try {
        controller.enqueue(chunk)
      } catch {
        // stream already cancelled/closed
      }
    },
    close: () => {
      try {
        controller.close()
      } catch {
        // stream already cancelled/closed
      }
    },
  }
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function streamResponse(stream: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(stream, { status })
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function handlers() {
  return {
    onResult: vi.fn<CheckEventHandlers['onResult']>(),
    onError: vi.fn<CheckEventHandlers['onError']>(),
    onDone: vi.fn<CheckEventHandlers['onDone']>(),
    onProgress: vi.fn<NonNullable<CheckEventHandlers['onProgress']>>(),
    onScorecard: vi.fn<NonNullable<CheckEventHandlers['onScorecard']>>(),
  } satisfies CheckEventHandlers
}

/** Runs `run`, collecting any `unhandledRejection` the process observes
 * while it does. Both `reader.cancel()` (on a `done` frame racing an
 * already-errored stream) and `readEvents()` itself (if a handler throws
 * from inside settle()) are fire-and-forget promises with no caller
 * awaiting them directly — a missing `.catch()` on either would surface
 * here, not as a normal test assertion failure. */
async function collectUnhandledRejections(run: () => void | Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = []
  const onUnhandled = (reason: unknown) => rejections.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await run()
    // Unhandled rejections surface after the current microtask queue
    // drains; a macrotask tick gives Node's own detection time to fire.
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return rejections
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
  setUnauthorizedHandler(expireSession)
})

describe('subscribeCheck', () => {
  it('dispatches each of the five events to the right handler with parsed data', async () => {
    const { stream, push, close } = controllableStream()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    subscribeCheck('check-1', h)

    push(sseFrame('checker_result', { checker: 'llm', findings: [{ id: 'f1' }] }))
    push(sseFrame('llm_progress', { tokens: 42 }))
    push(sseFrame('scorecard', { overall: 90 }))
    push(sseFrame('checker_error', { checker: 'rules', error: 'boom' }))
    push(sseFrame('done', {}))
    close()

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))

    expect(h.onResult).toHaveBeenCalledWith('llm', [{ id: 'f1' }])
    expect(h.onProgress).toHaveBeenCalledWith(42)
    expect(h.onScorecard).toHaveBeenCalledWith({ overall: 90 })
    expect(h.onError).toHaveBeenCalledWith('rules', 'boom')
  })

  it('assembles a frame split across two chunks mid-frame', async () => {
    const { stream, push, close } = controllableStream()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    subscribeCheck('check-1', h)

    const full = sseFrame('checker_result', { checker: 'llm', findings: ['x'] })
    const cut = 10 // arbitrary byte offset, well inside the frame
    push(full.slice(0, cut))
    push(full.slice(cut))
    push(sseFrame('done', {}))
    close()

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))
    expect(h.onResult).toHaveBeenCalledWith('llm', ['x'])
  })

  it('survives a multi-byte character split across a chunk boundary', async () => {
    const { stream, push, close } = controllableStream()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    subscribeCheck('check-1', h)

    const message = '„Größe" 日本語'
    const full = sseFrame('checker_error', { checker: 'llm', error: message })
    // Find a byte that is a UTF-8 continuation byte (10xxxxxx) so the split
    // lands mid-character rather than on a character boundary.
    let splitAt = -1
    for (let i = 1; i < full.length; i++) {
      if ((full[i] & 0xc0) === 0x80) {
        splitAt = i
        break
      }
    }
    expect(splitAt).toBeGreaterThan(0) // sanity: the fixture does contain a multi-byte char

    push(full.slice(0, splitAt))
    push(full.slice(splitAt))
    push(sseFrame('done', {}))
    close()

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))
    expect(h.onError).toHaveBeenCalledWith('llm', message)
  })

  it('calls onDone() exactly once on done and stops reading further events', async () => {
    const { stream, push, close } = controllableStream()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    subscribeCheck('check-1', h)

    push(sseFrame('done', {}))
    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))

    // Anything pushed after `done` must not be dispatched — the reader has
    // stopped.
    push(sseFrame('checker_result', { checker: 'llm', findings: ['late'] }))
    close()

    expect(h.onResult).not.toHaveBeenCalled()
    expect(h.onDone).toHaveBeenCalledTimes(1)
  })

  it('a result frame framed after done in the same chunk is not dispatched', async () => {
    // Mirrors the unsubscribe-mid-chunk test above, but for the `done`
    // frame's own guard: a `done` frame sets `settled` but does not abort
    // `signal`, and parser.feed() dispatches every event framed in one
    // chunk synchronously — so a frame that follows `done` within that same
    // chunk must not still reach its handler.
    const { stream, push, close } = controllableStream()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    subscribeCheck('check-1', h)

    const chunk = new Uint8Array([
      ...sseFrame('checker_result', { checker: 'llm', findings: ['first'] }),
      ...sseFrame('done', {}),
      ...sseFrame('checker_result', { checker: 'llm', findings: ['late'] }),
    ])
    push(chunk)
    close()

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))

    expect(h.onResult).toHaveBeenCalledTimes(1)
    expect(h.onResult).toHaveBeenCalledWith('llm', ['first'])
  })

  it('a stream that ends without done calls onDone() once (network-error path)', async () => {
    const { stream, push, close } = controllableStream()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    subscribeCheck('check-1', h)

    push(sseFrame('checker_result', { checker: 'llm', findings: ['x'] }))
    close() // ends with no `done` frame

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))
    expect(h.onDone).toHaveBeenCalledTimes(1)
  })

  it('does not call onDone() a second time when the stream ends after done already arrived', async () => {
    const { stream, push, close } = controllableStream()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    subscribeCheck('check-1', h)

    push(sseFrame('done', {}))
    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))

    close()
    await Promise.resolve()
    await Promise.resolve()

    expect(h.onDone).toHaveBeenCalledTimes(1)
  })

  it('a network error (rejected fetch) calls onDone() once, like completion', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'))
    const h = handlers()

    subscribeCheck('check-1', h)

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))
    expect(h.onDone).toHaveBeenCalledTimes(1)
  })

  it('the unsubscribe function aborts the fetch, and calling it twice does not throw', async () => {
    let capturedSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal ?? undefined
      return new Promise(() => {
        /* never resolves */
      })
    })
    const h = handlers()

    const unsubscribe = subscribeCheck('check-1', h)
    await Promise.resolve()

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal?.aborted).toBe(false)

    expect(() => {
      unsubscribe()
      unsubscribe()
    }).not.toThrow()

    expect(capturedSignal?.aborted).toBe(true)
  })

  it('stops dispatching further events from the same chunk once a handler calls unsubscribe', async () => {
    // parser.feed() dispatches every event framed in one chunk
    // synchronously. If a handler calls the unsubscribe function mid-chunk
    // (aborting the signal), later events already buffered in that same
    // chunk must not still reach a handler the caller just tore down —
    // unlike EventSource.close(), which stopped dispatch immediately.
    const { stream, push, close } = controllableStream()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()
    let unsubscribe!: () => void
    h.onResult.mockImplementation(() => {
      unsubscribe()
    })

    unsubscribe = subscribeCheck('check-1', h)

    const chunk = new Uint8Array([
      ...sseFrame('checker_result', { checker: 'llm', findings: ['first'] }),
      ...sseFrame('checker_result', { checker: 'llm', findings: ['second'] }),
    ])
    push(chunk)
    close()

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(h.onResult).toHaveBeenCalledTimes(1)
    expect(h.onResult).toHaveBeenCalledWith('llm', ['first'])
  })

  it('aborting before the response arrives does not call onDone()', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    const h = handlers()

    const unsubscribe = subscribeCheck('check-1', h)
    unsubscribe()

    // Give the rejected promise a few microtask turns to settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(h.onDone).not.toHaveBeenCalled()
  })

  it('a 401 response calls expireSession() and onDone() exactly once', async () => {
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {}))
    const h = handlers()

    subscribeCheck('check-1', h)

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))

    const state = useStore.getState()
    expect(state.authStatus).toBe('anonymous')
    expect(state.sessionExpired).toBe(true)
    expect(h.onDone).toHaveBeenCalledTimes(1)
  })

  it('a 500 response does not clear auth state — only 401 reaches handleUnauthorized()', async () => {
    // Pins the narrowing at the non-OK branch: without `response.status ===
    // 401`, any non-OK response (a backend 500, a 404) would call
    // handleUnauthorized() and silently log the user out mid-check.
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(500, {}))
    const h = handlers()

    subscribeCheck('check-1', h)

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))

    const state = useStore.getState()
    expect(state.authStatus).toBe('authenticated')
    expect(state.sessionExpired).toBe(false)
    expect(h.onDone).toHaveBeenCalledTimes(1)
  })

  it('a 401 on a stream opened with a token that is no longer current calls onDone() but not expireSession()', async () => {
    useStore.setState({ token: 'old-token', user: user(1), authStatus: 'authenticated' })

    let resolveFetch!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )
    const h = handlers()

    // Stream opened while 'old-token' is current.
    subscribeCheck('check-1', h)

    // Session expires and the user signs back in with a new token while the
    // stream's request is still in flight.
    expireSession()
    useStore.setState({
      token: 'new-token',
      user: user(1),
      authStatus: 'authenticated',
      sessionExpired: false,
    })

    // The stale stream's 401 lands now, long after 'old-token' died.
    resolveFetch(jsonResponse(401, {}))

    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))

    const state = useStore.getState()
    expect(state.token).toBe('new-token')
    expect(state.authStatus).toBe('authenticated')
    expect(state.sessionExpired).toBe(false)
  })

  it('sends the Authorization header carrying the current token', async () => {
    useStore.setState({ token: 'tok-abc' })
    const { stream, close } = controllableStream()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    subscribeCheck('check-1', h)
    close()
    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer tok-abc')
  })

  it('does not produce an unhandled rejection when reader.cancel() rejects on a done frame', async () => {
    // Simulates a `done` frame racing an already-errored connection:
    // cancel() rejecting here must not escape as an unhandled rejection.
    let cancelCalled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame('done', {}))
      },
      cancel() {
        cancelCalled = true
        return Promise.reject(new Error('stream already errored'))
      },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(stream))
    const h = handlers()

    const rejections = await collectUnhandledRejections(async () => {
      subscribeCheck('check-1', h)
      await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))
    })

    expect(cancelCalled).toBe(true)
    expect(rejections).toHaveLength(0)
  })

  it('does not produce an unhandled rejection when handlers.onDone() throws from the network-error path', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'))
    const h = handlers()
    h.onDone.mockImplementation(() => {
      throw new Error('boom from onDone')
    })

    const rejections = await collectUnhandledRejections(async () => {
      subscribeCheck('check-1', h)
      await vi.waitFor(() => expect(h.onDone).toHaveBeenCalledTimes(1))
    })

    expect(rejections).toHaveLength(0)
  })
})
