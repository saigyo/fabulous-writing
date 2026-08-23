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

// Copilot round 8: the overlay duplicates the textarea's own text purely
// to paint highlight backgrounds underneath it — without aria-hidden a
// screen reader would announce the document's text twice.
describe('createTextareaAdapter: accessibility', () => {
  it('marks the mirror overlay aria-hidden', () => {
    const adapter = createTextareaAdapter(el)
    const overlay = document.querySelector('.fw-mirror-overlay')
    expect(overlay?.getAttribute('aria-hidden')).toBe('true')
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

// Copilot round 3: direction/text-align decide which edge text starts from
// and how it's justified — an RTL or centered textarea whose overlay stayed
// LTR/left-aligned would place its mirrored text at the wrong x-coordinate,
// misaligning every highlight from the real text underneath.
describe('createTextareaAdapter: overlay mirrors direction and text-align', () => {
  it('copies direction and text-align from the textarea onto the overlay', () => {
    el.style.direction = 'rtl'
    el.style.textAlign = 'center'

    const adapter = createTextareaAdapter(el)

    const overlay = document.querySelector('.fw-mirror-overlay') as HTMLDivElement
    expect(overlay.style.direction).toBe('rtl')
    expect(overlay.style.textAlign).toBe('center')

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

  // Finding 1/6: an out-of-range or inverted vector must refuse BEFORE the
  // expectedText compare, which alone is not enough to catch these —
  // String.slice()/setSelectionRange silently clamp or truncate an
  // out-of-range argument, so each vector below passes `expectedText` the
  // value the CLAMPED slice would actually equal. Without the explicit
  // range guard, the compare would pass and the replacement would apply at
  // the wrong (clamped) position instead of being refused outright — so
  // these vectors mutation-verify the guard itself, not just "some" refusal.
  it('to beyond the value length: expectedText matches the clamped slice, but the guard still refuses', () => {
    const adapter = createTextareaAdapter(el)
    const before = el.value // 'The quikc brown fox'
    const clampedSlice = before.slice(4, 1000) // === before.slice(4) — what a bare String.slice would return

    const result = adapter.applyReplacement(4, 1000, 'X', clampedSlice)

    expect(result).toEqual({ ok: false, text: before })
    expect(el.value).toBe(before)
    adapter.dispose()
  })

  it('inverted range (to < from): the coincidental empty slice must not pass as an empty expectedText', () => {
    const adapter = createTextareaAdapter(el)
    const before = el.value

    const result = adapter.applyReplacement(9, 4, 'X', '') // before.slice(9, 4) === ''

    expect(result).toEqual({ ok: false, text: before })
    expect(el.value).toBe(before)
    adapter.dispose()
  })

  it('negative from: the coincidental empty slice must not pass as an empty expectedText', () => {
    const adapter = createTextareaAdapter(el)
    const before = el.value

    const result = adapter.applyReplacement(-5, 3, 'X', '') // before.slice(-5, 3) === ''

    expect(result).toEqual({ ok: false, text: before })
    expect(el.value).toBe(before)
    adapter.dispose()
  })

  it('non-integer (NaN) from: slice()/setSelectionRange would silently truncate NaN to 0', () => {
    const adapter = createTextareaAdapter(el)
    const before = el.value
    const truncatedSlice = before.slice(0, 5) // what slice(NaN, 5) truncates to

    const result = adapter.applyReplacement(NaN, 5, 'X', truncatedSlice)

    expect(result).toEqual({ ok: false, text: before })
    expect(el.value).toBe(before)
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

  // Copilot round 10: render() switched from an O(F^2) per-boundary filter
  // to a sweep-line pass that maintains an active set across boundaries.
  // Three chained overlaps exercise the active set actually accumulating
  // (not just adding/removing one span at a time) and picking the highest
  // severity out of three, not just first/last.
  it('three chained overlapping spans share one segment carrying all three ids at the highest severity', () => {
    const adapter = createTextareaAdapter(el)
    // A: [0,10), B: [3,13), C: [6,16) — a three-way chain overlap in [6,10).
    const spans: MarkingSpan[] = [
      { id: 'a', from: 0, to: 10, severity: 'suggestion', category: 'style' },
      { id: 'b', from: 3, to: 13, severity: 'error', category: 'spelling' },
      { id: 'c', from: 6, to: 16, severity: 'warning', category: 'style' },
    ]
    adapter.setMarkings(spans)

    const shared = document.querySelector('[data-finding-ids="a b c"]')
    expect(shared).not.toBeNull()
    expect(shared?.textContent).toBe(el.value.slice(6, 10))
    // error (b) outranks both warning (c) and suggestion (a).
    expect(shared?.className).toContain('fw-mark-error')

    adapter.dispose()
  })

  // Finding 26: there is no explicit ends-before-starts tie-break at a
  // shared boundary — render()'s inner while loop drains EVERY event at a
  // boundary position (regardless of order between them) before `active` is
  // ever read to build the next segment's covering set, and each span's own
  // end is removed by its own index independent of any other span's start
  // being added at the same position. That drain-before-read is what keeps
  // two merely-adjacent spans from fusing into one shared segment, not an
  // ordering between their events.
  it('two adjacent (non-overlapping) spans render as separate segments, not one shared segment', () => {
    const adapter = createTextareaAdapter(el)
    // D: [0,5), E: [5,10) — D ends exactly where E begins.
    const spans: MarkingSpan[] = [
      { id: 'd', from: 0, to: 5, severity: 'warning', category: 'style' },
      { id: 'e', from: 5, to: 10, severity: 'error', category: 'spelling' },
    ]
    adapter.setMarkings(spans)

    expect(document.querySelector('[data-finding-ids="d e"]')).toBeNull()
    const dMark = document.querySelector('[data-finding-ids="d"]')
    const eMark = document.querySelector('[data-finding-ids="e"]')
    expect(dMark?.textContent).toBe(el.value.slice(0, 5))
    expect(eMark?.textContent).toBe(el.value.slice(5, 10))

    adapter.dispose()
  })
})

// Finding 5: a textarea renders an extra empty line box for a trailing
// "\n"; a `white-space: pre-wrap` overlay div does not, unless something is
// appended after that newline to keep CSS from collapsing the line away.
// happy-dom doesn't lay out text, so this only pins the DOM-content contract
// (the guard character is present, appended last) — not the visual line
// height itself, which needs a real browser (see the adapter's own comment).
describe('createTextareaAdapter: trailing-newline desync guard', () => {
  it('appends a zero-width space after the last text node when the value ends with a newline', () => {
    el.value = 'line one\n'
    const adapter = createTextareaAdapter(el)

    const overlay = document.querySelector('.fw-mirror-overlay') as HTMLDivElement
    expect(overlay.textContent).toBe('line one\n​')
    expect(overlay.lastChild?.textContent).toBe('​')

    adapter.dispose()
  })

  it('does not append the guard character when the value does not end with a newline', () => {
    el.value = 'no trailing newline'
    const adapter = createTextareaAdapter(el)

    const overlay = document.querySelector('.fw-mirror-overlay') as HTMLDivElement
    expect(overlay.textContent).toBe('no trailing newline')
    expect(overlay.textContent?.includes('​')).toBe(false)

    adapter.dispose()
  })

  it('also applies on the marked-spans render path, not just the plain-text one', () => {
    el.value = 'quikc\n'
    const adapter = createTextareaAdapter(el)

    adapter.setMarkings([{ id: 'f1', from: 0, to: 5, severity: 'error', category: 'spelling' }])

    const overlay = document.querySelector('.fw-mirror-overlay') as HTMLDivElement
    expect(overlay.lastChild?.textContent).toBe('​')

    adapter.dispose()
  })
})

// Finding 29: the styles the overlay's correctness depends on (not just this
// demo page's own look) are set inline in JS — the C2 browser extension
// lifts this adapter onto host pages that never load simulator.css.
describe('createTextareaAdapter: critical styles are set inline, not left to a stylesheet', () => {
  it('sets position/pointerEvents/overflow/color/background inline at creation', () => {
    const adapter = createTextareaAdapter(el)

    const overlay = document.querySelector('.fw-mirror-overlay') as HTMLDivElement
    expect(overlay.style.position).toBe('absolute')
    expect(overlay.style.top).toBe('0px')
    expect(overlay.style.left).toBe('0px')
    expect(overlay.style.pointerEvents).toBe('none')
    expect(overlay.style.overflow).toBe('hidden')
    expect(overlay.style.color).toBe('transparent')
    expect(overlay.style.background).toContain('transparent')

    adapter.dispose()
  })
})

// Finding 24: the overlay's scroll position is synced once right after the
// first render, not only on the textarea's own first 'scroll' event — a
// textarea can already be scrolled at creation time.
describe('createTextareaAdapter: initial scroll sync', () => {
  it('syncs the overlay scroll position at creation, before any scroll event', () => {
    el.scrollTop = 42
    el.scrollLeft = 7

    const adapter = createTextareaAdapter(el)

    const overlay = document.querySelector('.fw-mirror-overlay') as HTMLDivElement
    expect(overlay.scrollTop).toBe(42)
    expect(overlay.scrollLeft).toBe(7)

    adapter.dispose()
  })
})

describe('createTextareaAdapter: flashFinding', () => {
  // Finding 22: a finding id containing a CSS-special character (a colon or
  // bracket, both meaningful in selector syntax) must not throw when it's
  // interpolated into the attribute selector.
  it('CSS.escape()s the id before building the attribute selector', () => {
    const adapter = createTextareaAdapter(el)
    const trickyId = 'f:1[x]'
    adapter.setMarkings([{ id: trickyId, from: 4, to: 9, severity: 'error', category: 'spelling' }])

    expect(() => adapter.flashFinding(trickyId)).not.toThrow()
    const mark = document.querySelector(`[data-finding-ids="${CSS.escape(trickyId)}"]`)
    expect(mark?.className).toContain('fw-mark-flash')

    adapter.dispose()
  })

  it('pulses the fw-mark-flash class on the matching mark, then removes it', () => {
    vi.useFakeTimers()
    const adapter = createTextareaAdapter(el)
    adapter.setMarkings([{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }])

    adapter.flashFinding('f1')
    const mark = document.querySelector('[data-finding-ids="f1"]')
    expect(mark?.className).toContain('fw-mark-flash')

    // Not vi.runAllTimers(): the adapter now also holds a recurring
    // position-drift setInterval (F5) that reschedules itself forever, which
    // runAllTimers() would spin on until vitest's own infinite-loop guard
    // aborts it. runOnlyPendingTimers() fires everything currently queued
    // (including that interval's next tick) exactly once, which is enough to
    // also fire the one-shot flash timeout under test here.
    vi.runOnlyPendingTimers()
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

// Part A / Task 6 (B43 C2): host-page overlay positioning. The overlay is
// `position: absolute; top: 0; left: 0`, which resolves against its
// CONTAINING BLOCK, not necessarily the field's own position — on an
// arbitrary host page (no simulator.css wrapper), self-correct by a
// MEASURED rect delta instead. happy-dom performs no real layout, so
// getBoundingClientRect is stubbed directly to exercise the delta math.
describe('createTextareaAdapter: host-page overlay positioning (measured rect delta)', () => {
  // Captured ONCE, at describe-body evaluation time (before any test in this
  // file has had a chance to stub it) — NOT re-captured per stubRects() call.
  // The convergence test below calls stubRects() twice in the same test; if
  // "the real original" were re-read from the prototype on the second call,
  // it would capture the FIRST call's stub instead of the true original,
  // and afterEach would then leave the prototype poisoned with that stub for
  // every later test in this file that creates a div and measures its rect.
  const realDivGetBoundingClientRect = HTMLDivElement.prototype.getBoundingClientRect

  afterEach(() => {
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: realDivGetBoundingClientRect,
      configurable: true,
    })
  })

  // Stubs getBoundingClientRect on `el` directly (it already exists) and on
  // HTMLDivElement.prototype (the overlay doesn't exist yet — it's created
  // inside createTextareaAdapter — so only a div created during this test
  // can pick it up; el is a textarea and is unaffected by it). Safe to call
  // more than once per test (e.g. to change the stubbed rects mid-test) —
  // restoration is always to the describe-scoped real original above, never
  // to whatever the prototype happened to hold at call time.
  function stubRects(elRect: { top: number; left: number }, overlayRect: { top: number; left: number }) {
    const fakeRect = (r: { top: number; left: number }) =>
      ({ top: r.top, left: r.left, right: 0, bottom: 0, width: 0, height: 0, x: r.left, y: r.top, toJSON() {} }) as DOMRect
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => fakeRect(elRect),
      configurable: true,
    })
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: () => fakeRect(overlayRect),
      configurable: true,
    })
  }

  it('shifts the overlay by the delta between the field rect and the fresh overlay rect', () => {
    stubRects({ top: 108, left: 8 }, { top: 100, left: 0 })

    const adapter = createTextareaAdapter(el)

    // Queried via el.previousElementSibling (not document.querySelector),
    // which is robust to any other .fw-mirror-overlay left in the document
    // by an unrelated test — matches the "beforebegin" insertion contract
    // exactly.
    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.top).toBe('8px')
    expect(overlay.style.left).toBe('8px')

    adapter.dispose()
  })

  it('a second sync with equal rects leaves the overlay position unchanged (convergence)', () => {
    stubRects({ top: 108, left: 8 }, { top: 100, left: 0 })

    const captured: { cb: (() => void) | null } = { cb: null }
    const OriginalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    class StubResizeObserver {
      constructor(cb: () => void) {
        captured.cb = cb
      }
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
    }
    ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver

    const adapter = createTextareaAdapter(el)
    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.top).toBe('8px')
    expect(overlay.style.left).toBe('8px')

    // Real layout would now report the overlay's rect as equal to the
    // field's (it has moved to sit exactly on top of it) — simulate that by
    // updating the stub before the resize-triggered re-sync.
    stubRects({ top: 108, left: 8 }, { top: 108, left: 8 })
    captured.cb?.()

    expect(overlay.style.top).toBe('8px')
    expect(overlay.style.left).toBe('8px')

    adapter.dispose()
    ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = OriginalResizeObserver
  })

  // Regression pin: the convergence test above calls stubRects() TWICE in
  // the same test. If afterEach restored to whatever stubRects() last
  // captured as "the original" (re-read from the prototype on each call,
  // rather than a single describe-scoped capture), it would restore to the
  // FIRST call's stub instead of the true original — poisoning every later
  // test in this file that measures a fresh div's rect. Runs last in this
  // describe block, right after the double-stubbing test, to catch exactly
  // that ordering.
  it('does not leak the getBoundingClientRect stub onto a later, unrelated div', () => {
    const probe = document.createElement('div')
    document.body.appendChild(probe)

    const rect = probe.getBoundingClientRect()

    expect(rect.top).toBe(0)
    expect(rect.left).toBe(0)
    probe.remove()
  })
})

// Copilot round 1 (B43 C2), finding F5: ResizeObserver only reports the
// field's own SIZE changing; a same-sized field that MOVES (a banner above
// it finishes loading, a sibling expands) desyncs the overlay with no
// scroll or resize-of-the-field event to catch it. Two best-effort nets:
// a window 'resize' listener, and a low-frequency safety interval that only
// runs while marks are on screen.
describe('createTextareaAdapter: position-drift re-sync (window resize + safety interval)', () => {
  // el is a fresh element per test (beforeEach above), so only the shared
  // HTMLDivElement.prototype stub needs restoring — the el-level stub below
  // is a per-instance own-property assignment, discarded with the element.
  const realDivGetBoundingClientRect = HTMLDivElement.prototype.getBoundingClientRect

  afterEach(() => {
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: realDivGetBoundingClientRect,
      configurable: true,
    })
  })

  function stubRects(elRect: { top: number; left: number }, overlayRect: { top: number; left: number }) {
    const fakeRect = (r: { top: number; left: number }) =>
      ({ top: r.top, left: r.left, right: 0, bottom: 0, width: 0, height: 0, x: r.left, y: r.top, toJSON() {} }) as DOMRect
    el.getBoundingClientRect = () => fakeRect(elRect)
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: () => fakeRect(overlayRect),
      configurable: true,
    })
  }

  it('a window resize event re-syncs the overlay geometry', () => {
    stubRects({ top: 108, left: 8 }, { top: 100, left: 0 })
    const adapter = createTextareaAdapter(el)
    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.top).toBe('8px')

    // The field moved (its containing block reflowed) without resizing or
    // scrolling — only a window resize fires here.
    stubRects({ top: 250, left: 8 }, { top: 108, left: 8 })
    window.dispatchEvent(new Event('resize'))

    expect(overlay.style.top).toBe('150px')
    adapter.dispose()
  })

  it('the safety interval re-syncs while marks are displayed, but not while none are shown', () => {
    vi.useFakeTimers()
    stubRects({ top: 108, left: 8 }, { top: 100, left: 0 })
    const adapter = createTextareaAdapter(el)
    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.top).toBe('8px')

    // No marks displayed yet: the field moves, but the interval must not
    // re-sync for an overlay with nothing worth re-syncing.
    stubRects({ top: 250, left: 8 }, { top: 108, left: 8 })
    vi.advanceTimersByTime(1000)
    expect(overlay.style.top).toBe('8px')

    // A mark is now on screen: the same drift must get caught by the next
    // interval tick.
    adapter.setMarkings([{ id: 'f1', from: 0, to: 3, severity: 'error', category: 'spelling' }])
    vi.advanceTimersByTime(1000)
    expect(overlay.style.top).toBe('150px')

    // Marks cleared again: a further drift must stop being re-synced.
    adapter.clearMarkings()
    stubRects({ top: 400, left: 8 }, { top: 150, left: 8 })
    vi.advanceTimersByTime(1000)
    expect(overlay.style.top).toBe('150px')

    adapter.dispose()
    vi.useRealTimers()
  })

  it('dispose() removes the window resize listener and clears the safety interval', () => {
    vi.useFakeTimers()
    stubRects({ top: 108, left: 8 }, { top: 100, left: 0 })
    const adapter = createTextareaAdapter(el)
    const overlay = el.previousElementSibling as HTMLDivElement
    adapter.setMarkings([{ id: 'f1', from: 0, to: 3, severity: 'error', category: 'spelling' }])
    expect(overlay.style.top).toBe('8px')

    adapter.dispose()
    stubRects({ top: 250, left: 8 }, { top: 108, left: 8 })
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(5000)

    // Neither mechanism touches the (now-disposed, detached) overlay.
    expect(overlay.style.top).toBe('8px')
    vi.useRealTimers()
  })

  // Copilot round 4 (closing sweep), F2: once syncBackground() has written
  // its own inline 'transparent' override, that inline value beats any
  // stylesheet rule in the cascade — so a naive re-read would see its own
  // prior write forever, never a host theme switch that only changes the
  // UNDERLYING (stylesheet-derived) color. The fix temporarily clears the
  // override before reading computed style, so the read is unmasked.
  it('the 1s background re-sync reads the underlying computed value (not its own prior override), ' +
    'so a host theme switch reaches the overlay', () => {
    vi.useFakeTimers()
    const realGetComputedStyle = window.getComputedStyle
    let underlyingColor = 'rgb(10, 20, 30)'
    // A getComputedStyle stand-in that, for `el` only, always answers with
    // the current "stylesheet-derived" color regardless of el's own inline
    // value — modeling a real browser's cascade for a THEME class the test
    // doesn't need to actually construct, while every other property still
    // passes through to the real computed style so position/z-index/
    // background-image reads elsewhere in the module are unaffected.
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((target, pseudo) => {
      const real = realGetComputedStyle(target, pseudo ?? undefined)
      if (target !== el) return real
      // Mimics real cascade precedence: an inline value (present) always
      // wins the computed read, exactly like a real browser — only when the
      // field's OWN inline value is cleared does the "stylesheet-derived"
      // underlyingColor show through. This is what makes the stub able to
      // catch the masking bug: an unfixed syncBackground() never clears the
      // inline override before reading, so it would keep reading its own
      // prior 'transparent' write back forever instead of underlyingColor.
      return {
        position: real.position,
        zIndex: real.zIndex,
        backgroundColor: el.style.backgroundColor || underlyingColor,
        backgroundImage: real.backgroundImage,
        backgroundSize: real.backgroundSize,
        backgroundPosition: real.backgroundPosition,
        backgroundRepeat: real.backgroundRepeat,
        backgroundOrigin: real.backgroundOrigin,
        backgroundClip: real.backgroundClip,
        backgroundAttachment: real.backgroundAttachment,
      } as CSSStyleDeclaration
    })

    try {
      const adapter = createTextareaAdapter(el)
      const overlay = el.previousElementSibling as HTMLDivElement
      expect(overlay.style.backgroundColor).toBe('rgb(10, 20, 30)')
      expect(el.style.backgroundColor).toBe('transparent')

      // Host theme switch: the underlying (stylesheet-derived) color
      // changes while the field's inline value stays the adapter's own
      // 'transparent' override the whole time.
      underlyingColor = 'rgb(40, 50, 60)'
      vi.advanceTimersByTime(1000)

      expect(overlay.style.backgroundColor).toBe('rgb(40, 50, 60)')
      // The flip is transient: the field's own override is back in place
      // synchronously, same tick, so nothing about the field's paint order
      // changes.
      expect(el.style.backgroundColor).toBe('transparent')

      adapter.dispose()
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })

  // F2: the flip above must still respect the existing guard — a host that
  // sets backgroundColor directly (its own re-render, not going through
  // this module) must keep winning permanently, exactly as before this fix.
  it('a host inline backgroundColor change mid-session still wins over the next re-sync tick', () => {
    vi.useFakeTimers()
    const adapter = createTextareaAdapter(el)
    const overlay = el.previousElementSibling as HTMLDivElement

    el.style.backgroundColor = 'rgb(99, 98, 97)'
    vi.advanceTimersByTime(1000)

    // The host's own value is left untouched, and the overlay keeps
    // whatever it last had rather than being clobbered by the interval.
    expect(el.style.backgroundColor).toBe('rgb(99, 98, 97)')
    expect(overlay.style.backgroundColor).not.toBe('rgb(99, 98, 97)')

    adapter.dispose()
    vi.useRealTimers()
  })
})

