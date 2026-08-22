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

  function render() {
    const text = el.value
    overlay.replaceChildren()
    if (currentSpans.length === 0) {
      overlay.append(document.createTextNode(text))
      return
    }
    const sorted = [...currentSpans].sort((a, b) => a.from - b.from)
    let pos = 0
    for (const span of sorted) {
      const from = Math.max(pos, Math.min(span.from, text.length))
      const to = Math.max(from, Math.min(span.to, text.length))
      if (from > pos) overlay.append(document.createTextNode(text.slice(pos, from)))
      const mark = document.createElement('span')
      mark.className = `fw-mark fw-mark-${span.severity}`
      mark.dataset.findingId = span.id
      mark.textContent = text.slice(from, to)
      overlay.append(mark)
      pos = to
    }
    if (pos < text.length) overlay.append(document.createTextNode(text.slice(pos)))
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
      const mark = overlay.querySelector<HTMLElement>(`[data-finding-id="${id}"]`)
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
