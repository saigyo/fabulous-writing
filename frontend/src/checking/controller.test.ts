// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postCheck: vi.fn(),
  subscribeCheck: vi.fn(),
}))
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => ({
    state: { doc: { toString: () => docText, length: docText.length } },
    dispatch: (tx: unknown) => dispatched.push(tx),
  }),
}))
vi.mock('./routing', () => ({
  resolveModel: vi.fn(() => ({ ok: true, provider: 'fake', model: 'fake-model' })),
}))
vi.mock('../documents/autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../documents/autosave')>()),
  flush: vi.fn().mockResolvedValue(undefined),
}))

import { HttpError, postCheck, subscribeCheck } from '../api/client'
import { bumpGeneration, resetAutosaveForTests } from '../documents/autosave'
import { en as messages } from '../i18n/en'
import { cancelInFlightCheck } from './cancelSlot'
import { cancelCheck, runCheck } from './controller'
import { resolveModel } from './routing'

function user(policy: MeResponse['policy']): MeResponse {
  return {
    id: 1,
    email: 'u@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy,
    usage: { used_today: 0, limit: 500 },
    limits: {
      max_document_chars: 200000,
      max_llm_document_chars: 200000,
      concurrent_llm_runs: 5,
    },
    allow_additional_admins: false,
  }
}

const FLOOR: MeResponse['policy'] = {
  llm: { tiers: [], providers: [], models: null },
  features: [],
}

const RESTRICTED: MeResponse['policy'] = {
  llm: { tiers: ['cheap', 'local'], providers: ['ollama'], models: null },
  features: [],
}

let docText = 'Some text with issues.'
let dispatched: unknown[] = []

type SseCallbacks = Parameters<typeof subscribeCheck>[1]

function lastCallbacks(): SseCallbacks {
  const calls = vi.mocked(subscribeCheck).mock.calls
  return calls[calls.length - 1][1]
}

const scorecard = {
  consistency: { score: 80, note: '' },
  flow: { score: 80, note: '' },
  clarity: { score: 80, note: '' },
  vividness: { score: 80, note: '' },
  tone: { score: 80, note: '' },
  structure: { score: 80, note: '' },
}

beforeEach(() => {
  vi.clearAllMocks()
  cancelCheck()
  resetAutosaveForTests()
  docText = 'Some text with issues.'
  dispatched = []
  useStore.setState({
    scorecard: null,
    scorecardStale: false,
    llmError: null,
    llmEffective: null,
    tier: 'balanced',
    user: null,
  })
  vi.mocked(resolveModel).mockReturnValue({
    ok: true,
    provider: 'fake',
    model: 'fake-model',
  })
  vi.mocked(postCheck).mockResolvedValue({
    check_id: 'c1',
    status: 'running',
    findings: [],
  } as never)
  vi.mocked(subscribeCheck).mockReturnValue(() => {})
})