// Part A / Task 6 (B43 C2): paint order + visibility on an arbitrary host
// page. simulator.css's `.sim-field-wrap textarea` rule already gives the
// simulator's demo field `position: relative; z-index: 1; background:
// transparent` — a real host page never loads that stylesheet, so this
// module must set the load-bearing values itself, inline.
describe('createTextareaAdapter: host-page paint order + visibility', () => {
  it('a statically-positioned field gets position:relative and z-index:1', () => {
    const adapter = createTextareaAdapter(el)

    expect(el.style.position).toBe('relative')
    expect(el.style.zIndex).toBe('1')

    adapter.dispose()
  })

  it('a field with an inline background paints it on the OVERLAY, while the field itself becomes transparent', () => {
    el.style.backgroundColor = 'rgb(255, 0, 0)'

    const adapter = createTextareaAdapter(el)

    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.backgroundColor).toBe('rgb(255, 0, 0)')
    expect(el.style.backgroundColor).toBe('transparent')

    adapter.dispose()
  })

  it('dispose() restores previously-set inline position/z-index/background-color verbatim', () => {
    el.style.position = 'absolute'
    el.style.zIndex = '5'
    el.style.backgroundColor = 'rgb(0, 0, 255)'

    const adapter = createTextareaAdapter(el)
    adapter.dispose()

    expect(el.style.position).toBe('absolute')
    expect(el.style.zIndex).toBe('5')
    expect(el.style.backgroundColor).toBe('rgb(0, 0, 255)')
  })

  it('dispose() restores previously-UNSET inline position/z-index/background-color to empty strings', () => {
    expect(el.style.position).toBe('')
    expect(el.style.zIndex).toBe('')
    expect(el.style.backgroundColor).toBe('')

    const adapter = createTextareaAdapter(el)
    adapter.dispose()

    expect(el.style.position).toBe('')
    expect(el.style.zIndex).toBe('')
    expect(el.style.backgroundColor).toBe('')
  })

  // Copilot round 3, S4: background-COLOR alone wasn't enough — a field with
  // a background-image/gradient still painted it ABOVE the overlay, hiding
  // marks the same way an opaque color used to.
  it('a field with an inline background-image (gradient) paints it on the OVERLAY, while the field itself gets background-image: none', () => {
    el.style.backgroundImage = 'linear-gradient(red, blue)'

    const adapter = createTextareaAdapter(el)

    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.backgroundImage).toBe('linear-gradient(red, blue)')
    expect(el.style.backgroundImage).toBe('none')

    adapter.dispose()
  })

  it('a field with no background-image (computed "none") is left untouched: the overlay gets no background-image of its own', () => {
    const adapter = createTextareaAdapter(el)

    expect(el.style.backgroundImage).toBe('')
    // happy-dom's own CSSOM quirk: overlay.style.background = 'transparent'
    // at creation resets the backgroundImage longhand to the literal string
    // 'initial' rather than resolving it, same family as the position/
    // z-index '' vs 'static'/'auto' quirks documented elsewhere in this
    // module — the load-bearing assertion is that nothing was MOVED onto it.
    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.backgroundImage).not.toContain('gradient')

    adapter.dispose()

    expect(el.style.backgroundImage).toBe('')
  })

  it('dispose() restores a previously-set inline background-image verbatim', () => {
    el.style.backgroundImage = 'linear-gradient(red, blue)'

    const adapter = createTextareaAdapter(el)
    adapter.dispose()

    expect(el.style.backgroundImage).toBe('linear-gradient(red, blue)')
  })

  // Controller ruling (narrowing the plan's original "z-index: 1
  // unconditionally" mandate): a field that already has its own explicit
  // z-index has already chosen where it sits relative to the rest of the
  // host page — promoting it further to 1 could put it below content it
  // was deliberately layered under, so it's left alone. The overlay's own
  // z-index is still always forced to 0 (idempotent with simulator.css's
  // own rule) regardless of which branch the field took.
  it('a field with its own explicit z-index (computed, not "auto") is left untouched; the overlay still gets z-index 0', () => {
    el.style.zIndex = '5'

    const adapter = createTextareaAdapter(el)

    expect(el.style.zIndex).toBe('5')
    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.zIndex).toBe('0')

    adapter.dispose()
  })

  it('a field with computed z-index auto (the default, unset case) is promoted to 1; the overlay gets 0', () => {
    const adapter = createTextareaAdapter(el)

    expect(el.style.zIndex).toBe('1')
    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.zIndex).toBe('0')

    adapter.dispose()
  })
})

