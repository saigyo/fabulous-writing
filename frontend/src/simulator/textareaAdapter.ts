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
//
// Host-page contract (C2 lift): two more load-bearing pieces the simulator
// happens to also satisfy via simulator.css, but that only this module can
// guarantee once it runs on an arbitrary host page that never loads that
// stylesheet:
// - Overlay position (syncOverlayGeometry): the overlay is
//   `position: absolute; top: 0; left: 0`, which lands it at the origin of
//   its CONTAINING BLOCK (the nearest positioned ancestor, or the initial
//   containing block if there is none) — not necessarily the field's own
//   position. The simulator's `.sim-field-wrap` wrapper happens to supply
//   `position: relative`, making that origin coincide with the field; an
//   arbitrary host page usually doesn't, and the field's own
//   offsetTop/offsetLeft can't be used to correct for it either (CSSOM
//   defines offsetParent as `body` for an unpositioned tree, which is not
//   the absolute overlay's actual containing block). Instead,
//   syncOverlayGeometry self-corrects by a MEASURED rect delta between the
//   field and the overlay every time it runs — exact under any containing
//   block/margin/wrapper, and convergent in one step. Page-level scroll
//   needs no extra handling: an absolutely positioned box scrolls with the
//   rest of the document like everything else. An INNER scroller does — a
//   scrollable ancestor that is itself unpositioned still resolves the
//   overlay's containing block exactly as if that ancestor weren't
//   scrolled at all, so scrolling it moves the field but not the overlay.
//   createTextareaAdapter registers a capturing, passive, rAF-throttled
//   document-level `scroll` listener (an inner scroller's own scroll event
//   does not bubble, so only the capture phase sees it) that re-runs
//   syncOverlayGeometry — self-correcting the same way a resize does. In
//   the simulator this listener is inert (no inner scroller, and page
//   scroll needed nothing to begin with), so nothing visibly changes.
// - Paint order + visibility: the field is promoted above the overlay only
//   where it doesn't already have its own explicit stacking position —
//   `position: relative` when computed `static`; `z-index: 1` when
//   computed `auto` (a field with its own explicit z-index has already
//   chosen where it sits relative to the rest of the host page; forcing it
//   to 1 could put it below content it was deliberately layered under) —
//   and the overlay itself always gets an inline `z-index: 0` (idempotent
//   with simulator.css's own `.fw-mirror-overlay` rule). The field is also
//   made background-transparent, after the overlay is given a copy of the
//   field's own (previously opaque, non-transparent) background COLOR to
//   paint instead — matching what simulator.css's `.sim-field-wrap
//   textarea` rule already does for the simulator's own demo field via a
//   stylesheet. Copilot round 3, S4: the same move applies to the field's
//   background IMAGE (a gradient, a data-URI pattern, a themed composer
//   background) — copied onto the overlay and cleared on the field to
//   'none', for the same reason: an opaque color OR image sitting above the
//   overlay would hide every mark just the same. Without either move, a
//   real host field with an opaque background (GitHub's composer, say)
//   would hide every mark; a static-positioned, auto-z-index field would
//   instead have the overlay paint OVER its real text. dispose() restores
//   the four inline values it may have touched on the field (position/
//   z-index/background-color/background-image) verbatim.
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
  // M7 (closing sweep): the loop above just copied the field's own
  // overflowX/overflowY (MIRRORED_PROPS) onto the overlay, which for a
  // field whose computed overflow is `visible` (the CSS default) overwrites
  // the module's own load-bearing `overlay.style.overflow = 'hidden'` set
  // once at creation — the overlay's mark backgrounds are then free to
  // paint outside the field's own box, over the host page. Clipping must
  // hold regardless of the FIELD's own overflow setting, so re-clip
  // whichever axis the copy just widened.
  if (overlay.style.overflowX === 'visible') overlay.style.overflowX = 'hidden'
  if (overlay.style.overflowY === 'visible') overlay.style.overflowY = 'hidden'
  // Host-page overlay position (module comment): the overlay's
  // `top: 0; left: 0` resolves against its CONTAINING BLOCK, which need not
  // coincide with the field's own position on an arbitrary host page.
  // Self-correct by the MEASURED delta between the field's rect and the
  // overlay's own (possibly still-off) rect, added on top of whatever
  // top/left the overlay is currently holding. Exact under any containing
  // block/margin/wrapper, and converges in one step (a second call with the
  // rects now equal adds a zero delta) — which is also what makes this
  // function safe to call from the rAF-throttled document scroll listener
  // below (see the module comment for why that listener exists at all). In
  // the simulator, `.sim-field-wrap` already positions the field's
  // containing block at the wrapper's own origin, so the delta computed
  // here is 0 and nothing visibly moves.
  const fieldRect = el.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  // Copilot round 2 (B43 C2), S2: getBoundingClientRect() reports
  // VIEWPORT-space pixels, but overlay.style.top/left resolve against the
  // overlay's CONTAINING-BLOCK-space (unscaled) coordinate system. Those two
  // spaces coincide only when nothing between the overlay and the viewport
  // carries a CSS `transform: scale(...)` — under a scaled ancestor, a
  // viewport-space delta means a different number of containing-block pixels
  // depending on the scale factor, so applying it unmodified over/
  // undershoots every time. Worse, that error compounds through the 1s
  // safety interval re-sync above: each pass "corrects" by the wrong amount,
  // which oscillates for a scale in (1, 2) and diverges outright above 2.
  // Recover the effective scale by comparing the overlay's just-measured,
  // on-screen rect to its own UNTRANSFORMED layout border box —
  // offsetWidth/offsetHeight, exactly what getBoundingClientRect scales —
  // and divide the delta by it before applying — exact for a pure, uniform
  // scale. Rotation/skew are out of scope: there is no single scalar to
  // divide by, and the module comment above documents this as an accepted
  // limitation, not a bug.
  //
  // I1 (B43 C2 closing sweep): this must NOT be overlay.style.width/height.
  // That holds the used value of the CSS `width`/`height` property (copied
  // from the field's computed style by the MIRRORED_PROPS loop above), which
  // is the border-box size only under `box-sizing: border-box` — under the
  // default `content-box`, a field with padding/border reports a phantom
  // scale (e.g. 126/100 = 1.26 for 12px padding + 1px border) with NO
  // ancestor transform anywhere on the page, under-applying every measured
  // delta by that same fraction. offsetWidth/offsetHeight are always the
  // border-box size regardless of box-sizing, matching what
  // getBoundingClientRect actually scales. NaN/zero (no real layout, e.g.
  // under test, or a not-yet-laid-out overlay — happy-dom returns 0 for
  // offsetWidth) falls back to a scale of 1, which is exactly the old,
  // unscaled behavior.
  const rawScaleX = overlayRect.width / overlay.offsetWidth
  const rawScaleY = overlayRect.height / overlay.offsetHeight
  const scaleX = Number.isFinite(rawScaleX) && rawScaleX !== 0 ? rawScaleX : 1
  const scaleY = Number.isFinite(rawScaleY) && rawScaleY !== 0 ? rawScaleY : 1
  overlay.style.top = `${(parseFloat(overlay.style.top) || 0) + (fieldRect.top - overlayRect.top) / scaleY}px`
  overlay.style.left = `${(parseFloat(overlay.style.left) || 0) + (fieldRect.left - overlayRect.left) / scaleX}px`
}

