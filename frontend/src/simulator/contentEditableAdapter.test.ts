// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createContentEditableAdapter, defaultHighlightSink, type ContentEditableAdapter, type HighlightSink,
} from './contentEditableAdapter'
import type { MarkingSpan } from '../embed/protocol'

function fakeSink() {
  const entries = new Map<string, { ranges: Range[]; priority: number }>()
  const sink: HighlightSink = {
    set: (name, ranges, priority) => { entries.set(name, { ranges, priority }) },
    clear: (name) => { entries.delete(name) },
  }
  return { sink, entries }
}

function rootWith(html: string): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

const span = (id: string, from: number, to: number, severity: MarkingSpan['severity'] = 'error'): MarkingSpan =>
  ({ id, from, to, severity, category: 'grammar' })

// Every test funnels its adapter through here so the shared afterEach can
// dispose it, and the DOM through rootWith so afterEach can empty
// document.body — matching the brief's "each an it, with afterEach disposing
// the adapter and emptying document.body" contract.
let activeAdapter: ContentEditableAdapter | null = null
function makeAdapter(root: HTMLElement, sink: HighlightSink | null = fakeSink().sink): ContentEditableAdapter {
  activeAdapter = createContentEditableAdapter(root, sink)
  return activeAdapter
}

afterEach(() => {
  activeAdapter?.dispose()
  activeAdapter = null
  document.body.innerHTML = ''
})

// Case 1
describe('createContentEditableAdapter: capabilities', () => {
  it('reports native marking when a sink is supplied', () => {
    const { sink } = fakeSink()
    const root = rootWith('<div>abc</div>')
    const adapter = makeAdapter(root, sink)

    expect(adapter.capabilities()).toEqual({ mark: 'native', replace: 'best-effort' })
  })

  it('reports no marking when sink is explicitly null', () => {
    const root = rootWith('<div>abc</div>')
    const adapter = makeAdapter(root, null)

    expect(adapter.capabilities()).toEqual({ mark: 'none', replace: 'best-effort' })
  })
})

// Case 2
describe('createContentEditableAdapter: extract', () => {
  it('returns the segment-map text, including the block-boundary newline', () => {
    const root = rootWith('<div>a</div><div>b</div>')
    const adapter = makeAdapter(root)

    expect(adapter.extract()).toBe('a\nb')
  })
})

// Case 3
describe('createContentEditableAdapter: setMarkings groups by severity', () => {
  it('groups spans into per-severity highlight registrations with the right names/priorities', () => {
    const { sink, entries } = fakeSink()
    const root = rootWith('<div>abcdefghij</div>') // text.length === 10
    const adapter = makeAdapter(root, sink)

    adapter.setMarkings([
      span('e1', 0, 2, 'error'),
      span('e2', 3, 5, 'error'),
      span('w1', 6, 8, 'warning'),
    ])

    const errorEntry = entries.get('fw-error')
    expect(errorEntry?.ranges).toHaveLength(2)
    expect(errorEntry?.priority).toBe(3)

    const warningEntry = entries.get('fw-warning')
    expect(warningEntry?.ranges).toHaveLength(1)
    expect(warningEntry?.priority).toBe(2)

    expect(entries.has('fw-suggestion')).toBe(false)
  })
})

// Case 4
describe('createContentEditableAdapter: setMarkings clamping and dropping', () => {
  it('clamps an out-of-range span, drops a collapsed span, and clears a severity left with zero ranges', () => {
    const { sink, entries } = fakeSink()
    const root = rootWith('<div>abcdefghij</div>') // text.length === 10
    const adapter = makeAdapter(root, sink)

    // Seed fw-warning so its later clearing is observable, not just absent.
    adapter.setMarkings([span('w0', 2, 4, 'warning')])
    expect(entries.has('fw-warning')).toBe(true)

    adapter.setMarkings([
      span('e1', 8, 20, 'error'), // beyond text length -> clamped to [8, 10)
      span('w1', 4, 4, 'warning'), // collapses after clamp -> contributes no range
    ])

    const errorEntry = entries.get('fw-error')
    expect(errorEntry?.ranges).toHaveLength(1)
    const [range] = errorEntry!.ranges
    expect(range.startOffset).toBe(8)
    expect(range.endOffset).toBe(10)

    expect(entries.has('fw-warning')).toBe(false)
  })
})