// Controller ruling: the plan's original claim that no separate scroll
// re-sync is needed (the overlay "already shares the field's scrolling
// context" as a DOM sibling) is true for PAGE-level scroll but false for an
// INNER scroller — a scrollable ancestor that is itself unpositioned still
// resolves the overlay's containing block as if that ancestor weren't
// scrolled, so scrolling it moves the field but not the overlay. See the
// module comment and syncOverlayGeometry's own comment for the full story.
describe('createTextareaAdapter: document-level scroll re-sync (inner scrollers)', () => {
  const realDivGetBoundingClientRect = HTMLDivElement.prototype.getBoundingClientRect

  afterEach(() => {
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: realDivGetBoundingClientRect,
      configurable: true,
    })
  })

  it('registers a capturing, passive document scroll listener at creation, and removes it on dispose', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const adapter = createTextareaAdapter(el)

    const addCall = addSpy.mock.calls.find(([type]) => type === 'scroll')
    expect(addCall).toBeDefined()
    expect(addCall?.[2]).toMatchObject({ capture: true, passive: true })

    adapter.dispose()

    const removeCall = removeSpy.mock.calls.find(([type]) => type === 'scroll')
    expect(removeCall).toBeDefined()
    // Only the capture flag has to match for removeEventListener to target
    // the same listener — passive is irrelevant to listener identity.
    expect(removeCall?.[2]).toMatchObject({ capture: true })

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('re-syncs the overlay geometry on a document scroll event, throttled to at most one pending rAF', () => {
    const fakeRect = (r: { top: number; left: number }) =>
      ({ top: r.top, left: r.left, right: 0, bottom: 0, width: 0, height: 0, x: r.left, y: r.top, toJSON() {} }) as DOMRect
    let elRect = { top: 0, left: 0 }
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => fakeRect(elRect),
      configurable: true,
    })
    // A realistic (self-consistent) stub: the overlay's measured rect
    // tracks whatever top/left it's CURRENTLY been placed at, as if it
    // really rendered there — mirroring the convergence property the
    // measured-delta approach relies on (a second sync with the rects
    // already equal adds a zero delta), across any number of re-syncs, not
    // just one.
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: function (this: HTMLDivElement) {
        return fakeRect({ top: parseFloat(this.style.top) || 0, left: parseFloat(this.style.left) || 0 })
      },
      configurable: true,
    })

    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })

    const adapter = createTextareaAdapter(el)
    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.top).toBe('0px')

    // An inner (unpositioned) scrollable ancestor scrolls under the field —
    // simulate the field's rect having moved without the overlay's own.
    elRect = { top: -40, left: 0 }
    document.dispatchEvent(new Event('scroll'))
    expect(rafCallbacks).toHaveLength(1)

    // A second scroll before the queued frame has run must not schedule a
    // second rAF — throttled to at most one pending sync.
    document.dispatchEvent(new Event('scroll'))
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks[0](0)
    expect(overlay.style.top).toBe('-40px')

    // Once that frame has run, a further scroll schedules a fresh sync.
    elRect = { top: -60, left: 0 }
    document.dispatchEvent(new Event('scroll'))
    expect(rafCallbacks).toHaveLength(2)
    rafCallbacks[1](0)
    expect(overlay.style.top).toBe('-60px')

    adapter.dispose()
    rafSpy.mockRestore()
  })

  it('a document scroll after dispose() does not schedule a re-sync', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })

    const adapter = createTextareaAdapter(el)
    adapter.dispose()

    document.dispatchEvent(new Event('scroll'))

    expect(rafCallbacks).toHaveLength(0)
    rafSpy.mockRestore()
  })

  it('dispose() cancels a still-pending scroll-triggered sync', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(42)
    const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})

    const adapter = createTextareaAdapter(el)
    document.dispatchEvent(new Event('scroll'))
    adapter.dispose()

    expect(cafSpy).toHaveBeenCalledWith(42)

    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })
})

