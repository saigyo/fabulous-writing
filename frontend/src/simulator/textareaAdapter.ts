// Reference FieldAdapter (spec: B43, "Bridge protocol" / C1 embed surface,
// Task 7). Backs the host simulator's demo <textarea> and doubles as the
// blueprint the C2 browser extension's real adapter is lifted from — every
// behavior here is meant to be copy-paste-portable to a live page's own
// <textarea>/<input>, not simulator-specific.
//
// Marking technique: a mirror div sits BEHIND the textarea in paint order,
// holding the same text with `fw-mark-*` spans wrapping finding ranges. The
// textarea itself keeps a transparent background and normal (opaque) text
// color, so the mirror's highlight backgrounds show through underneath the
// real, editable text. The overlay never receives pointer events — it
// exists purely to paint; the textarea stays the sole interactive surface
// (see main.ts's own click handling for "click a finding" instead).
import type { FieldAdapter, MarkingSpan } from '../embed/protocol'
import { SEVERITIES } from '../findings/severity'

const FLASH_MS = 700

// Style properties the mirror must match so wrapped lines land on the exact
// same pixel rows as the textarea's own text — anything affecting layout
// (box model, font metrics, whitespace handling), not paint-only properties
// (color, background).
const MIRRORED_PROPS: (keyof CSSStyleDeclaration)[] = [
  'boxSizing', 'width', 'height',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform',
  'whiteSpace', 'wordWrap', 'wordBreak', 'tabSize',
  // direction/textAlign are layout-affecting here, not paint-only: they
  // decide which edge text starts from and how it's justified within the
  // line box. An RTL or centered textarea whose overlay stayed LTR/
  // left-aligned would place every character at the wrong x-coordinate,
  // so highlights would land under the wrong text entirely.
  'direction', 'textAlign',
  // Layout-affecting, not paint-only: once the textarea's content grows
  // tall enough to show a vertical scrollbar, the space it reserves narrows
  // the available line-wrap width. Without copying these, the overlay (which
  // never scrolls far enough to need its own scrollbar) keeps the full,
  // un-narrowed width and its wrapped lines diverge from the textarea's.
  // scrollbarGutter covers the modern `scrollbar-gutter: stable` case, where
  // the host reserves the gutter even before a scrollbar has appeared.
  'overflowX', 'overflowY', 'scrollbarGutter',
]

function syncOverlayGeometry(el: HTMLTextAreaElement, overlay: HTMLDivElement) {
  const computed = getComputedStyle(el)
  for (const prop of MIRRORED_PROPS) {
    // CSSStyleDeclaration's index signature is string-keyed; every entry in
    // MIRRORED_PROPS names a real longhand, so this is a same-shape copy.
    ;(overlay.style as unknown as Record<string, string>)[prop as string] =
      computed[prop] as string
  }
}