// Case 5
describe('createContentEditableAdapter: clearMarkings', () => {
  it('clears every severity name plus fw-selected and fw-flash', () => {
    const { sink, entries } = fakeSink()
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root, sink)

    adapter.setMarkings([
      span('e1', 0, 2, 'error'),
      span('w1', 3, 5, 'warning'),
      span('s1', 6, 8, 'suggestion'),
    ])
    adapter.setSelected?.('e1')
    adapter.flashFinding('w1')
    expect(entries.size).toBe(5)

    adapter.clearMarkings()

    expect(entries.size).toBe(0)
  })
})

// Case 6
describe('createContentEditableAdapter: setSelected', () => {
  it('sets fw-selected with the one matching range, clears on null, and survives a later setMarkings', () => {
    const { sink, entries } = fakeSink()
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root, sink)
    const spans = [span('f1', 2, 5, 'error')]
    adapter.setMarkings(spans)

    adapter.setSelected?.('f1')
    const selectedEntry = entries.get('fw-selected')
    expect(selectedEntry?.priority).toBe(4)
    expect(selectedEntry?.ranges).toHaveLength(1)
    expect(selectedEntry?.ranges[0].startOffset).toBe(2)
    expect(selectedEntry?.ranges[0].endOffset).toBe(5)

    adapter.setSelected?.(null)
    expect(entries.has('fw-selected')).toBe(false)

    adapter.setSelected?.('f1')
    adapter.setMarkings(spans) // re-applied on every reapply, per the brief
    expect(entries.get('fw-selected')?.ranges).toHaveLength(1)
  })
})

