// The shadow-DOM connect chip (spec: B43, C2 browser extension, Task 7).
// One shadow host. Copilot round 5, F5: inserted as the anchor field's own
// NEXT DOM SIBLING (showFor, below) so the chip sits next in Tab order
// right after the field — a host parked at the end of documentElement (the
// original design) put Tab-from-field on the page's own next control
// instead, making the chip unreachable by keyboard. The trade-off this
// accepts: living inside the field's own subtree means a GitHub/Turbo-style
// body swap that replaces that subtree can tear the host out too, not just
// orphan it — reposition()'s own isConnected guard hides a chip whose host
// died this way, and the next showFor's unconditional re-insert (also
// idempotent for a still-attached host) re-attaches it cleanly the moment
// the field is interacted with again. `mode: 'open'` is deliberate: a
// closed shadow root would make affordance.test.ts's assertions on the
// chip's own text/dataset impossible. Open mode does NOT keep a hostile
// page from reaching in and restyling (or scripting) what's inside — page
// JS can walk `host.shadowRoot` just like any other open root; the
// styles-inside-root point above is only about accidental CSS bleed FROM
// the page, not isolation from a hostile one (see the click handler's
// isTrusted guard below for the actual defense). Hover/focus lifecycle
// (when to show/hide, the leave-delay) is DRIVEN BY scout.ts — this module
// only renders what it's told.
export type AffordanceState = 'idle' | 'connected' | 'signed-out' | 'busy' | 'error'

export interface Affordance {
  /** Position near the field's top-right corner and reveal the chip. */
  showFor(el: HTMLTextAreaElement): void
  hide(): void
  setState(state: AffordanceState): void
  setCount(findingCount: number): void
  dispose(): void
  // Not part of the interface as spec'd, but required by scout.ts's
  // delegated hide-on-leave logic: a mouseout/focusout's relatedTarget (or
  // a focusout's new focus target) is compared against this host element to
  // tell "pointer/focus actually left the chip" apart from "crossed into it
  // from outside the shadow tree" — an event crossing a shadow boundary is
  // retargeted to the host by the platform itself, so the host is the only
  // identity scout can compare against.
  readonly host: HTMLElement
}

// Live-test finding (B43 C2, PR #139): the chip used to straddle the
// field's top-right corner (anchored AT the corner, pulled back by half its
// own size via a -100%/-50% transform) — on a host page whose own UI sits
// snug against the field's top edge (e.g. GitHub's markdown toolbar
// directly above the composer textarea), that outward straddle put the
// chip's top half underneath the host's own toolbar, leaving only the
// bottom half paintable/clickable. Anchoring fully INSIDE the corner
// instead (inset by this many px from both the top and right edges, same
// Grammarly-style inside-corner pattern) keeps the whole chip within the
// field's own box, where no host UI has a reason to paint over it. Also
// stays clear of the bottom-right corner, where a host's own resize grip
// commonly lives.
const CHIP_INSET_PX = 6

