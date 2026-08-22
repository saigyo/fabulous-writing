// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postSuggestions: vi.fn(),
}))
vi.mock('./routing', () => ({
  resolveModel: vi.fn(() => ({ ok: true, provider: 'fake', model: 'fake-model' })),
}))
vi.mock('../auth/refreshSlot', () => ({ refreshUserNow: vi.fn() }))

import { HttpError, postSuggestions } from '../api/client'
import { refreshUserNow } from '../auth/refreshSlot'
import { bumpGeneration, resetAutosaveForTests } from '../documents/autosave'
import { en as messages } from '../i18n/en'
import { setDocumentPort, type DocumentPort } from './documentPort'
import { fetchRewrite, fetchSuggestions, llmActionPending } from './suggest'
import { resolveModel } from './routing'

const fakePort: DocumentPort = {
  hasDocument: () => true,
  getText: () => 'Some text with issues.',
  setDocument: () => {},
  currentFinding: (id) =>
    id === 'f1'
      ? { finding: { id: 'f1', message: 'msg', rule_id: null } as never, from: 0, to: 4 }
      : null,
  serverSpan: (id) => (id === 'f1' ? { start: 0, end: 4 } : null),
  mergeFindings: () => {},
  selectFinding: () => {},
  applySuggestion: () => Promise.resolve('not-found'),
  applyRewrite: () => Promise.resolve('not-found'),
}

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

const RESTRICTED: MeResponse['policy'] = {
  llm: { tiers: ['cheap', 'local'], providers: ['ollama'], models: null },
  features: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAutosaveForTests()
  setDocumentPort(fakePort)
  useStore.getState().setSuggestPending(null)
  useStore.getState().setRewritePending(null)
  useStore.getState().setSuggestError('f1', null)
  useStore.getState().setSuggestHeldBack('f1', null)
  useStore.getState().setSuggestAdvice('f1', null)
  useStore.getState().setExtraSuggestions('f1', [])
  useStore.getState().setRewriteError('f1', null)
  useStore.setState({ tier: null, user: null })
  vi.mocked(resolveModel).mockReturnValue({
    ok: true,
    provider: 'fake',
    model: 'fake-model',
  })
})

afterEach(() => {
  setDocumentPort(null)
})

