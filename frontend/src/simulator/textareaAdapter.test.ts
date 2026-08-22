// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTextareaAdapter } from './textareaAdapter'
import type { MarkingSpan } from '../embed/protocol'

let el: HTMLTextAreaElement

beforeEach(() => {
  el = document.createElement('textarea')
  el.value = 'The quikc brown fox'
  document.body.appendChild(el)
})

afterEach(() => {
  el.remove()
})

describe('createTextareaAdapter: capabilities', () => {
  it('reports overlay marking and reliable replacement', () => {
    const adapter = createTextareaAdapter(el)
    expect(adapter.capabilities()).toEqual({ mark: 'overlay', replace: 'reliable' })
    adapter.dispose()
  })
})

describe('createTextareaAdapter: extract/onChange', () => {
  it('extract returns the live textarea value', () => {
    const adapter = createTextareaAdapter(el)
    expect(adapter.extract()).toBe('The quikc brown fox')
    el.value = 'changed'
    expect(adapter.extract()).toBe('changed')
    adapter.dispose()
  })

  it('onChange fires on the textarea input event', () => {
    const adapter = createTextareaAdapter(el)
    const cb = vi.fn()
    adapter.onChange(cb)

    el.value = 'The quick brown fox'
    el.dispatchEvent(new Event('input'))

    expect(cb).toHaveBeenCalledTimes(1)
    adapter.dispose()
  })
})

describe('createTextareaAdapter: ResizeObserver geometry sync', () => {
  it('observes the textarea and disconnects on dispose', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    const unobserve = vi.fn()
    const OriginalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    class StubResizeObserver {
      observe = observe
      disconnect = disconnect
      unobserve = unobserve
    }
    ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver

    const adapter = createTextareaAdapter(el)
    expect(observe).toHaveBeenCalledWith(el)
    expect(disconnect).not.toHaveBeenCalled()

    adapter.dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)

    ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = OriginalResizeObserver
  })

  it('is a no-op (no throw) when ResizeObserver is unavailable', () => {
    const OriginalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).ResizeObserver

    expect(() => {
      const adapter = createTextareaAdapter(el)
      adapter.dispose()
    }).not.toThrow()

    ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = OriginalResizeObserver
  })
})

describe('createTextareaAdapter: applyReplacement', () => {
  it('happy path: matching expectedText mutates the value and reports the new text', () => {
    const adapter = createTextareaAdapter(el)

    const result = adapter.applyReplacement(4, 9, 'quick', 'quikc')

    expect(result).toEqual({ ok: true, text: 'The quick brown fox' })
    expect(el.value).toBe('The quick brown fox')
    adapter.dispose()
  })

  it('happy path dispatches an input event so onChange listeners hear the change', () => {
    const adapter = createTextareaAdapter(el)
    const cb = vi.fn()
    adapter.onChange(cb)

    adapter.applyReplacement(4, 9, 'quick', 'quikc')

    expect(cb).toHaveBeenCalledTimes(1)
    adapter.dispose()
  })

  it('happy path dispatches an InputEvent that bubbles to a document-level (delegation-style) listener', () => {
    const adapter = createTextareaAdapter(el)
    const docListener = vi.fn()
    document.addEventListener('input', docListener)

    adapter.applyReplacement(4, 9, 'quick', 'quikc')

    expect(docListener).toHaveBeenCalledTimes(1)
    const event = docListener.mock.calls[0][0] as Event
    expect(event).toBeInstanceOf(InputEvent)
    expect(event.bubbles).toBe(true)
    expect(event.target).toBe(el)

    document.removeEventListener('input', docListener)
    adapter.dispose()
  })

  it('expectedText mismatch refuses and leaves the value untouched', () => {
    const adapter = createTextareaAdapter(el)

    const result = adapter.applyReplacement(4, 9, 'quick', 'wrong-expectation')

    expect(result).toEqual({ ok: false, text: 'The quikc brown fox' })
    expect(el.value).toBe('The quikc brown fox')
    adapter.dispose()
  })

  it('expectedText mismatch does not dispatch an input event', () => {
    const adapter = createTextareaAdapter(el)
    const cb = vi.fn()
    adapter.onChange(cb)

    adapter.applyReplacement(4, 9, 'quick', 'wrong-expectation')

    expect(cb).not.toHaveBeenCalled()
    adapter.dispose()
  })
})

describe('createTextareaAdapter: setMarkings/clearMarkings', () => {
  it('renders each span as a fw-mark-<severity> element carrying its text', () => {
    const adapter = createTextareaAdapter(el)
    const spans: MarkingSpan[] = [
      { id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' },
    ]

    adapter.setMarkings(spans)

    const mark = document.querySelector('[data-finding-id="f1"]')
    expect(mark).not.toBeNull()
    expect(mark?.className).toContain('fw-mark-error')
    expect(mark?.textContent).toBe('quikc')
    adapter.dispose()
  })

  it('clearMarkings removes rendered marks', () => {
    const adapter = createTextareaAdapter(el)
    adapter.setMarkings([{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }])

    adapter.clearMarkings()

    expect(document.querySelector('[data-finding-id="f1"]')).toBeNull()
    adapter.dispose()
  })
})

describe('createTextareaAdapter: flashFinding', () => {
  it('pulses the fw-mark-flash class on the matching mark, then removes it', () => {
    vi.useFakeTimers()
    const adapter = createTextareaAdapter(el)
    adapter.setMarkings([{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }])

    adapter.flashFinding('f1')
    const mark = document.querySelector('[data-finding-id="f1"]')
    expect(mark?.className).toContain('fw-mark-flash')

    vi.runAllTimers()
    expect(mark?.className).not.toContain('fw-mark-flash')

    adapter.dispose()
    vi.useRealTimers()
  })

  it('is a no-op when the id is not currently marked', () => {
    const adapter = createTextareaAdapter(el)
    expect(() => adapter.flashFinding('does-not-exist')).not.toThrow()
    adapter.dispose()
  })
})

describe('createTextareaAdapter: dispose', () => {
  it('removes the mirror overlay from the DOM', () => {
    const adapter = createTextareaAdapter(el)
    const before = document.querySelectorAll('.fw-mirror-overlay').length
    expect(before).toBe(1)

    adapter.dispose()

    expect(document.querySelectorAll('.fw-mirror-overlay').length).toBe(0)
  })
})