// Copilot round 2 (B43 C2), S2: getBoundingClientRect() reports
// viewport-space pixels; overlay.style.top/left resolve against the
// overlay's containing-block-space. Under a scaled ancestor those two spaces
// differ by the scale factor, so the measured delta must be divided by it
// before being applied — otherwise the correction over/undershoots (and,
// via the 1s safety interval, oscillates/diverges).
describe('createTextareaAdapter: transform-scale-aware overlay geometry sync', () => {
  const realDivGetBoundingClientRect = HTMLDivElement.prototype.getBoundingClientRect

  afterEach(() => {
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: realDivGetBoundingClientRect,
      configurable: true,
    })
    // I1 (closing sweep): only ever stubbed as an own property directly on
    // HTMLDivElement.prototype (below) — delete it to fall back to the real
    // (inherited, happy-dom-default-0) HTMLElement.prototype getter, same
    // shape as this describe's own getBoundingClientRect restore.
    delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).offsetWidth
    delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).offsetHeight
  })

  function stubRects(
    elRect: { top: number; left: number },
    overlayRect: { top: number; left: number; width: number; height: number },
  ) {
    const fakeElRect = { ...elRect, right: 0, bottom: 0, width: 0, height: 0, x: elRect.left, y: elRect.top, toJSON() { return {} } } as DOMRect
    const fakeOverlayRect = { ...overlayRect, right: 0, bottom: 0, x: overlayRect.left, y: overlayRect.top, toJSON() { return {} } } as DOMRect
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => fakeElRect,
      configurable: true,
    })
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: () => fakeOverlayRect,
      configurable: true,
    })
  }

  // I1 (closing sweep): the scale denominator is the overlay's UNTRANSFORMED
  // layout border box — offsetWidth/offsetHeight — not
  // overlay.style.width/height (see textareaAdapter.ts's own module comment
  // on syncOverlayGeometry for why the latter is wrong). happy-dom's
  // offsetWidth/offsetHeight always default to 0, so every case below that
  // expects a non-1 recovered scale must stub them to the overlay's own
  // true (untransformed) border-box size.
  function stubOverlayOffset(width: number, height: number) {
    Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', { value: width, configurable: true })
    Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', { value: height, configurable: true })
  }

  it('divides the measured delta by the effective scale under a scaled ancestor, landing exactly in one sync', () => {
    // The field's own (unscaled) border box is 200x80 — no padding/border,
    // so its offsetWidth/Height (what the overlay's own offset is stubbed
    // to match) coincide with the computed CSS width/height MIRRORED_PROPS
    // copies onto the overlay. The overlay's ON-SCREEN rect (viewport
    // space, under a 2x-scaled ancestor) reports double that: 400x160.
    el.style.width = '200px'
    el.style.height = '80px'
    stubRects({ top: 216, left: 16 }, { top: 200, left: 0, width: 400, height: 160 })
    stubOverlayOffset(200, 80)

    const adapter = createTextareaAdapter(el)

    const overlay = el.previousElementSibling as HTMLDivElement
    // Unscaled delta would be (216-200, 16-0) = (16, 16) — wrong by 2x under
    // a scale of 2. Dividing by the recovered scale (400/200 = 2, 160/80 =
    // 2) lands exactly on the true, unscaled 8px offset.
    expect(overlay.style.top).toBe('8px')
    expect(overlay.style.left).toBe('8px')

    adapter.dispose()
  })

  it('unscaled behavior is unchanged: a zero-size overlay rect (no real layout, e.g. under test) falls back to a scale of 1', () => {
    stubRects({ top: 108, left: 8 }, { top: 100, left: 0, width: 0, height: 0 })

    const adapter = createTextareaAdapter(el)

    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.top).toBe('8px')
    expect(overlay.style.left).toBe('8px')

    adapter.dispose()
  })

  // I1: a content-box field (the default, and the box model outside the
  // simulator's own `* { box-sizing: border-box }`) with padding/border
  // used to report a PHANTOM scale here even with NO ancestor transform at
  // all. el.style.width/height (100x100, the field's own CONTENT-box size)
  // is what MIRRORED_PROPS copies verbatim onto overlay.style.width/height
  // — the OLD denominator. The overlay's actual on-screen rect (under no
  // transform) equals its own BORDER box: 100 + 24px padding + 2px border =
  // 126 per axis — stubbed both as the rect (stubRects) and as
  // offsetWidth/Height (stubOverlayOffset), matching real layout exactly.
  // OLD code: rawScale = 126 (rect) / 100 (style.width) = 1.26 — a bogus
  // scale with NO transform anywhere, under-applying the measured delta by
  // 21%, so top/left land at ~6.35px, not 8px. FIXED code: rawScale = 126
  // (rect) / 126 (offsetWidth) = 1 — the full, unscaled 8px delta. This is
  // the one case in this describe block where style.width/height and
  // offsetWidth/Height deliberately DIVERGE — every other case here either
  // leaves style.width/height unset (falls back to scale 1 either way) or
  // sets them equal to the offset stub (I1's OWN "no padding/border" case
  // above) precisely so it does NOT exercise this divergence.
  it('a content-box field with padding/border does not produce a phantom scale with no ancestor transform', () => {
    el.style.width = '100px'
    el.style.height = '100px'
    stubRects({ top: 108, left: 8 }, { top: 100, left: 0, width: 126, height: 126 })
    stubOverlayOffset(126, 126)

    const adapter = createTextareaAdapter(el)

    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.style.top).toBe('8px')
    expect(overlay.style.left).toBe('8px')

    adapter.dispose()
  })
})