// Live-test UX decision (B43 C2, PR #139): a plain click on a CONNECTED
// chip used to disconnect — a destructive action one accidental click away,
// with no confirmation. The chip is now a split pill: the main segment
// (glyph/count) is never destructive — connected, it re-sends ctl openPanel
// to open/focus the side panel, same as an idle click starts one. Only the
// separate × segment, revealed by hovering or focusing the pill, disconnects.
// `.pill`'s own `overflow: hidden` clips the × to zero width until then.
//
// Growth direction: the pill is positioned via `left` + `transform:
// translateX(-100%)` (see showFor/reposition below) — a translateX(-100%)
// pins the box's RIGHT edge at that `left` point and grows the box LEFT of
// it, regardless of how wide the box itself is. So the × segment, laid out
// AFTER the main segment (i.e. on the pill's right, in normal reading
// order), makes the whole pill wider WITHOUT moving its right edge — growth
// is automatically leftward, into the field's own inset-anchored corner,
// never past the field's right edge. No extra positioning logic needed for
// the reveal; picked over shifting the pill left or mirroring the ×'s DOM
// order for exactly this reason.
const CHIP_STYLE = `
  :host {
    all: initial;
    position: absolute;
  }
  .pill {
    display: flex;
    align-items: stretch;
    border-radius: 11px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  button {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: #fff;
    font: 600 12px/1 system-ui, sans-serif;
  }
  /* "all: unset" above also wipes the button's native focus ring — restore
     a visible one for keyboard activation (Finding F7). Inset (not offset)
     so the ring stays inside the pill's own clipped/rounded edge — same
     reason both layers below are inset rather than an outward glow: .pill
     clips overflow, so anything drawn OUTSIDE the border box is invisible.
     Copilot round 11, F3: a single #6e56cf ring was IDENTICAL to the 'busy'
     segment's own background (below), so it vanished completely on exactly
     one of the five states it needs to be visible on. Two layers instead —
     a white ring pulled 4px in, plus a dark line right at the edge — is
     visible against every one of the pill's saturated backgrounds (the dark
     line reads against the white ring itself even in the pathological case
     where a background happened to be light). */
  button:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -4px;
    box-shadow: inset 0 0 0 2px #1c1c21;
  }
  .main {
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    background: #52525b;
  }
  /* Copilot round 11, F4: #16a34a with white 12px/600 text is ~3.3:1 —
     below WCAG AA's 4.5:1 floor for text this small (12px doesn't qualify
     as "large text" even at this weight). #166534 (same green family, one
     step darker) is ~7.1:1 against white — verified via the standard
     relative-luminance formula, not eyeballed; comfortably clears 4.5:1
     with margin to spare for anti-aliasing at small sizes. */
  .pill[data-state='connected'] .main { background: #166534; }
  .pill[data-state='busy'] .main { background: #6e56cf; }
  .pill[data-state='signed-out'] .main { background: #d97706; }
  .pill[data-state='error'] .main { background: #dc2626; }
  .disconnect {
    width: 0;
    /* Owner report, round 11 F6: the connected pill showed a visible ×
       sliver at rest even though width was 0 — the button rule above is
       display:flex, and a flex item's default min-width:auto refuses to
       shrink below its own CONTENT size (the × glyph) regardless of an
       explicit width:0. min-width:0 opts back into the explicit width;
       overflow:hidden is the belt-and-suspenders twin of the same fix (a
       non-visible overflow also zeroes the flex automatic minimum size per
       spec, and clips the glyph locally even if something else here ever
       changes). */
    min-width: 0;
    overflow: hidden;
    height: 22px;
    background: #3f3f46;
    transition: width 150ms ease;
  }
  /* Gated on the pill's own state: idle has no session to disconnect, so
     hovering/focusing an idle chip never reveals the ×. */
  .pill:not([data-state='idle']):hover .disconnect,
  .pill:not([data-state='idle']):focus-within .disconnect {
    width: 20px;
  }
  .disconnect:hover {
    background: #dc2626;
  }
  @media (prefers-reduced-motion: reduce) {
    .disconnect { transition: none; }
  }
`

function glyphFor(state: AffordanceState, count: number): string {
  switch (state) {
    case 'connected':
      return count > 0 ? String(count) : '✓'
    case 'signed-out':
      return '⚠'
    case 'error':
      return '!'
    case 'busy':
      return '…'
    case 'idle':
      return '✳'
  }
}

// Finding F6: the button's visible content is a bare glyph (a checkmark, a
// count, an exclamation point) — meaningless to a screen reader without a
// state-aware accessible name alongside it. Live-test UX decision: the main
// segment is no longer a disconnect affordance (that's the × now), so its
// label describes opening the panel instead.
function ariaLabelFor(state: AffordanceState, count: number): string {
  switch (state) {
    case 'connected':
      return count > 0
        ? `${count} findings — open Fabulous Writing`
        : 'connected — open Fabulous Writing'
    case 'signed-out':
      return 'Fabulous Writing: signed out'
    case 'error':
      return 'Fabulous Writing: error'
    case 'busy':
      return 'Connecting Fabulous Writing…'
    case 'idle':
      return 'Connect Fabulous Writing'
  }
}

