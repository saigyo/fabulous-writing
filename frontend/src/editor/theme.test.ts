// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorTheme, watchTheme } from './theme'

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

  it('contributes nothing in light', () => {
    stubMatchMedia(false)
    const state = EditorState.create({ extensions: [editorTheme()] })
    expect(state.facet(EditorView.darkTheme)).toBe(false)
  })
})

describe('watchTheme', () => {
  it('reconfigures the view when the OS scheme changes', () => {
    const media = stubMatchMedia()
    const dispatch = vi.fn()
    watchTheme({ dispatch } as unknown as EditorView)
    media.fire(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toHaveProperty('effects')
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