// Copilot round 2 (B43 C2), S6b: a host page's own bare-element CSS (e.g.
// `span { display: block }`) could shift a mark span out of inline flow,
// desyncing the mirror's wrapped-line layout from the real textarea
// underneath. Every layout-critical property is set inline on the span so
// host CSS — which always loses to an inline style — cannot touch it.
describe('createTextareaAdapter: mark spans carry inline layout neutralizers', () => {
  it('sets display/margin/padding/border/font/letter-spacing/white-space inline on every rendered mark', () => {
    const adapter = createTextareaAdapter(el)
    adapter.setMarkings([{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }])

    const mark = document.querySelector('[data-finding-ids="f1"]') as HTMLElement
    expect(mark.style.display).toBe('inline')
    expect(mark.style.margin).toBe('0px')
    expect(mark.style.padding).toBe('0px')
    expect(mark.style.border).toBe('0px')
    expect(mark.style.font).toBe('inherit')
    expect(mark.style.letterSpacing).toBe('inherit')
    expect(mark.style.whiteSpace).toBe('inherit')

    adapter.dispose()
  })
})

// Copilot round 2 (B43 C2), S6a: the overlay carries the attribute the C2
// browser extension's MARKS_CSS scopes every `.fw-mark*` rule under
// (clients/browser-extension/src/marks.css.ts) — an arbitrary host page's
// own CSS could otherwise restyle any element it happens to give one of
// these (plausibly-colliding) class names via that global stylesheet.
describe('createTextareaAdapter: overlay carries the mark-scoping attribute', () => {
  it('sets data-fw-overlay on the mirror overlay', () => {
    const adapter = createTextareaAdapter(el)

    const overlay = el.previousElementSibling as HTMLDivElement
    expect(overlay.dataset.fwOverlay).toBe('')

    adapter.dispose()
  })
})

