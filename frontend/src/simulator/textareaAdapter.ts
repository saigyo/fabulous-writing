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

  let changeCb: (() => void) | null = null
  let currentSpans: MarkingSpan[] = []

  // The backend deliberately permits overlapping findings (different
  // categories/checkers flagging intersecting or nested ranges — see
  // backend/app/checkers/pipeline.py's spans_overlap/drop_duplicates), so a
  // single non-overlapping walk (clamp each span to the previous span's end)
  // would silently destroy any finding fully or partially covered by
  // another. Instead, partition the text at EVERY span boundary; each
  // resulting segment carries every finding that covers it, so a nested or
  // staggered-overlap finding still gets its own addressable (and
  // flashable) DOM node.
  function render() {
    const text = el.value
    overlay.replaceChildren()
    const clamped = currentSpans
      .map((span) => ({
        ...span,
        from: Math.max(0, Math.min(span.from, text.length)),
        to: Math.max(0, Math.min(span.to, text.length)),
      }))
      .filter((span) => span.to > span.from)
    if (clamped.length === 0) {
      overlay.append(document.createTextNode(text))
      return
    }

    const boundaries = [...new Set<number>([0, text.length, ...clamped.flatMap((s) => [s.from, s.to])])]
      .sort((a, b) => a - b)

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
      const covering = clamped.filter((span) => span.from <= start && span.to >= end)
      if (covering.length === 0) {
        if (plainFrom === null) plainFrom = start
        continue
      }
      flushPlain(start)
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

  return {
    capabilities: () => ({ mark: 'overlay', replace: 'reliable' }),
    extract: () => el.value,
    onChange(cb) {
      changeCb = cb
    },
    applyReplacement(from, to, insert, expectedText) {
      if (el.value.slice(from, to) !== expectedText) {
        return { ok: false, text: el.value }
      }
      el.setRangeText(insert, from, to, 'end')
      // Must bubble: React/host frameworks delegate their input listeners to
      // the document root, not the element itself — a non-bubbling Event
      // (or InputEvent without bubbles: true) never reaches them.
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
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
      // shared (overlapping-findings) segment carries.
      const mark = overlay.querySelector<HTMLElement>(`[data-finding-ids~="${id}"]`)
      if (!mark) return
      el.scrollTop = Math.max(0, mark.offsetTop - el.clientHeight / 2)
      overlay.scrollTop = el.scrollTop
      mark.classList.add('fw-mark-flash')
      setTimeout(() => mark.classList.remove('fw-mark-flash'), FLASH_MS)
    },
    dispose() {
      el.removeEventListener('input', handleInput)
      el.removeEventListener('scroll', handleScroll)
      resizeObserver?.disconnect()
      overlay.remove()
    },
  }
}
