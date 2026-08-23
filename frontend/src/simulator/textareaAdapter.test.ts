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

// Part A / Task 6 (B43 C2): host-page overlay positioning. The overlay is
// `position: absolute; top: 0; left: 0`, which resolves against its
// CONTAINING BLOCK, not necessarily the field's own position — on an
// arbitrary host page (no simulator.css wrapper), self-correct by a
// MEASURED rect delta instead. happy-dom performs no real layout, so
// getBoundingClientRect is stubbed directly to exercise the delta math.
describe('createTextareaAdapter: host-page overlay positioning (measured rect delta)', () => {
  let restoreDivRect: (() => void) | null = null

  afterEach(() => {
    restoreDivRect?.()
    restoreDivRect = null
  })

  // Stubs getBoundingClientRect on `el` directly (it already exists) and on
  // HTMLDivElement.prototype (the overlay doesn't exist yet — it's created
  // inside createTextareaAdapter — so only a div created during this test
  // can pick it up; el is a textarea and is unaffected by it).
  function stubRects(elRect: { top: number; left: number }, overlayRect: { top: number; left: number }) {
    const fakeRect = (r: { top: number; left: number }) =>
      ({ top: r.top, left: r.left, right: 0, bottom: 0, width: 0, height: 0, x: r.left, y: r.top, toJSON() {} }) as DOMRect
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => fakeRect(elRect),
      configurable: true,
    })
    const original = HTMLDivElement.prototype.getBoundingClientRect
    Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
      value: () => fakeRect(overlayRect),
      configurable: true,
    })
    restoreDivRect = () => {
      Object.defineProperty(HTMLDivElement.prototype, 'getBoundingClientRect', {
        value: original,
        configurable: true,
      })
    }
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