describe('check controller', () => {
  it('applies a late scorecard to the same document', async () => {
    await runCheck(true)
    lastCallbacks().onScorecard!(scorecard as never)
    expect(useStore.getState().scorecard).toEqual(scorecard)
    expect(useStore.getState().scorecardStale).toBe(false)
  })

  it('marks the scorecard stale when the text moved on', async () => {
    await runCheck(true)
    docText = 'Some text with issues. And more.'
    lastCallbacks().onScorecard!(scorecard as never)
    expect(useStore.getState().scorecard).toEqual(scorecard)
    expect(useStore.getState().scorecardStale).toBe(true)
  })

  it('cancelCheck() unsubscribes and blocks all late SSE writes', async () => {
    const unsub = vi.fn()
    vi.mocked(subscribeCheck).mockReturnValue(unsub)
    await runCheck(true)
    const callbacks = lastCallbacks()
    cancelCheck()
    expect(unsub).toHaveBeenCalled()
    callbacks.onScorecard!(scorecard as never)
    callbacks.onProgress!(42)
    callbacks.onError('llm', 'boom')
    expect(useStore.getState().scorecard).toBeNull()
    expect(useStore.getState().llmTokens).toBeNull()
    expect(useStore.getState().llmError).toBeNull()
    expect(useStore.getState().checkPhase).toBe('idle')
  })

  it('a newer check supersedes the older one\'s late findings', async () => {
    await runCheck(true)
    const first = lastCallbacks()
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c2',
      status: 'running',
      findings: [],
    } as never)
    await runCheck(true)
    dispatched = []
    first.onResult('llm', [])
    expect(dispatched).toHaveLength(0) // stale check's findings never dispatched
  })

  it('discards findings when the text changed since the check', async () => {
    await runCheck(true)
    dispatched = []
    docText = 'edited meanwhile'
    lastCallbacks().onResult('llm', [])
    expect(dispatched).toHaveLength(0)
  })

  it('drops a check whose postCheck resolves after the session already ended', async () => {
    // Reproduces the real sequence: postCheck held pending, the literal
    // session-end call (cancelInFlightCheck()) fires while it is still
    // awaiting, then postCheck resolves. cancelInFlightCheck() only cancels
    // a *subscribed* check, so before the fix runCheck() would re-arm
    // currentCheckId and open a fresh subscription anyway.
    let resolvePostCheck!: (value: Awaited<ReturnType<typeof postCheck>>) => void
    vi.mocked(postCheck).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePostCheck = resolve
        }),
    )
    const unsub = vi.fn()
    vi.mocked(subscribeCheck).mockReturnValue(unsub)

    const runPromise = runCheck(true)

    // The literal call logout()/expireSession() make on session end.
    cancelInFlightCheck()
    // The literal generation bump invalidateDocumentWork() makes on session
    // end (documents.ts calls this alongside cancelInFlightCheck()).
    bumpGeneration()

    resolvePostCheck({ check_id: 'c-a', status: 'running', findings: [] } as never)
    await runPromise

    expect(subscribeCheck).not.toHaveBeenCalled()
    expect(useStore.getState().scorecard).toBeNull()
  })

  it('drops a check whose postCheck resolves after a same-session document switch', async () => {
    // The same-session twin of the test above: no logout, no generation
    // bump. hydrateFromDocument() calls cancelCheck() on every document
    // switch — reproduced literally here — while postCheck() for document
    // A is still pending. Before the fix, cancelCheck() only closed a
    // *subscription* that did not exist yet, so runCheck() would re-arm
    // currentCheckId and open a fresh one once postCheck() resolved,
    // applying document A's findings/scorecard onto document B and
    // autosaving them (void flush()).
    let resolvePostCheck!: (value: Awaited<ReturnType<typeof postCheck>>) => void
    vi.mocked(postCheck).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePostCheck = resolve
        }),
    )
    const unsub = vi.fn()
    vi.mocked(subscribeCheck).mockReturnValue(unsub)

    const runPromise = runCheck(true) // document A's check starts

    // The literal call hydrateFromDocument() makes before loading document
    // B: cancel whatever check belongs to the outgoing document. Same
    // session throughout — currentGeneration() never changes.
    cancelCheck()
    docText = 'document B text' // the editor now shows the newly opened doc

    resolvePostCheck({ check_id: 'c-a', status: 'running', findings: [] } as never)
    await runPromise

    // No subscription opens for the stale check, and its findings/scorecard
    // must never reach the store (which would mean they were autosaved onto
    // document B).
    expect(subscribeCheck).not.toHaveBeenCalled()
    expect(dispatched).toHaveLength(0)
    expect(useStore.getState().scorecard).toBeNull()
  })

  it('sends llm_tier in tier mode, with llm_provider/llm_model null', async () => {
    useStore.setState({ tier: 'balanced' })
    await runCheck(true)

    const body = vi.mocked(postCheck).mock.calls[0][0]
    expect(body.llm_tier).toBe('balanced')
    expect(body.llm_provider).toBeNull()
    expect(body.llm_model).toBeNull()
    expect(body.checkers).toContain('llm')
  })

  it('sends llm_tier: null plus the resolved pair in pinned mode (unchanged behavior)', async () => {
    useStore.setState({ tier: null })
    await runCheck(true)

    const body = vi.mocked(postCheck).mock.calls[0][0]
    expect(body.llm_tier).toBeNull()
    expect(body.llm_provider).toBe('fake')
    expect(body.llm_model).toBe('fake-model')
  })

  it('lands a degraded effective_llm report in the store', async () => {
    const effective_llm = {
      requested: { tier: 'quality' as const, provider: null, model: null },
      effective: { tier: 'balanced' as const, provider: null, model: null },
      degraded: true,
      skipped: null,
    }
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c1',
      status: 'done',
      findings: [],
      effective_llm,
    } as never)

    await runCheck(true)

    expect(useStore.getState().llmEffective).toEqual(effective_llm)
  })

  it('never includes llm in checkers for a floor-policy user, even when includeLlm is true', async () => {
    useStore.setState({ user: user(FLOOR), tier: 'balanced' })
    await runCheck(true)

    const body = vi.mocked(postCheck).mock.calls[0][0]
    expect(body.checkers).not.toContain('llm')
  })

  it('still sends the request for an off-plan tier whose route is offline (server owns degradation)', async () => {
    // RESTRICTED disallows 'balanced'; its own route is also offline —
    // the client must not pre-empt the server's degradation.
    useStore.setState({ user: user(RESTRICTED), tier: 'balanced' })
    vi.mocked(resolveModel).mockReturnValueOnce({ ok: false, reason: 'not configured' })

    await runCheck(true)

    const body = vi.mocked(postCheck).mock.calls[0][0]
    expect(body.checkers).toContain('llm')
    expect(body.llm_tier).toBe('balanced')
    expect(useStore.getState().llmError).toBeNull()
  })

  it('still skips client-side for an allowed-but-offline tier, as today', async () => {
    useStore.setState({ user: user(RESTRICTED), tier: 'cheap' })
    vi.mocked(resolveModel).mockReturnValueOnce({ ok: false, reason: 'unavailable' })

    await runCheck(true)

    const body = vi.mocked(postCheck).mock.calls[0][0]
    expect(body.checkers).not.toContain('llm')
    expect(useStore.getState().llmError).toBeTruthy()
  })

  it("resets llmEffective on a new runCheck(), including via the empty-text early return", async () => {
    const effective_llm = {
      requested: { tier: 'balanced' as const, provider: null, model: null },
      effective: { tier: 'balanced' as const, provider: null, model: null },
      degraded: false,
      skipped: 'llm_unavailable',
    }
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c1',
      status: 'done',
      findings: [],
      effective_llm,
    } as never)
    await runCheck(true)
    expect(useStore.getState().llmEffective).toEqual(effective_llm)

    docText = '   ' // whitespace-only: the early-return branch
    await runCheck(true)

    expect(useStore.getState().llmEffective).toBeNull()
  })

  it('maps a 429 from postCheck to serverBusy without touching auth state', async () => {
    useStore.setState({ token: 'tok', user: user(FLOOR) })
    vi.mocked(postCheck).mockRejectedValue(new HttpError(429, 'busy'))

    await runCheck(true)

    expect(useStore.getState().llmError).toBe(messages.serverBusy)
    expect(useStore.getState().checkPhase).toBe('idle')
    expect(useStore.getState().token).toBe('tok')
    expect(useStore.getState().user).toEqual(user(FLOOR))
  })
})
