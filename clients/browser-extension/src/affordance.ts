// The shadow-DOM connect chip (spec: B43, C2 browser extension, Task 7).
// One shadow host, attached to document.documentElement (not body — GitHub
// and other Turbo-style sites replace body subtrees on navigation, which
// would silently orphan a body-attached host). `mode: 'open'` is
// deliberate: a closed shadow root would make affordance.test.ts's
// assertions on the chip's own text/dataset impossible. Open mode does NOT
// keep a hostile page from reaching in and restyling (or scripting) what's
// inside — page JS can walk `host.shadowRoot` just like any other open
// root; the styles-inside-root point above is only about accidental CSS
// bleed FROM the page, not isolation from a hostile one (see the click
// handler's isTrusted guard below for the actual defense). Hover/focus
// lifecycle (when to show/hide, the leave-delay) is DRIVEN BY scout.ts —
// this module only renders what it's told.
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

const CHIP_STYLE = `
  :host {
    all: initial;
    position: absolute;
  }
  button {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 11px;
    font: 600 12px/1 system-ui, sans-serif;
    cursor: pointer;
    color: #fff;
    background: #52525b;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  /* "all: unset" above also wipes the button's native focus ring — restore
     a visible one for keyboard activation (Finding F7). */
  button:focus-visible {
    outline: 2px solid #6e56cf;
    outline-offset: 1px;
  }
  button[data-state='connected'] { background: #16a34a; }
  button[data-state='busy'] { background: #6e56cf; }
  button[data-state='signed-out'] { background: #d97706; }
  button[data-state='error'] { background: #dc2626; }
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
// state-aware accessible name alongside it.
function ariaLabelFor(state: AffordanceState, count: number): string {
  switch (state) {
    case 'connected':
      return count > 0
        ? `${count} findings — click to disconnect`
        : 'Fabulous Writing connected — click to disconnect'
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

export function createAffordance(onClick: (el: HTMLTextAreaElement) => void): Affordance {
  const host = document.createElement('div')
  host.setAttribute('data-fw-affordance', '')
  host.style.position = 'absolute'
  host.style.zIndex = '2147483647'
  host.style.display = 'none'

  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CHIP_STYLE
  root.appendChild(style)

  const button = document.createElement('button')
  button.type = 'button'

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
    const rect = currentEl.getBoundingClientRect()
    host.style.top = `${rect.top + window.scrollY}px`
    host.style.left = `${rect.right + window.scrollX}px`
  }

  function scheduleReposition(): void {
    if (pendingReposition !== null) return
    pendingReposition = requestAnimationFrame(() => {
      pendingReposition = null
      reposition()
    })
  }

  function stopTrackingPosition(): void {
    document.removeEventListener('scroll', scheduleReposition, { capture: true })
    window.removeEventListener('resize', scheduleReposition)
    if (pendingReposition !== null) {
      cancelAnimationFrame(pendingReposition)
      pendingReposition = null
    }
  }

  function render(): void {
    button.dataset.state = state
    button.textContent = glyphFor(state, count)
    button.setAttribute('aria-label', ariaLabelFor(state, count))
  }
  render()
  root.appendChild(button)

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

  return {
    host,
    showFor(el) {
      currentEl = el
      // Anchored to the field's top-right corner: left/top name that
      // corner's page coordinates (viewport rect + scroll offset); the
      // transform below pulls the chip back so it straddles the corner
      // instead of growing off the field entirely.
      reposition()
      host.style.transform = 'translate(-100%, -50%)'
      if (!host.isConnected) document.documentElement.appendChild(host)
      host.style.display = ''
      if (!visible) {
        visible = true
        document.addEventListener('scroll', scheduleReposition, { capture: true, passive: true })
        window.addEventListener('resize', scheduleReposition)
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