export function createTextareaAdapter(el: HTMLTextAreaElement): FieldAdapter {
  const overlay = document.createElement('div')
  overlay.className = 'fw-mirror-overlay'
  // Finding 29 (portability): set the styles the overlay's correctness
  // DEPENDS on inline, in JS, rather than leaving them to simulator.css —
  // this adapter is the blueprint the C2 browser extension's real adapter
  // gets lifted from, and it will run on arbitrary host pages that never
  // load simulator.css. Without these set unconditionally here, the C2 lift
  // would render a second, fully opaque copy of the host's own text sitting
  // on top of (or stealing clicks from) their page the moment it's created,
  // before any stylesheet of its own is even in the picture. simulator.css
  // keeps only cosmetic mark colors (.fw-mark-*) — nothing load-bearing.
  overlay.style.position = 'absolute'
  overlay.style.top = '0'
  overlay.style.left = '0'
  overlay.style.pointerEvents = 'none'
  overlay.style.overflow = 'hidden'
  overlay.style.color = 'transparent'
  overlay.style.background = 'transparent'
  // The overlay duplicates the textarea's own text purely to paint
  // highlight backgrounds underneath it (see the module comment) — it
  // carries no information a screen reader doesn't already get from the
  // textarea itself, so it must be hidden from assistive tech.
  overlay.setAttribute('aria-hidden', 'true')
  el.insertAdjacentElement('beforebegin', overlay)
  syncOverlayGeometry(el, overlay)

  // Geometry is otherwise captured once at creation time — a host resizing
  // the textarea (a flex/grid layout reflow, a manual drag-resize handle)
  // would leave the mirror painting highlights at stale coordinates.
  // jsdom/happy-dom don't implement ResizeObserver, so this is guarded and
  // simply never fires under test; dispose() still tears it down whenever it
  // ran.
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => syncOverlayGeometry(el, overlay))
    : null
  resizeObserver?.observe(el)

  // Finding 5: a textarea renders one extra, empty line box for a trailing
  // "\n" (the caret can sit on a line below the last character); a
  // `white-space: pre-wrap` div — the overlay's own rendering mode — does
  // NOT (CSS collapses a trailing newline's line box away). Left alone,
  // that one-line height difference desyncs every mark's vertical position
  // from the real text the moment the field ends in a blank line. A single
  // zero-width space appended after the last real text node gives the
  // overlay one more (empty but non-collapsed) line of its own, without
  // being visible or shifting any highlight's horizontal position. happy-dom
  // doesn't lay out text at all, so this has no test that can observe the
  // line-box difference itself — it's covered by exact-content assertions
  // only (the node is present, appended last).
  function appendTrailingNewlineGuard(text: string) {
    if (text.endsWith('\n')) overlay.append(document.createTextNode('​'))
  }

  let changeCb: (() => void) | null = null
  let currentSpans: MarkingSpan[] = []
  // Finding 23: dispose() clears this so a flash that's still pending when
  // the adapter is torn down (a field disconnecting mid-flash) can't fire
  // its classList.remove against a mark whose overlay has already been
  // removed from the DOM.
  let flashTimer: ReturnType<typeof setTimeout> | null = null

  // The backend deliberately permits overlapping findings (different
  // categories/checkers flagging intersecting or nested ranges — see
  // backend/app/checkers/pipeline.py's spans_overlap/drop_duplicates), so a
  // single non-overlapping walk (clamp each span to the previous span's end)
  // would silently destroy any finding fully or partially covered by
  // another. Instead, partition the text at EVERY span boundary; each
  // resulting segment carries every finding that covers it, so a nested or
  // staggered-overlap finding still gets its own addressable (and
  // flashable) DOM node.
  //
  // Copilot round 10: re-filtering every span for every boundary segment
  // was O(F^2) (plus a per-segment array allocation) on every keystroke.
  // Instead, sweep the boundaries once while maintaining an active set:
  // build a start/end event per span, sort once (O(F log F)), then walk the
  // boundaries in order, adding a span to `active` at its start event and
  // removing it at its end event. Between two consecutive boundaries no
  // span's own from/to falls strictly in between (boundaries are exactly
  // the union of every span's from/to plus 0/text.length), so `active`
  // right after processing a boundary's start/end events is exactly the
  // original `covering` set for the segment starting there — a span whose
  // `to` equals this boundary is removed before `active` is read, matching
  // the original `span.to >= end` (not `>`) semantics. `active` is a Map,
  // so same-position start events resolve in the stable sort's (== original
  // array) order, keeping the highest-severity class choice below identical
  // to the old per-segment filter.
  function render() {
    const text = el.value
    overlay.replaceChildren()
    const clamped = currentSpans
      .map((span, index) => ({
        ...span,
        from: Math.max(0, Math.min(span.from, text.length)),
        to: Math.max(0, Math.min(span.to, text.length)),
        index,
      }))
      .filter((span) => span.to > span.from)
    if (clamped.length === 0) {
      overlay.append(document.createTextNode(text))
      appendTrailingNewlineGuard(text)
      return
    }

    type ClampedSpan = (typeof clamped)[number]
    interface SweepEvent { pos: number; kind: 'start' | 'end'; span: ClampedSpan }
    const events: SweepEvent[] = clamped.flatMap((span) => [
      { pos: span.from, kind: 'start' as const, span },
      { pos: span.to, kind: 'end' as const, span },
    ])
    events.sort((a, b) => a.pos - b.pos)

    const boundaries = [...new Set<number>([0, text.length, ...clamped.flatMap((s) => [s.from, s.to])])]
      .sort((a, b) => a - b)

    const active = new Map<number, ClampedSpan>()
    let ei = 0
    let plainFrom: number | null = null
    const flushPlain = (end: number) => {
      if (plainFrom !== null && end > plainFrom) {
        overlay.append(document.createTextNode(text.slice(plainFrom, end)))
      }
      plainFrom = null
    }

    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i]
      const end = boundaries[i + 1]
      while (ei < events.length && events[ei].pos === start) {
        const event = events[ei]
        if (event.kind === 'end') active.delete(event.span.index)
        else active.set(event.span.index, event.span)
        ei++
      }
      if (active.size === 0) {
        if (plainFrom === null) plainFrom = start
        continue
      }
      flushPlain(start)
      const covering = [...active.values()]
      const topSeverity = covering.reduce(
        (best, span) => (SEVERITIES.indexOf(span.severity) < SEVERITIES.indexOf(best) ? span.severity : best),
        covering[0].severity,
      )
      const mark = document.createElement('span')
      mark.className = `fw-mark fw-mark-${topSeverity}`
      mark.dataset.findingIds = covering.map((span) => span.id).join(' ')
      mark.textContent = text.slice(start, end)
      overlay.append(mark)
    }
    flushPlain(text.length)
    appendTrailingNewlineGuard(text)
  }

  function handleInput() {
    render()
    changeCb?.()
  }
  el.addEventListener('input', handleInput)

  function handleScroll() {
    overlay.scrollTop = el.scrollTop
    overlay.scrollLeft = el.scrollLeft
  }
  el.addEventListener('scroll', handleScroll)

  render()
  // Finding 24: sync the overlay's initial scroll position too — a textarea
  // can already be scrolled at creation time (e.g. the field was restored
  // mid-document, or the adapter is created on an element the host had
  // already scrolled before connecting) and the overlay otherwise starts at
  // scrollTop/scrollLeft 0 until the FIRST 'scroll' event, painting marks
  // one full page off from the real, already-scrolled text underneath.
  handleScroll()

  return {
    capabilities: () => ({ mark: 'overlay', replace: 'reliable' }),
    extract: () => el.value,
    onChange(cb) {
      changeCb = cb
    },
    applyReplacement(from, to, insert, expectedText) {
      // Also finding 6: an out-of-range/inverted vector (e.g. a stale
      // request racing a shrink of el.value) must refuse rather than let
      // setRangeText/slice clamp it into mutating the wrong text. This must
      // run BEFORE the expectedText compare below: slice()/setSelectionRange
      // silently clamp/truncate their arguments (a negative from, a NaN, an
      // out-of-bounds to), so a crafted expectedText that happens to match
      // the CLAMPED slice would sail through the compare and mutate at the
      // wrong, clamped position instead of being refused outright.
      if (
        !Number.isInteger(from) || !Number.isInteger(to) ||
        from < 0 || to < from || to > el.value.length
      ) {
        return { ok: false, text: el.value }
      }
      if (el.value.slice(from, to) !== expectedText) {
        return { ok: false, text: el.value }
      }
      const prev = document.activeElement
      const { scrollTop, scrollLeft } = el
      // preventScroll suppresses the default behavior of scrolling the focused
      // element into view, which would jerk the scroll position on every apply
      // in a real host page. The scroll position is manually restored below.
      el.focus({ preventScroll: true })
      el.setSelectionRange(from, to)
      // setRangeText truncates the textarea's native undo stack (measured
      // in Chromium) — every programmatic edit through it collapses undo
      // back to empty, so a user's Ctrl+Z after an applied suggestion wipes
      // their own prior typing too. execCommand('insertText', ...) goes
      // through the same code path a real keystroke/paste would, so it
      // preserves undo; 'reliable' (capabilities() above) rests on THIS
      // path. execCommand fires its own bubbling InputEvent — do not
      // double-dispatch one on success. happy-dom doesn't implement
      // execCommand at all (no such method, not even a falsy stub), so the
      // typeof guard is load-bearing under test, not just defensive; the
      // tests below exercise the fallback branch, which does NOT preserve
      // undo (setRangeText again) — acceptable there and in any other
      // non-browser env, since there is no undo stack to preserve in the
      // first place.
      const inserted =
        typeof document.execCommand === 'function' &&
        document.execCommand('insertText', false, insert)
      if (!inserted) {
        el.setRangeText(insert, from, to, 'end')
        // Must bubble: React/host frameworks delegate their input listeners
        // to the document root, not the element itself — a non-bubbling
        // Event (or InputEvent without bubbles: true) never reaches them.
        el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      }
      el.scrollTop = scrollTop
      el.scrollLeft = scrollLeft
      if (prev instanceof HTMLElement && prev !== el) prev.focus({ preventScroll: true })
      return { ok: true, text: el.value }
    },
    setMarkings(spans) {
      currentSpans = spans
      render()
    },
    clearMarkings() {
      currentSpans = []
      render()
    },
    flashFinding(id) {
      // ~= matches one whitespace-separated token in the attribute, so this
      // finds a covering segment even when the id is one of several a
      // shared (overlapping-findings) segment carries. Finding 22:
      // CSS.escape the id before interpolating it into the selector — a
      // finding id containing a character CSS treats specially (quotes,
      // brackets) would otherwise break out of the attribute-value string
      // and either throw a SyntaxError or, worse, match unintended
      // elements. Server-generated ids are opaque strings, not guaranteed
      // CSS-selector-safe.
      const mark = overlay.querySelector<HTMLElement>(`[data-finding-ids~="${CSS.escape(id)}"]`)
      if (!mark) return
      el.scrollTop = Math.max(0, mark.offsetTop - el.clientHeight / 2)
      overlay.scrollTop = el.scrollTop
      mark.classList.add('fw-mark-flash')
      if (flashTimer !== null) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => {
        flashTimer = null
        mark.classList.remove('fw-mark-flash')
      }, FLASH_MS)
    },
    dispose() {
      el.removeEventListener('input', handleInput)
      el.removeEventListener('scroll', handleScroll)
      resizeObserver?.disconnect()
      if (flashTimer !== null) clearTimeout(flashTimer)
      flashTimer = null
      changeCb = null
      overlay.remove()
    },
  }
}