export function createAffordance(
  onClick: (el: HTMLTextAreaElement) => void,
  onDisconnect: (el: HTMLTextAreaElement) => void,
): Affordance {
  const host = document.createElement('div')
  host.setAttribute('data-fw-affordance', '')
  host.style.position = 'absolute'
  host.style.zIndex = '2147483647'
  host.style.display = 'none'

  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CHIP_STYLE
  root.appendChild(style)

  const pill = document.createElement('div')
  pill.className = 'pill'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'main'

  const disconnectButton = document.createElement('button')
  disconnectButton.type = 'button'
  disconnectButton.className = 'disconnect'
  disconnectButton.textContent = '×'
  disconnectButton.setAttribute('aria-label', 'Disconnect this field')

  let state: AffordanceState = 'idle'
  let count = 0
  let currentEl: HTMLTextAreaElement | null = null
  // Copilot round 2 (B43 C2), S5: while the chip is shown it must track its
  // anchor field's position — a page scroll (document-level, capture-phase,
  // same reasoning as textareaAdapter.ts's own document scroll listener: an
  // inner scroller's scroll event doesn't bubble) or a window resize can
  // move the field without the chip ever being told to re-show. rAF-
  // throttled to at most one pending reposition, same shape as the adapter's
  // own scroll re-sync.
  let visible = false
  let pendingReposition: number | null = null

  // I4 (closing sweep): factored out so both the public hide() and the
  // detached-anchor path below (reposition()) share the exact same
  // display:none + stop-tracking shape.
  function hideInternal(): void {
    host.style.display = 'none'
    visible = false
    stopTrackingPosition()
  }

  function reposition(): void {
    if (!currentEl) return
    // I4: nothing (no mouseout/focusout) fires for an element a Turbo/React
    // re-render REMOVES from the DOM — currentEl is only ever replaced by
    // the next showFor, so without this check the chip stays visible at the
    // dead field's last coordinates, a scroll jumps it to (0,0) (a detached
    // node's getBoundingClientRect is all zeros), and a click on it would
    // start a full session on a detached textarea.
    if (!currentEl.isConnected) {
      hideInternal()
      return
    }
    // F5 (Copilot review round 5): the host now lives as the field's own
    // DOM sibling (below) rather than appended to documentElement — a
    // Turbo/React body swap that removes the field's subtree can take the
    // host down with it without ever removing currentEl itself (e.g. the
    // field is re-created fresh elsewhere while this stale host is torn
    // out). Same rationale as the currentEl check above: don't position a
    // chip nobody can see; showFor's own re-insert (below) re-attaches it
    // cleanly on the next interaction.
    if (!host.isConnected) {
      hideInternal()
      return
    }
    const rect = currentEl.getBoundingClientRect()
    // Inset from the top-right corner (see CHIP_INSET_PX's own comment) —
    // top is pushed DOWN into the box, left is pulled IN from the right
    // edge (the transform below then pulls the chip's own width back to
    // the left of that point, same as it always has).
    host.style.top = `${rect.top + window.scrollY + CHIP_INSET_PX}px`
    host.style.left = `${rect.right + window.scrollX - CHIP_INSET_PX}px`
    // F5: same measured-delta self-correction textareaAdapter.ts's
    // syncOverlayGeometry uses (see its own module comment for the full
    // rationale) — the host's `position: absolute` containing block is no
    // longer guaranteed to be the page's own origin now that it's a DOM
    // sibling of the field instead of a documentElement child, so top/left
    // set from viewport+scroll coordinates alone can land it anywhere.
    // Measure where the host's UNTRANSFORMED box actually landed (the
    // cosmetic -100%/-50% pull-back transform held off during the
    // measurement — it's an intentional, constant visual offset, not
    // something to correct away) and shift top/left by the difference from
    // where it was meant to land.
    const savedTransform = host.style.transform
    host.style.transform = 'none'
    const hostRect = host.getBoundingClientRect()
    host.style.transform = savedTransform
    // A literal all-zero rect is happy-dom/jsdom's answer for any element
    // under test (no layout engine — same fallback rationale as the
    // phantom-scale guard in textareaAdapter.ts) — treat it as "nothing to
    // correct by" rather than applying a bogus delta against a box that was
    // never actually laid out.
    const hostHasRealLayout =
      hostRect.top !== 0 || hostRect.left !== 0 || hostRect.width !== 0 || hostRect.height !== 0
    if (hostHasRealLayout) {
      // Copilot round 6, F1: hostRect (getBoundingClientRect) is in
      // VIEWPORT-space pixels, but host.style.top/left resolve against the
      // host's CONTAINING-BLOCK-space (unscaled) coordinate system — same
      // mismatch textareaAdapter.ts's syncOverlayGeometry documents and
      // corrects for (see its own module comment for the full rationale).
      // Under a transformed (scaled) ancestor those two spaces diverge, so
      // applying the raw viewport-space delta unmodified over/undershoots —
      // an error that compounds through the 1s drift interval above
      // (oscillates for a scale in (1, 2), diverges outright above 2).
      // Recover the effective scale the same way: compare the host's
      // just-measured on-screen rect to its own UNTRANSFORMED layout border
      // box — offsetWidth/offsetHeight, exactly what getBoundingClientRect
      // scales — and divide the delta by it. NaN/zero (no real layout, e.g.
      // under test, or a not-yet-laid-out host) falls back to a scale of 1,
      // exactly the old, unscaled behavior.
      const rawScaleX = hostRect.width / host.offsetWidth
      const rawScaleY = hostRect.height / host.offsetHeight
      const scaleX = Number.isFinite(rawScaleX) && rawScaleX !== 0 ? rawScaleX : 1
      const scaleY = Number.isFinite(rawScaleY) && rawScaleY !== 0 ? rawScaleY : 1
      // Copilot round 10, F1: the correction target here used to be
      // rect.top/rect.right — the field's own RAW corner. Since hostRect is
      // measured in the same viewport space as rect, converging the delta
      // against the raw corner pulls the chip's top-left measurement point
      // back to the exact edge, undoing CHIP_INSET_PX every time real
      // layout is measurable (i.e. everywhere outside a zero-rect test
      // stub). The target must be the INSET point instead — the same one
      // top/left were set from above (rect.top + CHIP_INSET_PX, rect.right
      // - CHIP_INSET_PX) — so the correction converges to where the chip
      // was actually meant to land.
      host.style.top =
        `${(parseFloat(host.style.top) || 0) + (rect.top + CHIP_INSET_PX - hostRect.top) / scaleY}px`
      host.style.left =
        `${(parseFloat(host.style.left) || 0) + (rect.right - CHIP_INSET_PX - hostRect.left) / scaleX}px`
    }
  }

  function scheduleReposition(): void {
    if (pendingReposition !== null) return
    pendingReposition = requestAnimationFrame(() => {
      pendingReposition = null
      reposition()
    })
  }

  // F6: same low-frequency safety net as textareaAdapter.ts's own
  // POSITION_DRIFT_CHECK_MS interval — the scroll/resize listeners above
  // only catch a change in the anchor field's SCROLL POSITION or the
  // window's own size; a same-sized field that simply MOVES (a banner
  // above it finishes loading, a sibling expands/collapses, a flex/grid
  // reflow shifts the row) fires neither. reposition() is idempotent when
  // nothing moved, so this is cheap even at 1s.
  const POSITION_DRIFT_CHECK_MS = 1000
  let positionDriftInterval: ReturnType<typeof setInterval> | null = null

  function startTrackingPosition(): void {
    document.addEventListener('scroll', scheduleReposition, { capture: true, passive: true })
    window.addEventListener('resize', scheduleReposition)
    positionDriftInterval = setInterval(reposition, POSITION_DRIFT_CHECK_MS)
  }

  function stopTrackingPosition(): void {
    document.removeEventListener('scroll', scheduleReposition, { capture: true })
    window.removeEventListener('resize', scheduleReposition)
    if (pendingReposition !== null) {
      cancelAnimationFrame(pendingReposition)
      pendingReposition = null
    }
    if (positionDriftInterval !== null) {
      clearInterval(positionDriftInterval)
      positionDriftInterval = null
    }
  }

  function render(): void {
    // Set on both: the pill's own copy is what the reveal-gating CSS
    // selector above keys off; the button's copy keeps `data-state`
    // queryable directly off "the" (main) button, same as before the split.
    pill.dataset.state = state
    button.dataset.state = state
    button.textContent = glyphFor(state, count)
    button.setAttribute('aria-label', ariaLabelFor(state, count))
    // Copilot round 10, F2 + F4: the × segment used to always be in the
    // DOM, hidden only via `width: 0` — that (a) left it in the keyboard
    // tab order even while idle (a Tab landed on an invisible control with
    // nothing to disconnect), and (b) leaked a half-cut × sliver on the
    // idle pill's right edge (a zero-width flex item's content isn't
    // guaranteed zero visual footprint). Structural fix for both: the ×
    // simply isn't in the DOM at all outside the states that gate its
    // hover/focus reveal (the same `:not([data-state='idle'])` the CSS
    // above already keys off) — an absent element is untabbable and paints
    // nothing, no CSS trick required. Appended AFTER button so DOM order
    // still matches the "grows leftward" comment above.
    if (state === 'idle') {
      // F2: a disconnect that lands the pill back on idle can still have
      // focus sitting inside the × (the user just clicked/activated it) —
      // removing a focused node from the DOM silently drops focus to
      // <body> instead of landing back on the chip's own main button.
      // Move it first.
      if (root.activeElement === disconnectButton) button.focus()
      disconnectButton.remove()
    } else if (!disconnectButton.isConnected) {
      pill.appendChild(disconnectButton)
    }
  }
  pill.appendChild(button)
  root.appendChild(pill)
  render()

  button.addEventListener('click', (event) => {
    // A hostile page can focus a field and call .click() on this button
    // through the open shadow root (see the module comment above) to force
    // a connect and burn the user's credits without their input. A real
    // click/keyboard activation is always trusted; only that may proceed.
    if (!event.isTrusted) return
    // I4: a real, trusted click can still land on a chip whose anchor field
    // has since been removed from the DOM (see reposition()'s own check
    // above) — refuse to start a session on a detached textarea.
    if (currentEl?.isConnected) onClick(currentEl)
  })

  disconnectButton.addEventListener('click', (event) => {
    // Same two guards as the main segment's own click handler above.
    if (!event.isTrusted) return
    if (currentEl?.isConnected) onDisconnect(currentEl)
  })

  return {
    host,
    showFor(el) {
      currentEl = el
      // F5 (Copilot review round 5): insert the host as the field's own
      // NEXT SIBLING — not appended at the end of documentElement — so the
      // chip button is next in sequential (Tab) focus order right after
      // the field. A host parked at the end of the DOM put Tab-from-field
      // on the page's own next control instead, skipping the chip (and its
      // focusout) entirely. Unconditional and idempotent: called on every
      // showFor (including repeat calls for a field that's already
      // adjacent), it simply re-inserts the host at the same spot — which
      // is also what re-attaches it cleanly after a Turbo body swap tore
      // the host out along with (or instead of) the field (see reposition()
      // and its own isConnected guard).
      el.insertAdjacentElement('afterend', host)
      // display must be '' BEFORE reposition() measures the host's own
      // rect (below) — a display:none box has no layout, so measuring it
      // first would always report a zero rect and feed a bogus delta into
      // the correction.
      host.style.display = ''
      // Anchored INSIDE the field's top-right corner (CHIP_INSET_PX in from
      // both edges): left/top name that inset point's page coordinates
      // (viewport rect + scroll offset); the transform below pulls the
      // chip's own width back to the left of it so the whole chip lands
      // inside the field's box instead of straddling the corner outward.
      reposition()
      host.style.transform = 'translateX(-100%)'
      if (!visible) {
        visible = true
        startTrackingPosition()
      }
    },
    hide() {
      hideInternal()
    },
    setState(next) {
      state = next
      render()
    },
    setCount(next) {
      count = next
      render()
    },
    dispose() {
      visible = false
      stopTrackingPosition()
      // M10: currentEl otherwise survives dispose, keeping a strong
      // reference to a textarea from a page that may never come back
      // (pairs with I4).
      currentEl = null
      host.remove()
    },
  }
}