describe('fetchSuggestions', () => {
  it('populates suggestions and clears held-back on a clean result', async () => {
    vi.mocked(postSuggestions).mockResolvedValue({
      suggestions: ['better'],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
    })

    await fetchSuggestions('f1')

    const state = useStore.getState()
    expect(state.extraSuggestions.f1).toEqual(['better'])
    expect(state.suggestHeldBack.f1).toBeUndefined()
    expect(state.suggestErrors.f1).toBeUndefined()
  })

  it('sets the error message and held-back list on a vetoed result, without populating suggestions', async () => {
    vi.mocked(postSuggestions).mockResolvedValue({
      suggestions: [],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 1,
      held_back: [
        { text: 'maybe', reason_kind: 'rules', rule_ids: ['r1'], words: [] },
      ],
      advice: [],
    })

    await fetchSuggestions('f1')

    const state = useStore.getState()
    expect(state.suggestErrors.f1).toBeTruthy()
    expect(state.suggestHeldBack.f1).toEqual([
      { text: 'maybe', reason_kind: 'rules', rule_ids: ['r1'], words: [] },
    ])
    expect(state.extraSuggestions.f1).toEqual([])
  })

  it('stores advice independently of the veto outcome', async () => {
    vi.mocked(postSuggestions).mockResolvedValue({
      suggestions: [],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 1,
      held_back: [],
      advice: ['consider rephrasing'],
    })

    await fetchSuggestions('f1')

    expect(useStore.getState().suggestAdvice.f1).toEqual(['consider rephrasing'])
  })

  it('skips a second call while suggestPendingId is already set', async () => {
    useStore.getState().setSuggestPending('other-finding')

    await fetchSuggestions('f1')

    expect(postSuggestions).not.toHaveBeenCalled()
    expect(llmActionPending()).toBe(true)
  })

  it('drops a suggestion response that resolves after the session already ended', async () => {
    let resolvePost!: (value: Awaited<ReturnType<typeof postSuggestions>>) => void
    vi.mocked(postSuggestions).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve
        }),
    )

    const call = fetchSuggestions('f1')
    bumpGeneration() // the literal bump invalidateDocumentWork() makes on session end
    resolvePost({
      suggestions: ['better'],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
    })
    await call

    // beforeEach primes extraSuggestions.f1 to []; a dropped response must
    // leave it exactly there, not overwrite it with the stale suggestions.
    expect(useStore.getState().extraSuggestions.f1).toEqual([])
  })

  it("an outgoing session's stale completion does not clear the incoming session's own in-flight pending marker", async () => {
    let resolveStale!: (value: Awaited<ReturnType<typeof postSuggestions>>) => void
    vi.mocked(postSuggestions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve
        }),
    )

    const staleCall = fetchSuggestions('f1') // outgoing session's call: now in flight
    expect(useStore.getState().suggestPendingId).toBe('f1')

    bumpGeneration() // simulates logout()/expireSession() firing mid-flight
    // Mirrors what a real logout's resetSessionState() does to this field —
    // exercised directly since this test is scoped to suggest.ts alone.
    useStore.getState().setSuggestPending(null)

    let resolveIncoming!: (value: Awaited<ReturnType<typeof postSuggestions>>) => void
    vi.mocked(postSuggestions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIncoming = resolve
        }),
    )
    const incomingCall = fetchSuggestions('f1') // incoming session's own call: also in flight
    expect(useStore.getState().suggestPendingId).toBe('f1') // the incoming session's own marker

    // The outgoing session's stale request now resolves.
    resolveStale({
      suggestions: ['stale'],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
    })
    await staleCall

    // The incoming session's request is still genuinely in flight; its
    // pending marker must survive the outgoing session's stale completion.
    expect(useStore.getState().suggestPendingId).toBe('f1')

    resolveIncoming({
      suggestions: ['fresh'],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
    })
    await incomingCall

    // The incoming session's own completion still clears it normally.
    expect(useStore.getState().suggestPendingId).toBeNull()
  })

  it('an off-plan, offline tier does not throw and posts llm_tier', async () => {
    // RESTRICTED disallows 'balanced'; its own route is also offline — the
    // request must still go to the server, which owns the degradation.
    useStore.setState({ user: user(RESTRICTED), tier: 'balanced' })
    vi.mocked(resolveModel).mockReturnValueOnce({ ok: false, reason: 'not configured' })
    vi.mocked(postSuggestions).mockResolvedValue({
      suggestions: ['better'],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
    })

    await fetchSuggestions('f1')

    expect(postSuggestions).toHaveBeenCalled()
    expect(vi.mocked(postSuggestions).mock.calls[0][0].llm_tier).toBe('balanced')
    expect(useStore.getState().suggestErrors.f1).toBeUndefined()
  })

  it('an allowed-but-offline tier still throws llmSkipped', async () => {
    useStore.setState({ user: user(RESTRICTED), tier: 'cheap' })
    vi.mocked(resolveModel).mockReturnValueOnce({ ok: false, reason: 'unavailable' })

    await fetchSuggestions('f1')

    expect(postSuggestions).not.toHaveBeenCalled()
    expect(useStore.getState().suggestErrors.f1).toBeTruthy()
  })

  it('maps a quota_exhausted skip to the shared notice', async () => {
    useStore.setState({ user: user(RESTRICTED) })
    vi.mocked(postSuggestions).mockResolvedValue({
      suggestions: [],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
      skipped: 'quota_exhausted',
    })

    await fetchSuggestions('f1')

    expect(useStore.getState().suggestErrors.f1).toBe(messages.llmQuotaExhausted)
  })

  it('maps a 429 rejection to serverBusy', async () => {
    vi.mocked(postSuggestions).mockRejectedValue(new HttpError(429, 'busy'))

    await fetchSuggestions('f1')

    expect(useStore.getState().suggestErrors.f1).toBe(messages.serverBusy)
  })

  it('refreshes the quota indicator after a provider failure (a 502 whose ledger row still spent quota)', async () => {
    vi.mocked(postSuggestions).mockRejectedValue(new HttpError(502, 'Bad Gateway'))

    await fetchSuggestions('f1')

    expect(refreshUserNow).toHaveBeenCalled()
  })

  it('does not refresh the quota indicator after a 429 (nothing was reserved)', async () => {
    vi.mocked(postSuggestions).mockRejectedValue(new HttpError(429, 'busy'))

    await fetchSuggestions('f1')

    expect(refreshUserNow).not.toHaveBeenCalled()
  })
})