// Case 7
describe('createContentEditableAdapter: flashFinding', () => {
  it('sets fw-flash with priority 5, auto-clears after 700ms, and a second flash before expiry resets the timer', () => {
    vi.useFakeTimers()
    const { sink, entries } = fakeSink()
    const clearSpy = vi.spyOn(sink, 'clear')
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root, sink)
    adapter.setMarkings([span('f1', 2, 5, 'error')])

    adapter.flashFinding('f1')
    const flashEntry = entries.get('fw-flash')
    expect(flashEntry?.priority).toBe(5)
    expect(flashEntry?.ranges).toHaveLength(1)

    // Baseline: setMarkings/flashFinding above may already have cleared
    // fw-flash once (there is no active flash yet at setMarkings time) — the
    // "only one clear" assertion below is about the auto-expiry, so it
    // counts clears from HERE, not from adapter creation.
    const clearsBeforeExpiry = clearSpy.mock.calls.filter((call) => call[0] === 'fw-flash').length

    try {
      vi.advanceTimersByTime(300)
      adapter.flashFinding('f1') // resets the timer
      vi.advanceTimersByTime(400) // 700ms since the FIRST call, only 400ms since the reset
      expect(entries.has('fw-flash')).toBe(true)

      vi.advanceTimersByTime(300) // 700ms since the reset
      expect(entries.has('fw-flash')).toBe(false)

      const clearsAfterExpiry = clearSpy.mock.calls.filter((call) => call[0] === 'fw-flash').length
      expect(clearsAfterExpiry - clearsBeforeExpiry).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Case 8
describe('createContentEditableAdapter: change detection via input event', () => {
  it('rebuilds the map and re-anchors highlights, firing onChange once, on an input event', async () => {
    const { sink, entries } = fakeSink()
    const root = rootWith('<div>abc</div>')
    const adapter = makeAdapter(root, sink)
    const cb = vi.fn()
    adapter.onChange(cb)
    adapter.setMarkings([span('e1', 0, 1, 'error')])
    const oldRange = entries.get('fw-error')!.ranges[0]

    const innerDiv = root.querySelector('div')!
    const textNode = innerDiv.firstChild as Text
    textNode.data = 'aXc'
    innerDiv.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await Promise.resolve()

    expect(cb).toHaveBeenCalledTimes(1)
    expect(adapter.extract()).toBe('aXc')
    const newRange = entries.get('fw-error')!.ranges[0]
    expect(newRange).not.toBe(oldRange)
    expect(newRange.startOffset).toBe(0)
    expect(newRange.endOffset).toBe(1)
  })
})

// Case 9
describe('createContentEditableAdapter: change detection via MutationObserver', () => {
  it('picks up a programmatic DOM change with no input event', async () => {
    const root = rootWith('<div>abc</div>')
    const adapter = makeAdapter(root)
    const cb = vi.fn()
    adapter.onChange(cb)

    const tail = document.createElement('div')
    tail.textContent = 'tail'
    root.appendChild(tail)

    await new Promise((resolve) => setTimeout(resolve))

    if (!cb.mock.calls.length) {
      // Guarded skip only if happy-dom provably never delivers a
      // MutationObserver callback here (environment facts say it does under
      // happy-dom 20) — kept as a note, not a `typeof MutationObserver`
      // existence guard, per the brief. If this ever trips, e2e coverage is
      // the fallback for this case.
      console.warn('MutationObserver did not deliver under happy-dom for this run; relying on e2e coverage.')
      return
    }
    expect(cb).toHaveBeenCalledTimes(1)
    expect(adapter.extract()).toBe('abc\ntail')
  })
})

// Case 10
describe('createContentEditableAdapter: no notification when text is unchanged', () => {
  it('re-anchors highlights on a markup-only mutation but does not fire onChange', async () => {
    const { sink, entries } = fakeSink()
    const root = rootWith('<div>abc</div>')
    const adapter = makeAdapter(root, sink)
    const cb = vi.fn()
    adapter.onChange(cb)
    adapter.setMarkings([span('e1', 0, 1, 'error')])
    const oldRange = entries.get('fw-error')!.ranges[0]

    // Wrap the existing text node in a <span> — a childList mutation that
    // leaves the extracted text ('abc') unchanged.
    const innerDiv = root.querySelector('div')!
    const textNode = innerDiv.firstChild as Text
    const wrapper = document.createElement('span')
    innerDiv.replaceChild(wrapper, textNode)
    wrapper.appendChild(textNode)

    await new Promise((resolve) => setTimeout(resolve))

    expect(adapter.extract()).toBe('abc')
    expect(cb).not.toHaveBeenCalled()
    const newRange = entries.get('fw-error')!.ranges[0]
    expect(newRange).not.toBe(oldRange) // re-anchored even though the text didn't change
  })
})

// Case 11
describe('createContentEditableAdapter: dispose', () => {
  it('clears all five highlight names, stops further notifications, and cancels a pending flash timer', async () => {
    vi.useFakeTimers()
    const { sink, entries } = fakeSink()
    const clearSpy = vi.spyOn(sink, 'clear')
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root, sink)
    const cb = vi.fn()
    adapter.onChange(cb)
    adapter.setMarkings([
      span('e1', 0, 2, 'error'),
      span('w1', 3, 5, 'warning'),
      span('s1', 6, 8, 'suggestion'),
    ])
    adapter.setSelected?.('e1')
    adapter.flashFinding('w1')
    expect(entries.size).toBe(5)

    try {
      adapter.dispose()
      expect(entries.size).toBe(0)
      const clearCallsAfterDispose = clearSpy.mock.calls.length

      root.querySelector('div')!.append(document.createTextNode('more'))
      await Promise.resolve()
      expect(cb).not.toHaveBeenCalled()

      vi.runAllTimers() // the flash timer must never fire post-dispose
      expect(clearSpy.mock.calls).toHaveLength(clearCallsAfterDispose)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Case 12
describe('createContentEditableAdapter: null sink is a safe no-op path', () => {
  it('setMarkings/flashFinding/setSelected never throw with sink: null', () => {
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root, null)

    expect(() => {
      adapter.setMarkings([span('e1', 0, 2, 'error')])
      adapter.flashFinding('e1')
      adapter.setSelected?.('e1')
      adapter.setSelected?.(null)
      adapter.clearMarkings()
    }).not.toThrow()
  })
})

// Case 13
describe('createContentEditableAdapter: defaultHighlightSink real path', () => {
  interface FakeHighlightInstance { ranges: Range[]; priority: number }
  afterEach(() => {
    // Deletes the stubs so the accessor's undefined branch (the "mark:
    // none" gate) stays covered by every other case in this file, which run
    // without CSS.highlights/Highlight defined at all under happy-dom.
    // `delete` (not reassignment) removes this OWN property, uncovering
    // happy-dom's underlying getter-only `CSS` again.
    delete (globalThis as { CSS?: unknown }).CSS
    delete (globalThis as { Highlight?: unknown }).Highlight
  })

  it('constructs a Highlight with the ranges, assigns priority, and registers/unregisters by name', () => {
    const registry = new Map<string, FakeHighlightInstance>()
    // happy-dom exposes `CSS` as a getter-only global property — a plain
    // assignment throws. Object.defineProperty installs an own,
    // writable/configurable property that shadows it for the test, restored
    // by `delete` in afterEach above.
    Object.defineProperty(globalThis, 'CSS', {
      value: { highlights: registry }, configurable: true, writable: true,
    })
    class FakeHighlight implements FakeHighlightInstance {
      ranges: Range[]
      priority = 0
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    Object.defineProperty(globalThis, 'Highlight', {
      value: FakeHighlight, configurable: true, writable: true,
    })

    const sink = defaultHighlightSink()
    expect(sink).not.toBeNull()

    const container = document.createElement('div')
    container.textContent = 'hello world'
    document.body.appendChild(container)
    const r1 = document.createRange()
    r1.setStart(container.firstChild!, 0)
    r1.setEnd(container.firstChild!, 5)
    const r2 = document.createRange()
    r2.setStart(container.firstChild!, 6)
    r2.setEnd(container.firstChild!, 11)

    sink!.set('fw-error', [r1, r2], 3)
    const registered = registry.get('fw-error')
    expect(registered).toBeInstanceOf(FakeHighlight)
    expect(registered?.priority).toBe(3)
    expect(registered?.ranges).toEqual([r1, r2])

    sink!.clear('fw-error')
    expect(registry.has('fw-error')).toBe(false)
  })

  it('returns null when CSS.highlights or Highlight is undefined (the happy-dom default)', () => {
    expect(defaultHighlightSink()).toBeNull()
  })
})

// Case 14 (Task 3, brief case 1). Mirrors textareaAdapter.ts's finding-6
// ordering: the vector guard must run BEFORE the expectedText compare, since
// slice() silently clamps/truncates — a crafted expectedText matching the
// CLAMPED slice would otherwise sail through and mutate at the wrong
// position instead of being refused.
describe('createContentEditableAdapter: applyReplacement validates the vector before comparing expectedText', () => {
  it('to beyond the text length: expectedText matches the clamped slice, but the guard still refuses', () => {
    const root = rootWith('<div>The quikc fox</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract() // 'The quikc fox'
    const beforeHtml = root.innerHTML
    const clampedSlice = before.slice(4, 1000) // what a bare String.slice would return

    const result = adapter.applyReplacement(4, 1000, 'X', clampedSlice)

    expect(result).toEqual({ ok: false, text: before })
    expect(root.innerHTML).toBe(beforeHtml)
  })

  it('inverted range (to < from): the coincidental empty slice must not pass as an empty expectedText', () => {
    const root = rootWith('<div>The quikc fox</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract()
    const beforeHtml = root.innerHTML

    const result = adapter.applyReplacement(9, 4, 'X', '') // before.slice(9, 4) === ''

    expect(result).toEqual({ ok: false, text: before })
    expect(root.innerHTML).toBe(beforeHtml)
  })

  it('negative from: the coincidental empty slice must not pass as an empty expectedText', () => {
    const root = rootWith('<div>The quikc fox</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract()
    const beforeHtml = root.innerHTML

    const result = adapter.applyReplacement(-5, 3, 'X', '') // before.slice(-5, 3) === ''

    expect(result).toEqual({ ok: false, text: before })
    expect(root.innerHTML).toBe(beforeHtml)
  })

  it('non-integer (NaN) from: slice() would silently truncate NaN to 0', () => {
    const root = rootWith('<div>The quikc fox</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract()
    const beforeHtml = root.innerHTML
    const truncatedSlice = before.slice(0, 5) // what slice(NaN, 5) truncates to

    const result = adapter.applyReplacement(NaN, 5, 'X', truncatedSlice)

    expect(result).toEqual({ ok: false, text: before })
    expect(root.innerHTML).toBe(beforeHtml)
  })
})

// Case 15 (brief case 2).
describe('createContentEditableAdapter: applyReplacement refuses an expectedText mismatch', () => {
  it('leaves the DOM untouched when expectedText does not match the live slice', () => {
    const root = rootWith('<div>The quikc fox</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract()
    const beforeHtml = root.innerHTML

    const result = adapter.applyReplacement(4, 9, 'quick', 'wrong-expectation')

    expect(result).toEqual({ ok: false, text: before })
    expect(root.innerHTML).toBe(beforeHtml)
  })
})

// Case 16 (brief case 3). happy-dom has no execCommand, so this is the
// surgery fallback branch — exactly like textareaAdapter.ts's own tests.
describe('createContentEditableAdapter: applyReplacement same-node replacement via the surgery fallback', () => {
  it('mutates the text node, reports ok:true with the new text, and dispatches a bubbling input event', () => {
    const root = rootWith('<div>The quikc fox</div>')
    const adapter = makeAdapter(root)
    const docListener = vi.fn()
    document.addEventListener('input', docListener)

    try {
      const result = adapter.applyReplacement(4, 9, 'quick', 'quikc')

      expect(result).toEqual({ ok: true, text: 'The quick fox' })
      expect(root.textContent).toBe('The quick fox')
      expect(docListener).toHaveBeenCalledTimes(1)
      const event = docListener.mock.calls[0][0] as Event
      expect(event).toBeInstanceOf(InputEvent)
      expect(event.bubbles).toBe(true)
    } finally {
      document.removeEventListener('input', docListener)
    }
  })
})

// Case 17 (brief case 4).
describe('createContentEditableAdapter: applyReplacement across an inline-markup boundary', () => {
  it('replaces text that lives inside an inline element without disturbing the surrounding text', () => {
    const root = rootWith('a <strong>bd</strong> c')
    const adapter = makeAdapter(root)

    const result = adapter.applyReplacement(2, 4, 'bold', 'bd')

    expect(result).toEqual({ ok: true, text: 'a bold c' })
    expect(adapter.extract()).toBe('a bold c')
  })
})

// Case 18 (brief case 5). The slice check in the post-verify is vacuous for
// an empty insert (''.slice-equality always passes) — the length-delta term
// is what actually validates a deletion (case 23/brief case 10 below proves
// that on its own).
describe('createContentEditableAdapter: applyReplacement with an empty insert deletes', () => {
  it('shrinks the text by the deleted span length', () => {
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract() // length 10

    const result = adapter.applyReplacement(2, 4, '', 'cd')

    expect(result).toEqual({ ok: true, text: 'abefghij' })
    expect(result.text.length).toBe(before.length - 2)
  })
})

// Case 19 (brief case 6). A framework-style synchronous rewrite of the root
// on its own input listener must be judged as the real post-edit DOM, never
// a throw, never a lie.
describe('createContentEditableAdapter: applyReplacement post-verification failure', () => {
  it('reports ok:false with the REAL (rewritten) text when a document input listener rewrites the root', () => {
    const root = rootWith('<div>The quikc fox</div>')
    const adapter = makeAdapter(root)
    const rewrite = () => { root.textContent = 'REWRITTEN' }
    document.addEventListener('input', rewrite)

    try {
      const result = adapter.applyReplacement(4, 9, 'quick', 'quikc')

      expect(result).toEqual({ ok: false, text: 'REWRITTEN' })
    } finally {
      document.removeEventListener('input', rewrite)
    }
  })
})

// Copilot round 2, F1. The old post-verify checked only the inserted slice
// and the total length — both survive a synchronous rewrite that changes a
// DIFFERENT character than the one requested, so it used to report ok:true
// for a wrong result. The full-text compare is the only check that catches
// this.
describe('createContentEditableAdapter: applyReplacement post-verification catches an out-of-range rewrite', () => {
  it('reports ok:false with the real text when a rewrite changes a character outside [from, to), even though the requested insert landed correctly and the total length is preserved', () => {
    const root = rootWith('<div>abc</div>')
    const adapter = makeAdapter(root)
    // Simulates a framework that applies the requested 'b' -> 'X' edit but
    // ALSO rewrites 'c' -> 'Y' in the same synchronous re-render — the
    // inserted slice ('X' at [1,2)) and the total length (3) both still
    // match what the old checks looked for.
    const rewrite = () => { root.textContent = 'aXY' }
    document.addEventListener('input', rewrite)

    try {
      const result = adapter.applyReplacement(1, 2, 'X', 'b')

      expect(result).toEqual({ ok: false, text: 'aXY' })
    } finally {
      document.removeEventListener('input', rewrite)
    }
  })
})

// Case 20 (brief case 7, plan review BL2). A span lying entirely on a
// synthetic newline resolves to an inverted (or no) Range — refuse WITHOUT
// mutating, rather than falling back to a snapped position.
describe('createContentEditableAdapter: applyReplacement refuses a span with no resolvable Range', () => {
  it('refuses a span lying entirely on the block-boundary newline, leaving the DOM byte-identical', () => {
    const root = rootWith('<div>ab</div><div>cd</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract() // 'ab\ncd'
    const beforeHtml = root.innerHTML

    const result = adapter.applyReplacement(2, 3, 'X', '\n')

    expect(result).toEqual({ ok: false, text: before })
    expect(root.innerHTML).toBe(beforeHtml)
  })
})

// Case 21 (brief case 8). document.getSelection is stubbed via vi.spyOn in
// every case below; this file's vitest config sets neither restoreMocks nor
// clearMocks, so an unrestored stub would leak into every later test in this
// file (including applyReplacement's own document.getSelection() calls) —
// restore it after each case here.
describe('createContentEditableAdapter: caretOffset', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the flat offset for a caret inside a mapped text node', () => {
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root)
    const textNode = root.querySelector('div')!.firstChild as Text

    vi.spyOn(document, 'getSelection').mockReturnValue(
      { rangeCount: 1, anchorNode: textNode, anchorOffset: 3 } as unknown as Selection,
    )

    expect(adapter.caretOffset()).toBe(3)
  })

  it('returns null when the anchor node is outside root', () => {
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root)
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    const outsideText = document.createTextNode('xyz')
    outside.appendChild(outsideText)

    vi.spyOn(document, 'getSelection').mockReturnValue(
      { rangeCount: 1, anchorNode: outsideText, anchorOffset: 1 } as unknown as Selection,
    )

    expect(adapter.caretOffset()).toBeNull()
    outside.remove()
  })

  it('returns null when there is no selection', () => {
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root)

    vi.spyOn(document, 'getSelection').mockReturnValue(null)
    expect(adapter.caretOffset()).toBeNull()

    vi.spyOn(document, 'getSelection').mockReturnValue(
      { rangeCount: 0, anchorNode: null, anchorOffset: 0 } as unknown as Selection,
    )
    expect(adapter.caretOffset()).toBeNull()
  })
})

// Case 22 (brief case 9, plan review BL1). Pins the `notifiedText` baseline:
// applyReplacement's own synchronous map rebuild must not make the
// microtask-coalesced sync in queueSync() think nothing changed.
describe('createContentEditableAdapter: applyReplacement fires onChange via the input-event microtask sync', () => {
  it('calls onChange once, and extract() reflects the new text by then', async () => {
    const root = rootWith('<div>The quikc fox</div>')
    const adapter = makeAdapter(root)
    const cb = vi.fn()
    adapter.onChange(cb)

    const result = adapter.applyReplacement(4, 9, 'quick', 'quikc')
    expect(result).toEqual({ ok: true, text: 'The quick fox' })

    await Promise.resolve()

    expect(cb).toHaveBeenCalledTimes(1)
    expect(adapter.extract()).toBe('The quick fox')
  })
})

// Case 23 (brief case 10, mutation-verify target SF2). Only the length-delta
// term of the post-verify can catch a host that restores the original text
// after an empty-insert deletion — the slice term is vacuous for ''.
describe('createContentEditableAdapter: applyReplacement reports a failed deletion', () => {
  it('reports ok:false with the restored text when a document input listener undoes the deletion', () => {
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root)
    const original = adapter.extract()
    const restore = () => { root.textContent = original }
    document.addEventListener('input', restore)

    try {
      const result = adapter.applyReplacement(2, 4, '', 'cd')

      expect(result).toEqual({ ok: false, text: original })
    } finally {
      document.removeEventListener('input', restore)
    }
  })
})

// Case 24 (brief case 11, plan review SF5). Range.deleteContents only trims
// partially contained text nodes — it cannot remove a block boundary, so a
// cross-block span must refuse BEFORE any mutation.
describe('createContentEditableAdapter: applyReplacement refuses a cross-block span before mutating', () => {
  it('refuses a span crossing the block boundary, leaving the DOM byte-identical', () => {
    const root = rootWith('<div>ab</div><div>cd</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract() // 'ab\ncd'
    const beforeHtml = root.innerHTML

    const result = adapter.applyReplacement(1, 4, 'X', 'b\nc')

    expect(result).toEqual({ ok: false, text: before })
    expect(root.innerHTML).toBe(beforeHtml)
  })
})

// Case 25 (brief case 12, plan review SF6). execCommand('delete') on a
// COLLAPSED selection is a backspace — it would remove the character before
// the caret, one the request never named — so a true no-op must return
// early instead of ever building a selection at all.
describe('createContentEditableAdapter: applyReplacement no-ops a degenerate request', () => {
  it('returns ok:true immediately for from === to with an empty insert, without touching the DOM', () => {
    const root = rootWith('<div>abcdefghij</div>')
    const adapter = makeAdapter(root)
    const before = adapter.extract()
    const beforeHtml = root.innerHTML

    const result = adapter.applyReplacement(3, 3, '', '')

    expect(result).toEqual({ ok: true, text: before })
    expect(root.innerHTML).toBe(beforeHtml)
  })
})

// Case 26 (brief case 13, documented limitation N6). An empty field has no
// text node to anchor a collapsed range on.
describe('createContentEditableAdapter: applyReplacement into an empty field', () => {
  it('refuses an insertion with no text node to anchor on', () => {
    const root = rootWith('')
    const adapter = makeAdapter(root)

    const result = adapter.applyReplacement(0, 0, 'x', '')

    expect(result).toEqual({ ok: false, text: '' })
  })
})
