import { beforeEach, describe, expect, it } from 'vitest'
import type { TrackedFinding } from '../editor/findings'
import type { Finding } from '../types'
import { useStore } from './store'

function tracked(id: string, from: number, to: number, text: string): TrackedFinding {
  const finding: Finding = {
    id,
    category: 'style',
    severity: 'warning',
    source: 'rule',
    rule_id: 'style.test',
    message: 'm',
    span: { start: from, end: to, text },
    suggestions: [],
  }
  return { finding, from, to }
}

describe('setTracked cache migration', () => {
  beforeEach(() => {
    useStore.setState({
      tracked: [],
      selectedId: null,
      extraSuggestions: {},
      suggestErrors: {},
      rewrites: {},
      rewriteErrors: {},
    })
  })

  it('migrates fetched suggestions and rewrites to the equivalent new finding', () => {
    const old = tracked('old', 8, 12, 'very')
    useStore.setState({
      tracked: [old],
      extraSuggestions: { old: ['extremely'] },
      rewrites: { old: { original: 'This is very good.', options: ['This shines.'] } },
      suggestErrors: { old: 'previous error' },
    })
    useStore.getState().setTracked([tracked('new', 8, 12, 'very')], 'new')
    const state = useStore.getState()
    expect(state.extraSuggestions).toEqual({ new: ['extremely'] })
    expect(state.rewrites.new?.options).toEqual(['This shines.'])
    expect(state.suggestErrors).toEqual({ new: 'previous error' })
  })

  it('still drops caches whose finding has no equivalent', () => {
    const old = tracked('old', 8, 12, 'very')
    useStore.setState({ tracked: [old], extraSuggestions: { old: ['extremely'] } })
    useStore.getState().setTracked([tracked('other', 30, 34, 'good')], null)
    expect(useStore.getState().extraSuggestions).toEqual({})
  })

  it('keeps caches for unchanged ids', () => {
    const same = tracked('keep', 8, 12, 'very')
    useStore.setState({ tracked: [same], extraSuggestions: { keep: ['extremely'] } })
    useStore.getState().setTracked([same], null)
    expect(useStore.getState().extraSuggestions).toEqual({ keep: ['extremely'] })
  })
})

describe('tier / pin semantics', () => {
  it('setTier enters tier mode', () => {
    useStore.getState().setTier('quality')
    expect(useStore.getState().tier).toBe('quality')
  })

  it('choosing a provider pins (clears the tier)', () => {
    useStore.getState().setTier('balanced')
    useStore.getState().setProvider('claude')
    expect(useStore.getState().tier).toBeNull()
    expect(useStore.getState().provider).toBe('claude')
    expect(useStore.getState().model).toBeNull()
  })

  it('choosing a model pins (clears the tier)', () => {
    useStore.getState().setTier('balanced')
    useStore.getState().setModel('claude-opus-4-8')
    expect(useStore.getState().tier).toBeNull()
    expect(useStore.getState().model).toBe('claude-opus-4-8')
  })
})
