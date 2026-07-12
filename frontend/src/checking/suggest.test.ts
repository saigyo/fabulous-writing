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
import { fetchSuggestions, llmActionPending } from './suggest'

beforeEach(() => {
  vi.clearAllMocks()
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
})
