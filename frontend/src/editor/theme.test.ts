// @vitest-environment happy-dom
import { defaultHighlightStyle } from '@codemirror/language'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { darkSpecs, editorTheme, watchTheme } from './theme'

type Listener = (event: { matches: boolean }) => void

/**
 * happy-dom does implement matchMedia, but not a controllable one. The
 * stub reaches window.matchMedia because window === globalThis under
 * vitest's happy-dom environment.
 */
function stubMatchMedia(matches = false) {
  const listeners = new Set<Listener>()
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addEventListener: (_: 'change', fn: Listener) => listeners.add(fn),
    removeEventListener: (_: 'change', fn: Listener) => listeners.delete(fn),
  }))
  return {
    fire(m: boolean) {
      for (const fn of [...listeners]) fn({ matches: m })
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('editorTheme', () => {
  it('pre-loads the dark scheme at creation', () => {
    stubMatchMedia(true)
    const state = EditorState.create({ extensions: [editorTheme()] })
    expect(state.facet(EditorView.darkTheme)).toBe(true)
  })

  it('does not flip the dark facet in light', () => {
    stubMatchMedia(false)
    const state = EditorState.create({ extensions: [editorTheme()] })
    expect(state.facet(EditorView.darkTheme)).toBe(false)
  })
})

describe('darkSpecs', () => {
  it('substitutes exactly the meta and url specs with dark colors', () => {
    const metaSpecs = defaultHighlightStyle.specs.filter((spec) => spec.tag === tags.meta)
    const urlSpecs = defaultHighlightStyle.specs.filter(
      (spec) => Array.isArray(spec.tag) && spec.tag.includes(tags.url),
    )
    expect(metaSpecs).toHaveLength(1)
    expect(urlSpecs).toHaveLength(1)

    const metaIndex = defaultHighlightStyle.specs.indexOf(metaSpecs[0])
    const urlIndex = defaultHighlightStyle.specs.indexOf(urlSpecs[0])
    expect(darkSpecs[metaIndex].color).toBe('var(--text-dim)')
    expect(darkSpecs[urlIndex].color).toBe('var(--accent)')
  })
})

describe('watchTheme', () => {
  it('reconfigures the view when the OS scheme changes', () => {
    const media = stubMatchMedia(false)
    const state = EditorState.create({ extensions: [editorTheme()] })
    expect(state.facet(EditorView.darkTheme)).toBe(false)

    const dispatch = vi.fn()
    watchTheme({ dispatch } as unknown as EditorView)
    media.fire(true)

    expect(dispatch).toHaveBeenCalledTimes(1)
    const newState = state.update(dispatch.mock.calls[0][0] as TransactionSpec).state
    expect(newState.facet(EditorView.darkTheme)).toBe(true)
  })

  it('stops following after cleanup', () => {
    const media = stubMatchMedia()
    const dispatch = vi.fn()
    const stop = watchTheme({ dispatch } as unknown as EditorView)
    stop()
    media.fire(true)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
