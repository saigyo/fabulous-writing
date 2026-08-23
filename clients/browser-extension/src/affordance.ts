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

  function render(): void {
    button.dataset.state = state
    button.textContent = glyphFor(state, count)
  }
  render()
  root.appendChild(button)

  button.addEventListener('click', (event) => {
    // A hostile page can focus a field and call .click() on this button
    // through the open shadow root (see the module comment above) to force
    // a connect and burn the user's credits without their input. A real
    // click/keyboard activation is always trusted; only that may proceed.
    if (!event.isTrusted) return
    if (currentEl) onClick(currentEl)
  })

  return {
    host,
    showFor(el) {
      currentEl = el
      const rect = el.getBoundingClientRect()
      // Anchored to the field's top-right corner: left/top name that
      // corner's page coordinates (viewport rect + scroll offset); the
      // transform below pulls the chip back so it straddles the corner
      // instead of growing off the field entirely.
      host.style.top = `${rect.top + window.scrollY}px`
      host.style.left = `${rect.right + window.scrollX}px`
      host.style.transform = 'translate(-100%, -50%)'
      if (!host.isConnected) document.documentElement.appendChild(host)
      host.style.display = ''
    },
    hide() {
      host.style.display = 'none'
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
      host.remove()
    },
  }
}
