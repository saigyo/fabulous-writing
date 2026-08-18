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
vi.mock('../auth/refreshSlot', () => ({ refreshUserNow: vi.fn() }))

import { HttpError, postCheck, subscribeCheck } from '../api/client'
import { refreshUserNow } from '../auth/refreshSlot'
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

  it('drops a check whose postCheck resolves after a same-session document switch, but still refreshes the quota indicator if it was admitted', async () => {
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

    resolvePostCheck({
      check_id: 'c-a',
      status: 'running',
      findings: [],
      effective_llm: {
        requested: { tier: 'balanced', provider: null, model: null },
        effective: { tier: 'balanced', provider: null, model: null },
        degraded: false,
        skipped: null,
      },
    } as never)
    await runPromise

    // No subscription opens for the stale check, and its findings/scorecard
    // must never reach the store (which would mean they were autosaved onto
    // document B).
    expect(subscribeCheck).not.toHaveBeenCalled()
    expect(dispatched).toHaveLength(0)
    expect(useStore.getState().scorecard).toBeNull()

    // But the ledger row for this admitted run was already inserted at
    // ADMISSION, before the document switch happened — the quota indicator
    // must reflect it regardless of the epoch bump that dropped everything
    // else above.
    expect(refreshUserNow).toHaveBeenCalledTimes(1)
  })

  it('does not refresh a same-session document-switch check that was skipped (no ledger row was written)', async () => {
    let resolvePostCheck!: (value: Awaited<ReturnType<typeof postCheck>>) => void
    vi.mocked(postCheck).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePostCheck = resolve
        }),
    )
    vi.mocked(subscribeCheck).mockReturnValue(() => {})

    const runPromise = runCheck(true)
    cancelCheck()
    docText = 'document B text'

    resolvePostCheck({
      check_id: 'c-a',
      status: 'done',
      findings: [],
      effective_llm: {
        requested: { tier: 'balanced', provider: null, model: null },
        effective: { tier: 'balanced', provider: null, model: null },
        degraded: false,
        skipped: 'quota_exhausted',
      },
    } as never)
    await runPromise

    expect(refreshUserNow).not.toHaveBeenCalled()
  })

  it('does not refresh an admitted run if the session itself ended mid-flight (gen mismatch)', async () => {
    // The literal sequence from 'drops a check whose postCheck resolves
    // after the session already ended' above, but with an admitted
    // effective_llm this time: a gen mismatch means the session ended
    // (logout/expireSession) while postCheck was in flight, so refreshing
    // here would race the *next* session's own /me fetch rather than
    // reflecting this one's ledger row. refreshUserNow() is itself
    // generation-guarded, but this asserts the explicit gen check at the
    // call site also holds on its own.
    let resolvePostCheck!: (value: Awaited<ReturnType<typeof postCheck>>) => void
    vi.mocked(postCheck).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePostCheck = resolve
        }),
    )
    vi.mocked(subscribeCheck).mockReturnValue(() => {})

    const runPromise = runCheck(true)

    cancelInFlightCheck()
    bumpGeneration()

    resolvePostCheck({
      check_id: 'c-a',
      status: 'running',
      findings: [],
      effective_llm: {
        requested: { tier: 'balanced', provider: null, model: null },
        effective: { tier: 'balanced', provider: null, model: null },
        degraded: false,
        skipped: null,
      },
    } as never)
    await runPromise

    expect(refreshUserNow).not.toHaveBeenCalled()
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

  it('does not refresh the quota indicator on a synchronous done result that was skipped (no ledger row was written)', async () => {
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c1',
      status: 'done',
      findings: [],
      effective_llm: {
        requested: { tier: 'balanced', provider: null, model: null },
        effective: { tier: 'balanced', provider: null, model: null },
        degraded: false,
        skipped: 'quota_exhausted',
      },
    } as never)

    await runCheck(true)

    expect(refreshUserNow).not.toHaveBeenCalled()
  })

  it('still refreshes a synchronous done result that was NOT skipped (guard stays correct if that path is ever reached)', async () => {
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c1',
      status: 'done',
      findings: [],
      effective_llm: {
        requested: { tier: 'balanced', provider: null, model: null },
        effective: { tier: 'balanced', provider: null, model: null },
        degraded: false,
        skipped: null,
      },
    } as never)

    await runCheck(true)

    expect(refreshUserNow).toHaveBeenCalled()
  })

  it('refreshes the quota indicator right after an admitted POST resolves, even if the ' +
    'subscription is torn down (cancelCheck) before done ever fires', async () => {
    // The ledger row for an admitted run is inserted at ADMISSION, inside
    // postCheck's own request/response cycle — status 'running' here is
    // exactly that: a real reservation, already reflected in the usage windows.
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c1',
      status: 'running',
      findings: [],
      effective_llm: {
        requested: { tier: 'balanced', provider: null, model: null },
        effective: { tier: 'balanced', provider: null, model: null },
        degraded: false,
        skipped: null,
      },
    } as never)
    const unsub = vi.fn()
    vi.mocked(subscribeCheck).mockReturnValue(unsub)

    await runCheck(true)

    expect(refreshUserNow).toHaveBeenCalledTimes(1)

    // Detach: a document switch tears down the subscription before onDone
    // ever fires. The admitted backend run keeps its quota row regardless —
    // the refresh above already accounted for it, so tearing the
    // subscription down must not trigger (or need) another one.
    cancelCheck()
    expect(refreshUserNow).toHaveBeenCalledTimes(1)
  })

  it('refreshes again from onDone -- settlement lands between admission and done, so the ' +
    'indicator would otherwise lag one check behind', async () => {
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c1',
      status: 'running',
      findings: [],
      effective_llm: {
        requested: { tier: 'balanced', provider: null, model: null },
        effective: { tier: 'balanced', provider: null, model: null },
        degraded: false,
        skipped: null,
      },
    } as never)
    vi.mocked(subscribeCheck).mockReturnValue(() => {})

    await runCheck(true)
    expect(refreshUserNow).toHaveBeenCalledTimes(1) // admission-time refresh

    lastCallbacks().onDone!()

    expect(refreshUserNow).toHaveBeenCalledTimes(2) // settlement-time refresh too
  })

  it('does not refresh from onDone for a run that was never admitted (defensive: a skip ' +
    'never reaches subscribeCheck in practice, but the closure guard must still hold)', async () => {
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c1',
      status: 'running',
      findings: [],
      effective_llm: {
        requested: { tier: 'balanced', provider: null, model: null },
        effective: { tier: 'balanced', provider: null, model: null },
        degraded: false,
        skipped: 'quota_exhausted',
      },
    } as never)
    vi.mocked(subscribeCheck).mockReturnValue(() => {})

    await runCheck(true)
    expect(refreshUserNow).not.toHaveBeenCalled() // no admission-time refresh either

    lastCallbacks().onDone!()

    expect(refreshUserNow).not.toHaveBeenCalled()
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