export function createTextareaAdapter(el: HTMLTextAreaElement): FieldAdapter {
  const overlay = document.createElement('div')
  overlay.className = 'fw-mirror-overlay'
  // Copilot round 2 (B43 C2), S6a: marks the overlay so the C2 browser
  // extension's MARKS_CSS (clients/browser-extension/src/marks.css.ts) can
  // scope every `.fw-mark*` rule under `[data-fw-overlay]` — a host page's
  // own CSS could otherwise restyle any element it happens to give one of
  // these class names (they're generic enough to collide). Setting it here,
  // unconditionally, is shared-file-safe: it's inert for the simulator
  // (simulator.css's own `.fw-mirror-overlay`-scoped selectors don't
  // reference this attribute and need no change).
  overlay.dataset.fwOverlay = ''
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

  // Host-page paint order + visibility (module comment): save the field's
  // own inline position/z-index/background-color BEFORE touching any of
  // them, so dispose() can restore them verbatim (empty string when they
  // were unset). Only coerce `position`/`z-index` when the field doesn't
  // already have its own explicit stacking position — a field that already
  // establishes one (relative/absolute/sticky/fixed position, or an
  // explicit z-index, e.g. the simulator's own `.sim-field-wrap textarea`
  // rule) is left alone; forcing a z-index onto a field that chose its own
  // could put it below host content it was deliberately layered under.
  const savedPosition = el.style.position
  const savedZIndex = el.style.zIndex
  const savedBackgroundColor = el.style.backgroundColor
  const savedBackgroundImage = el.style.backgroundImage
  // M5 (closing sweep): background-image alone isn't fully positioned —
  // background-size/-position/-repeat/-origin/-clip/-attachment decide
  // WHERE and how that image paints. Left uncopied, a composer background
  // like `background: url(icon.svg) no-repeat right 8px center / 16px`
  // moves the icon onto the overlay (below) but renders it tiled at
  // intrinsic size across the whole mirror instead of positioned as the
  // host intended. Saved unconditionally, same shape as savedPosition/
  // savedZIndex above, regardless of whether syncBackground() below ever
  // ends up writing to them.
  const BACKGROUND_IMAGE_LONGHANDS = [
    'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
    'backgroundOrigin', 'backgroundClip', 'backgroundAttachment',
  ] as const
  const savedBackgroundLonghands: Record<(typeof BACKGROUND_IMAGE_LONGHANDS)[number], string> = {
    backgroundSize: el.style.backgroundSize,
    backgroundPosition: el.style.backgroundPosition,
    backgroundRepeat: el.style.backgroundRepeat,
    backgroundOrigin: el.style.backgroundOrigin,
    backgroundClip: el.style.backgroundClip,
    backgroundAttachment: el.style.backgroundAttachment,
  }
  // Copilot round 2 (B43 C2), S4: dispose() must restore a property only if
  // its CURRENT inline value still equals what the adapter itself wrote —
  // otherwise the host legitimately changed it DURING the session (its own
  // re-render, a theme toggle) and dispose reverting it would clobber that
  // change out from under the host. Recording `writtenPosition`/
  // `writtenZIndex` as null below (rather than always tracking a value) also
  // captures the "adapter never touched this property at all" case: when the
  // field already has its own explicit position/z-index, this block doesn't
  // write to it, and dispose (further below) must never restore it either.
  let writtenPosition: string | null = null
  let writtenZIndex: string | null = null
  // happy-dom's getComputedStyle leaves an unset `position` as '' rather
  // than resolving it to its initial value 'static' the way a real browser
  // would — treat both as the static case under test.
  const computedPosition = getComputedStyle(el).position
  if (computedPosition === 'static' || computedPosition === '') {
    writtenPosition = 'relative'
    el.style.position = writtenPosition
  }
  // Same happy-dom quirk as position above: an unset z-index computes to ''
  // there instead of the real initial value 'auto'.
  const computedZIndex = getComputedStyle(el).zIndex
  if (computedZIndex === 'auto' || computedZIndex === '') {
    writtenZIndex = '1'
    el.style.zIndex = writtenZIndex
  }
  // The overlay's own z-index is always forced to 0 — idempotent with
  // simulator.css's own `.fw-mirror-overlay { z-index: 0 }` rule, and
  // correct regardless of whether the field's z-index above just came from
  // us or was already there: either way the overlay must paint below it.
  overlay.style.zIndex = '0'

  // Copilot round 2 (B43 C2), S4 + round 3, S4, folded into one guarded
  // function (M6, closing sweep) so it can run again from the 1s drift
  // interval below, not just once at creation: a field's background can
  // legitimately change DURING a session (a `:focus`/`:hover` composer
  // highlight, a dark/light theme toggle) — a one-shot copy leaves the
  // overlay (and the field, hidden underneath it) visibly pinned to
  // whatever the background was at connect time. Re-running this is safe:
  // each write is itself guarded so a host-changed inline value (the host's
  // OWN script setting el.style.backgroundColor/Image directly, same
  // "legitimately changed it" case dispose() already accounts for) always
  // wins over a re-copy rather than being clobbered, and `written…`
  // is kept up to date every time this DOES write, so dispose()'s own
  // restore guard — which runs after any number of these re-syncs — keeps
  // comparing against the latest value this function actually wrote.
  let writtenBackgroundColor: string | null = null
  let writtenBackgroundImage: string | null = null
  function syncBackground(): void {
    // Skip the copy for happy-dom's '' default AND for a real, fully
    // transparent background ('transparent', or the 'rgba(0, 0, 0, 0)' a
    // real browser resolves either keyword to) — there's nothing
    // meaningful to paint onto the overlay in any of those cases, and
    // assigning '' would clear the overlay's own `background: transparent`
    // shorthand entirely instead of leaving it at its already-transparent
    // default. "Always written" on the FIELD side (unlike position/z-index
    // above, this has no "field already has its own value" branch to
    // skip) — but only while the field's current inline value still
    // matches what this function itself last wrote; once the host sets its
    // own value directly, that write wins and this stops touching it.
    if (writtenBackgroundColor === null || el.style.backgroundColor === writtenBackgroundColor) {
      const computedBackgroundColor = getComputedStyle(el).backgroundColor
      const computedBackgroundIsTransparent =
        computedBackgroundColor === '' ||
        computedBackgroundColor === 'transparent' ||
        computedBackgroundColor === 'rgba(0, 0, 0, 0)'
      if (!computedBackgroundIsTransparent) {
        overlay.style.backgroundColor = computedBackgroundColor
      }
      writtenBackgroundColor = 'transparent'
      el.style.backgroundColor = writtenBackgroundColor
    }

    // Copilot round 3, S4: background-COLOR alone isn't the whole
    // paint-order story — a field styled with a background-image or
    // gradient (`linear-gradient(...)`, a data-URI pattern, GitHub's own
    // themed composer backgrounds) still painted that image ABOVE the
    // overlay, hiding marks under it exactly the way an opaque
    // background-color used to. Same fix, same shape as background-color
    // just above: copy the field's COMPUTED background-image onto the
    // overlay (so it still paints, just now behind the real text instead
    // of on top of the marks) and clear the field's own to 'none' so only
    // the overlay's copy shows through. Unlike background-color, this is
    // guarded like position/z-index above (a null `writtenBackgroundImage`
    // means "never touched") rather than "always written": there is
    // nothing to move and nothing to clear when the computed value is
    // already 'none', so skip both the overlay copy and the field mutation
    // entirely in that case — which also means an initially-image-less
    // field whose OWN inline backgroundImage this function has therefore
    // never touched keeps reflecting the host's real, live computed value
    // on every re-sync, so a background-image gained mid-session (M6) is
    // still picked up here the same way a background-color change is.
    if (writtenBackgroundImage === null || el.style.backgroundImage === writtenBackgroundImage) {
      const computedBackgroundImage = getComputedStyle(el).backgroundImage
      // happy-dom quirk parity with position/z-index above: an unset
      // background-image computes to '' there instead of the real initial
      // value 'none'.
      const computedBackgroundImageIsNone = computedBackgroundImage === '' || computedBackgroundImage === 'none'
      if (!computedBackgroundImageIsNone) {
        overlay.style.backgroundImage = computedBackgroundImage
        writtenBackgroundImage = 'none'
        el.style.backgroundImage = writtenBackgroundImage
        // M5: the longhands that position/size/tile the image, copied
        // alongside it (same guard/moment — nothing to position when
        // there's no image, so this only ever runs together with the
        // image write above) and cleared on the field to the CSS-wide
        // `initial` keyword (valid for every longhand, unlike hardcoding
        // each property's own distinct initial value) since they have no
        // visible effect on the field now that its own image is gone.
        for (const prop of BACKGROUND_IMAGE_LONGHANDS) {
          overlay.style[prop] = getComputedStyle(el)[prop]
          el.style[prop] = 'initial'
        }
      }
    }
  }
  syncBackground()

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

  // Host-page overlay position (module comment): a resize observer alone
  // only catches the field's OWN size changing — an unpositioned scrollable
  // ANCESTOR scrolling underneath the field desyncs the overlay just the
  // same, and that scroll event does not bubble, so a document-level
  // listener needs the capture phase to see it at all. rAF-throttled to at
  // most one re-sync per animation frame no matter how many scroll events
  // fire in between — syncOverlayGeometry's measured-delta approach makes
  // every re-sync self-correcting regardless of how many were coalesced, so
  // this is purely a perf concern, not a correctness one.
  let pendingScrollSync: number | null = null
  function handleDocumentScroll() {
    if (pendingScrollSync !== null) return
    pendingScrollSync = requestAnimationFrame(() => {
      pendingScrollSync = null
      syncOverlayGeometry(el, overlay)
    })
  }
  document.addEventListener('scroll', handleDocumentScroll, { capture: true, passive: true })

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
      // Copilot round 2 (B43 C2), S6b: a host page's own CSS can target bare
      // element selectors (e.g. `span { display: block }`) that would shift
      // this mark out of inline flow and desync the mirror's line-wrapping
      // from the real textarea underneath. Set every layout-critical
      // property inline so host CSS — which loses to an inline style
      // regardless of specificity — cannot touch it; MARKS_CSS itself only
      // ever sets paint-only properties (background/outline), so there's no
      // conflict with the adapter's own cosmetic styling here.
      mark.style.display = 'inline'
      mark.style.margin = '0'
      mark.style.padding = '0'
      mark.style.border = '0'
      mark.style.font = 'inherit'
      mark.style.letterSpacing = 'inherit'
      mark.style.whiteSpace = 'inherit'
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

  // Copilot round 1 (B43 C2), finding F5: ResizeObserver and the scroll
  // listener above only catch a change in the field's own SIZE or in scroll
  // position — neither fires for a same-sized field that simply MOVES (a
  // banner above it finishes loading, a sibling element expands/collapses,
  // a flex/grid reflow shifts the row). No DOM event exists for "an element's
  // position changed for a reason that wasn't a resize or a scroll", so two
  // best-effort nets catch what's left: a window 'resize' listener (a
  // viewport resize can itself reflow the page even when the field's own box
  // doesn't change size) and a low-frequency safety interval. Both simply
  // re-run syncOverlayGeometry, whose measured-rect-delta approach (module
  // comment) makes every re-sync self-correcting and idempotent when nothing
  // moved — cheap even at this frequency, since it's only two
  // getBoundingClientRect() reads. The GEOMETRY re-sync only runs while
  // marks are actually on screen (currentSpans non-empty) — there's nothing
  // worth re-syncing for an overlay that's just an invisible copy of plain
  // text. The BACKGROUND re-sync (M6, closing sweep) runs on every tick
  // regardless — it's about the field staying visible/legible at all, not
  // about marks specifically, and is itself a cheap, no-op-when-unchanged
  // pair of getComputedStyle reads (syncBackground's own guards).
  const POSITION_DRIFT_CHECK_MS = 1000
  function handleWindowResize() {
    syncOverlayGeometry(el, overlay)
  }
  window.addEventListener('resize', handleWindowResize)
  const positionDriftInterval = setInterval(() => {
    syncBackground()
    if (currentSpans.length > 0) syncOverlayGeometry(el, overlay)
  }, POSITION_DRIFT_CHECK_MS)

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
      // M11 (closing sweep): document.activeElement retargets a focused
      // shadow-tree node (e.g. the C2 extension's affordance chip button,
      // rendered inside an open shadow root) to its HOST element — an
      // element that is itself typically not focusable. Reading straight
      // through the host's own shadowRoot.activeElement first recovers the
      // actual focused node, so the restore below lands back on the chip
      // instead of silently no-op'ing and leaving focus on <body>.
      const prev = document.activeElement?.shadowRoot?.activeElement ?? document.activeElement
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
      document.removeEventListener('scroll', handleDocumentScroll, { capture: true })
      if (pendingScrollSync !== null) {
        cancelAnimationFrame(pendingScrollSync)
        pendingScrollSync = null
      }
      window.removeEventListener('resize', handleWindowResize)
      clearInterval(positionDriftInterval)
      if (flashTimer !== null) clearTimeout(flashTimer)
      flashTimer = null
      changeCb = null
      overlay.remove()
      // Restore the inline values the paint-order setup above may have
      // touched, verbatim (an empty string puts back "unset") — but ONLY
      // where the CURRENT inline value still equals what THIS adapter wrote.
      // A property never written in the first place (writtenPosition/
      // writtenZIndex null: the field already had its own explicit value) is
      // left alone entirely; one that WAS written but the host has since
      // legitimately changed (mid-session re-render, theme toggle) is left
      // at the host's own value rather than clobbered back to the pre-session
      // snapshot.
      if (writtenPosition !== null && el.style.position === writtenPosition) {
        el.style.position = savedPosition
      }
      if (writtenZIndex !== null && el.style.zIndex === writtenZIndex) {
        el.style.zIndex = savedZIndex
      }
      if (el.style.backgroundColor === writtenBackgroundColor) {
        el.style.backgroundColor = savedBackgroundColor
      }
      if (writtenBackgroundImage !== null && el.style.backgroundImage === writtenBackgroundImage) {
        el.style.backgroundImage = savedBackgroundImage
        // M5: restore the positioning longhands moved alongside the image,
        // same per-property guard shape — only where the CURRENT inline
        // value still equals the `initial` this adapter itself wrote.
        for (const prop of BACKGROUND_IMAGE_LONGHANDS) {
          if (el.style[prop] === 'initial') el.style[prop] = savedBackgroundLonghands[prop]
        }
      }
    },
  }
}
