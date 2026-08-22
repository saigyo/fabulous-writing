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

// Copilot round 2: once a textarea's content grows tall enough to show a
// vertical scrollbar, the scrollbar eats into the content box the browser
// wraps lines against. The mirror overlay must reserve the same gutter
// (copy overflow-x/-y and scrollbar-gutter) or its wrapped lines diverge
// from the textarea's real ones. jsdom/happy-dom don't render actual
// scrollbars or reflow around them, so this only proves the CSS property
// VALUES are copied onto the overlay — confirming the wrap widths visually
// match once a real scrollbar appears requires a real browser (see the
// simulator's own hand-check, spec Task 7 Step 6).
describe('createTextareaAdapter: overlay reserves the textarea scrollbar gutter', () => {
  it('copies overflow-x, overflow-y, and scrollbar-gutter from the textarea onto the overlay', () => {
    el.style.overflowX = 'hidden'
    el.style.overflowY = 'scroll'
    el.style.setProperty('scrollbar-gutter', 'stable')

    const adapter = createTextareaAdapter(el)

    const overlay = document.querySelector('.fw-mirror-overlay') as HTMLDivElement
    expect(overlay.style.overflowX).toBe('hidden')
    expect(overlay.style.overflowY).toBe('scroll')
    expect(overlay.style.getPropertyValue('scrollbar-gutter')).toBe('stable')

    adapter.dispose()
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

    const mark = document.querySelector('[data-finding-ids="f1"]')
    expect(mark).not.toBeNull()
    expect(mark?.className).toContain('fw-mark-error')
    expect(mark?.textContent).toBe('quikc')
    adapter.dispose()
  })

  it('clearMarkings removes rendered marks', () => {
    const adapter = createTextareaAdapter(el)
    adapter.setMarkings([{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }])

    adapter.clearMarkings()

    expect(document.querySelector('[data-finding-ids="f1"]')).toBeNull()
    adapter.dispose()
  })
})

// Copilot round 2: the backend deliberately permits overlapping findings
// (different checkers flagging intersecting/nested ranges — see
// backend/app/checkers/pipeline.py's spans_overlap/drop_duplicates). A
// single non-overlapping render pass (clamp each span to the previous
// span's end) would silently drop any finding covered by another.
describe('createTextareaAdapter: overlapping and nested spans', () => {
  it('a span nested fully inside another renders a flashable segment for the inner id', () => {
    const adapter = createTextareaAdapter(el)
    // el.value: 'The quikc brown fox' — outer covers "quikc brown" [4,15),
    // inner covers "quikc" [4,9), fully inside the outer span.
    const spans: MarkingSpan[] = [
      { id: 'outer', from: 4, to: 15, severity: 'warning', category: 'style' },
      { id: 'inner', from: 4, to: 9, severity: 'error', category: 'spelling' },
    ]
    adapter.setMarkings(spans)

    // The inner finding must still get its own addressable segment, not be
    // swallowed by clamping to the outer span's start/end.
    const innerMark = document.querySelector('[data-finding-ids~="inner"]')
    expect(innerMark).not.toBeNull()
    expect(innerMark?.textContent).toBe(el.value.slice(4, 9))
    // The shared segment renders at the higher of the two severities
    // (error outranks warning).
    expect(innerMark?.className).toContain('fw-mark-error')

    adapter.flashFinding('inner')
    expect(innerMark?.className).toContain('fw-mark-flash')

    adapter.dispose()
  })

  it('staggered overlapping spans render three segments with correct coverage', () => {
    const adapter = createTextareaAdapter(el)
    // A: [0,10), B: [5,15) — staggered overlap, neither contains the other.
    const spans: MarkingSpan[] = [
      { id: 'a', from: 0, to: 10, severity: 'warning', category: 'style' },
      { id: 'b', from: 5, to: 15, severity: 'suggestion', category: 'style' },
    ]
    adapter.setMarkings(spans)

    const marks = [...document.querySelectorAll('.fw-mark')]
    expect(marks).toHaveLength(3)
    const [seg1, seg2, seg3] = marks

    // [0,5): A only.
    expect(seg1.textContent).toBe(el.value.slice(0, 5))
    expect(seg1.getAttribute('data-finding-ids')).toBe('a')
    expect(seg1.className).toContain('fw-mark-warning')

    // [5,10): covered by both — carries both ids, renders at the higher
    // severity (warning outranks suggestion).
    expect(seg2.textContent).toBe(el.value.slice(5, 10))
    expect(seg2.getAttribute('data-finding-ids')).toBe('a b')
    expect(seg2.className).toContain('fw-mark-warning')

    // [10,15): B only.
    expect(seg3.textContent).toBe(el.value.slice(10, 15))
    expect(seg3.getAttribute('data-finding-ids')).toBe('b')
    expect(seg3.className).toContain('fw-mark-suggestion')

    // markingClicked hit-testing (main.ts) matches on the raw findings
    // array by position, not the DOM — flashFinding still works for both
    // ids sharing the overlap segment.
    adapter.flashFinding('a')
    expect(seg1.className).toContain('fw-mark-flash')

    adapter.dispose()
  })
})

describe('createTextareaAdapter: flashFinding', () => {
  it('pulses the fw-mark-flash class on the matching mark, then removes it', () => {
    vi.useFakeTimers()
    const adapter = createTextareaAdapter(el)
    adapter.setMarkings([{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }])

    adapter.flashFinding('f1')
    const mark = document.querySelector('[data-finding-ids="f1"]')
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