describe('fetchRewrite', () => {
  it('drops a rewrite response that resolves after the session already ended', async () => {
    let resolvePost!: (value: Awaited<ReturnType<typeof postSuggestions>>) => void
    vi.mocked(postSuggestions).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve
        }),
    )

    const call = fetchRewrite('f1')
    bumpGeneration()
    resolvePost({
      suggestions: ['rewritten sentence'],
      span: { start: 0, end: 4 },
      original: 'a sentence from user A\'s document',
      rejected: 0,
      held_back: [],
      advice: [],
    })
    await call

    expect(useStore.getState().rewrites.f1).toBeUndefined()
  })

  it("an outgoing session's stale completion does not clear the incoming session's own in-flight pending marker", async () => {
    let resolveStale!: (value: Awaited<ReturnType<typeof postSuggestions>>) => void
    vi.mocked(postSuggestions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve
        }),
    )

    const staleCall = fetchRewrite('f1') // outgoing session's call: now in flight
    expect(useStore.getState().rewritePendingId).toBe('f1')

    bumpGeneration() // simulates logout()/expireSession() firing mid-flight
    useStore.getState().setRewritePending(null) // mirrors resetSessionState()

    let resolveIncoming!: (value: Awaited<ReturnType<typeof postSuggestions>>) => void
    vi.mocked(postSuggestions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIncoming = resolve
        }),
    )
    const incomingCall = fetchRewrite('f1') // incoming session's own call: also in flight
    expect(useStore.getState().rewritePendingId).toBe('f1')

    resolveStale({
      suggestions: ['stale rewrite'],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
    })
    await staleCall

    expect(useStore.getState().rewritePendingId).toBe('f1')

    resolveIncoming({
      suggestions: ['fresh rewrite'],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
    })
    await incomingCall

    expect(useStore.getState().rewritePendingId).toBeNull()
  })

  it('an off-plan, offline tier does not throw and posts llm_tier', async () => {
    useStore.setState({ user: user(RESTRICTED), tier: 'balanced' })
    vi.mocked(resolveModel).mockReturnValueOnce({ ok: false, reason: 'not configured' })
    vi.mocked(postSuggestions).mockResolvedValue({
      suggestions: ['rewritten'],
      span: { start: 0, end: 4 },
      original: 'orig',
      rejected: 0,
      held_back: [],
      advice: [],
    })

    await fetchRewrite('f1')

    expect(postSuggestions).toHaveBeenCalled()
    expect(vi.mocked(postSuggestions).mock.calls[0][0].llm_tier).toBe('balanced')
    expect(useStore.getState().rewriteErrors.f1).toBeUndefined()
  })

  it('an allowed-but-offline tier still throws llmSkipped', async () => {
    useStore.setState({ user: user(RESTRICTED), tier: 'cheap' })
    vi.mocked(resolveModel).mockReturnValueOnce({ ok: false, reason: 'unavailable' })

    await fetchRewrite('f1')

    expect(postSuggestions).not.toHaveBeenCalled()
    expect(useStore.getState().rewriteErrors.f1).toBeTruthy()
  })

  it('maps a 429 rejection to serverBusy', async () => {
    vi.mocked(postSuggestions).mockRejectedValue(new HttpError(429, 'busy'))

    await fetchRewrite('f1')

    expect(useStore.getState().rewriteErrors.f1).toBe(messages.serverBusy)
  })

  it('refreshes the quota indicator after a provider failure (a 502 whose ledger row still spent quota)', async () => {
    vi.mocked(postSuggestions).mockRejectedValue(new HttpError(502, 'Bad Gateway'))

    await fetchRewrite('f1')

    expect(refreshUserNow).toHaveBeenCalled()
  })

  it('does not refresh the quota indicator after a 429 (nothing was reserved)', async () => {
    vi.mocked(postSuggestions).mockRejectedValue(new HttpError(429, 'busy'))

    await fetchRewrite('f1')

    expect(refreshUserNow).not.toHaveBeenCalled()
  })
})
