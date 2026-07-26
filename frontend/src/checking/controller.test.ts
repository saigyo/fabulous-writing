// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  resolveModel: () => ({ ok: true, provider: 'fake', model: 'fake-model' }),
}))
vi.mock('../documents/autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../documents/autosave')>()),
  flush: vi.fn().mockResolvedValue(undefined),
}))

import { postCheck, subscribeCheck } from '../api/client'
import { bumpGeneration, resetAutosaveForTests } from '../documents/autosave'
import { cancelInFlightCheck } from './cancelSlot'
import { cancelCheck, runCheck } from './controller'

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
  useStore.setState({ scorecard: null, scorecardStale: false, llmError: null })
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
})
