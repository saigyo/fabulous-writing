// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postSuggestions: vi.fn(),
}))
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => ({
    state: {
      doc: { toString: () => 'Some text with issues.' },
      field: () => ({
        items: [
          {
            finding: { id: 'f1', message: 'msg', rule_id: null },
            from: 0,
            to: 4,
          },
        ],
      }),
    },
  }),
}))
vi.mock('../editor/findings', () => ({ findingsField: {} }))
vi.mock('./routing', () => ({
  resolveModel: () => ({ ok: true, provider: 'fake', model: 'fake-model' }),
}))

import { postSuggestions } from '../api/client'
import { bumpGeneration, resetAutosaveForTests } from '../documents/autosave'
import { fetchRewrite, fetchSuggestions, llmActionPending } from './suggest'

beforeEach(() => {
  vi.clearAllMocks()
  resetAutosaveForTests()
  useStore.getState().setSuggestPending(null)
  useStore.getState().setRewritePending(null)
  useStore.getState().setSuggestError('f1', null)
  useStore.getState().setSuggestHeldBack('f1', null)
  useStore.getState().setSuggestAdvice('f1', null)
  useStore.getState().setExtraSuggestions('f1', [])
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
})