// Copilot round 2 (B43 C2), S4: dispose() must restore a property only if
// its CURRENT inline value still equals what the adapter itself wrote — a
// host that legitimately changes one of these mid-session (its own
// re-render, a theme toggle) must not have that change clobbered.
describe('createTextareaAdapter: dispose only restores properties the host has not since changed', () => {
  it('a host mutation to backgroundColor mid-session is left alone by dispose; untouched position/z-index still restore to their pre-session snapshot', () => {
    const adapter = createTextareaAdapter(el)
    expect(el.style.position).toBe('relative')
    expect(el.style.zIndex).toBe('1')
    expect(el.style.backgroundColor).toBe('transparent')

    // The host legitimately re-styles the field mid-session.
    el.style.backgroundColor = 'rgb(10, 20, 30)'

    adapter.dispose()

    // The host's own change is left exactly as the host left it.
    expect(el.style.backgroundColor).toBe('rgb(10, 20, 30)')
    // Properties the host never touched still restore to their pre-session
    // (here: unset) snapshot, exactly as before this fix.
    expect(el.style.position).toBe('')
    expect(el.style.zIndex).toBe('')
  })

  // Copilot round 3, S4: the same guarded-restore shape now also covers
  // background-image.
  it('a host mutation to backgroundImage mid-session wins over restore', () => {
    el.style.backgroundImage = 'linear-gradient(red, blue)'
    const adapter = createTextareaAdapter(el)
    expect(el.style.backgroundImage).toBe('none')

    // The host legitimately re-styles the field mid-session.
    el.style.backgroundImage = 'linear-gradient(green, yellow)'

    adapter.dispose()

    // The host's own change is left exactly as the host left it, not
    // clobbered back to the pre-session snapshot.
    expect(el.style.backgroundImage).toBe('linear-gradient(green, yellow)')
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

  // Finding 23: dispose() clears a still-pending flash timer, nulls
  // changeCb, and removes the input/scroll listeners.
  it('clears a pending flash timer so it never fires after dispose', () => {
    vi.useFakeTimers()
    const adapter = createTextareaAdapter(el)
    adapter.setMarkings([{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }])
    adapter.flashFinding('f1')
    const mark = document.querySelector('[data-finding-ids="f1"]') as HTMLElement
    expect(mark.className).toContain('fw-mark-flash')

    adapter.dispose()

    expect(() => vi.runAllTimers()).not.toThrow()
    // The timer that would have removed the class was cleared, not merely
    // detached-and-ignored — the class is still present on the captured
    // (now-detached) element.
    expect(mark.className).toContain('fw-mark-flash')
    vi.useRealTimers()
  })

  it('removes the input/scroll listeners: further changes do not call the registered onChange callback', () => {
    const adapter = createTextareaAdapter(el)
    const cb = vi.fn()
    adapter.onChange(cb)

    adapter.dispose()
    el.value = 'changed after dispose'
    el.dispatchEvent(new Event('input'))

    expect(cb).not.toHaveBeenCalled()
  })
})
