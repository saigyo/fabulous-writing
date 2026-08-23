import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAffordance } from './affordance'

let el: HTMLTextAreaElement

function stubRect(target: HTMLElement, top: number, left: number, right: number, bottom: number): void {
  target.getBoundingClientRect = () => ({
    top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top,
    toJSON() { return {} },
  })
}

// vitest/happy-dom synthetic events are untrusted (isTrusted: false) by
// default, unlike a real click/keyboard activation — the click handler's
// own isTrusted guard (affordance.ts) would otherwise swallow every
// dispatchEvent-driven test click below.
function trustedClick(): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true })
  Object.defineProperty(ev, 'isTrusted', { value: true })
  return ev
}

beforeEach(() => {
  el = document.createElement('textarea')
  document.body.appendChild(el)
  stubRect(el, 50, 100, 300, 130)
})

describe('createAffordance: showFor', () => {
  // Copilot round 5, F5: the host used to be appended to documentElement,
  // outside the field's own subtree entirely; it now lives as the field's
  // own NEXT SIBLING so it's reachable by Tab right after the field (see
  // the "keyboard reachability" describe block below for the adjacency
  // contract itself).
  it('attaches exactly one shadow host as the field\'s own next sibling, positioned at the top-right corner', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    expect(affordance.host.parentElement).toBe(el.parentElement)
    expect(affordance.host.previousElementSibling).toBe(el)
    expect(document.body.contains(affordance.host)).toBe(true)
    expect(affordance.host.shadowRoot).not.toBeNull()
    expect(affordance.host.style.top).toBe('50px')
    expect(affordance.host.style.left).toBe('300px')

    affordance.dispose()
  })

  it('showing for a second field repositions the SAME host rather than creating a new one', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)
    const firstHost = affordance.host

    const el2 = document.createElement('textarea')
    document.body.appendChild(el2)
    stubRect(el2, 10, 20, 220, 90)
    affordance.showFor(el2)

    expect(affordance.host).toBe(firstHost)
    expect(document.documentElement.querySelectorAll('[data-fw-affordance]').length).toBe(1)
    // Moved to be the SECOND field's next sibling now, not left behind
    // next to the first.
    expect(affordance.host.previousElementSibling).toBe(el2)
    expect(affordance.host.style.top).toBe('10px')
    expect(affordance.host.style.left).toBe('220px')

    affordance.dispose()
    el2.remove()
  })
})

// Copilot round 5, F5: the host sat at the end of documentElement — Tab
// from the field went to the page's own next control, and focusout hid the
// chip before a keyboard user could ever reach it.
describe('createAffordance: keyboard reachability (F5, round 5)', () => {
  it('the host is el.nextElementSibling after showFor, putting the chip next in Tab order', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    expect(el.nextElementSibling).toBe(affordance.host)

    affordance.dispose()
  })

  it('corrects for a containing block that is not the field\'s own page origin (measured-delta, same technique as textareaAdapter.ts)', () => {
    const affordance = createAffordance(() => {})
    // Simulate a containing block that isn't the page origin: the same
    // top/left the naive calculation sets lands the host somewhere OTHER
    // than (50, 300) — as if some positioned ancestor between the host and
    // the viewport shifted it.
    affordance.host.getBoundingClientRect = () => (
      { top: 40, left: 90, right: 90, bottom: 40, width: 0, height: 0, x: 90, y: 40, toJSON() { return {} } }
    )
    affordance.showFor(el)

    // Naive target was (50, 300); the host actually landed at (40, 90) for
    // those values, so the correction shifts by (+10, +210).
    expect(affordance.host.style.top).toBe('60px')
    expect(affordance.host.style.left).toBe('510px')

    affordance.dispose()
  })

  it('a host detached along with the field (a Turbo body swap) is re-attached cleanly on the next showFor', () => {
    const wrapper = document.createElement('div')
    document.body.appendChild(wrapper)
    wrapper.appendChild(el)

    const affordance = createAffordance(() => {})
    affordance.showFor(el)
    expect(affordance.host.isConnected).toBe(true)

    // The whole subtree holding both the field and its now-adjacent chip
    // host is torn out at once — reposition()'s own isConnected guard
    // (exercised via the interval/scroll paths, not directly here) is what
    // keeps a chip whose host died this way from being positioned.
    wrapper.remove()
    expect(affordance.host.isConnected).toBe(false)
    expect(el.isConnected).toBe(false)

    // Turbo replaces the field with a fresh subtree — reuse `el` here to
    // model "the field is back", appended in a brand new location.
    document.body.appendChild(el)
    affordance.showFor(el)

    expect(affordance.host.isConnected).toBe(true)
    expect(affordance.host.previousElementSibling).toBe(el)

    affordance.dispose()
    wrapper.remove()
  })
})

// Copilot round 5, F6: same class of bug as the adapter's own — the
// scroll/resize listeners only catch a scroll or a window resize, not a
// same-sized field that simply MOVES (a layout-only reflow).
describe('createAffordance: 1s position-drift safety interval (F6, round 5)', () => {
  it('repositions on a moved rect via the interval, with no scroll/resize event', () => {
    vi.useFakeTimers()
    const affordance = createAffordance(() => {})
    affordance.showFor(el)
    expect(affordance.host.style.top).toBe('50px')

    stubRect(el, 200, 5, 205, 230)
    vi.advanceTimersByTime(1000)
    expect(affordance.host.style.top).toBe('200px')

    affordance.dispose()
    vi.useRealTimers()
  })

  it('is cleared when hidden: a later interval tick after hide() does not reposition', () => {
    vi.useFakeTimers()
    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    affordance.hide()
    stubRect(el, 999, 5, 1005, 1030)
    vi.advanceTimersByTime(2000)

    expect(affordance.host.style.top).not.toBe('999px')

    affordance.dispose()
    vi.useRealTimers()
  })
})

describe('createAffordance: click', () => {
  it('invokes the callback with the element passed to the most recent showFor', () => {
    const onClick = vi.fn()
    const affordance = createAffordance(onClick)
    affordance.showFor(el)

    const button = affordance.host.shadowRoot!.querySelector('button')!
    button.dispatchEvent(trustedClick())

    expect(onClick).toHaveBeenCalledExactlyOnceWith(el)
    affordance.dispose()
  })

  it('an untrusted click does not invoke the callback', () => {
    const onClick = vi.fn()
    const affordance = createAffordance(onClick)
    affordance.showFor(el)

    const button = affordance.host.shadowRoot!.querySelector('button')!
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onClick).not.toHaveBeenCalled()
    affordance.dispose()
  })
})

describe('createAffordance: setState/setCount', () => {
  it('reflects state in data-state and the glyph/count text', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)
    const button = affordance.host.shadowRoot!.querySelector('button')!

    expect(button.getAttribute('data-state')).toBe('idle')
    expect(button.textContent).toBe('✳')

    affordance.setState('connected')
    expect(button.getAttribute('data-state')).toBe('connected')
    expect(button.textContent).toBe('✓')

    affordance.setCount(3)
    expect(button.textContent).toBe('3')

    affordance.setCount(0)
    expect(button.textContent).toBe('✓')

    affordance.setState('signed-out')
    expect(button.getAttribute('data-state')).toBe('signed-out')
    expect(button.textContent).toBe('⚠')

    affordance.setState('error')
    expect(button.textContent).toBe('!')

    affordance.setState('busy')
    expect(button.textContent).toBe('…')

    affordance.dispose()
  })
})

// Copilot round 1, F6: the button's visible content is a bare glyph — an
// accessible name must track state/count alongside it.
describe('createAffordance: aria-label tracks state/count', () => {
  it('updates as setState/setCount change', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)
    const button = affordance.host.shadowRoot!.querySelector('button')!

    expect(button.getAttribute('aria-label')).toBe('Connect Fabulous Writing')

    affordance.setState('busy')
    expect(button.getAttribute('aria-label')).toBe('Connecting Fabulous Writing…')

    affordance.setState('connected')
    expect(button.getAttribute('aria-label')).toBe('Fabulous Writing connected — click to disconnect')

    affordance.setCount(3)
    expect(button.getAttribute('aria-label')).toBe('3 findings — click to disconnect')

    affordance.setCount(0)
    expect(button.getAttribute('aria-label')).toBe('Fabulous Writing connected — click to disconnect')

    affordance.setState('signed-out')
    expect(button.getAttribute('aria-label')).toBe('Fabulous Writing: signed out')

    affordance.setState('error')
    expect(button.getAttribute('aria-label')).toBe('Fabulous Writing: error')

    affordance.dispose()
  })
})

// Copilot round 1, F7: `all: unset` on the button wipes its native focus
// ring — a replacement :focus-visible style must be present in the shadow
// stylesheet.
describe('createAffordance: focus-visible style', () => {
  it('the shadow stylesheet defines a visible :focus-visible outline for the button', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    const style = affordance.host.shadowRoot!.querySelector('style')!
    expect(style.textContent).toMatch(/button:focus-visible\s*\{[^}]*outline:\s*[^;]+;/)

    affordance.dispose()
  })
})

// Copilot round 2 (B43 C2), S5: the chip never repositioned while shown — a
// page scroll or window resize that moves the anchor field left it visually
// detached from the field until the next showFor. Same pattern as
// textareaAdapter.ts's own document-level scroll re-sync: rAF-throttled,
// registered while shown, torn down in hide()/dispose().
// Copilot round 6, F1: the same viewport-space vs containing-block-space
// mismatch textareaAdapter.ts's syncOverlayGeometry corrects for (see its
// own describe block, 'transform-scale-aware overlay geometry sync') also
// applies to the chip host's own measured-delta reposition — under a scaled
// ancestor the raw rect delta over/undershoots, which the 1s drift interval
// above compounds into oscillation/divergence.
describe('createAffordance: transform-scale-aware reposition (F1, round 6)', () => {
  it('divides the measured delta by the effective scale under a scaled host ancestor, landing exactly in one adjust', () => {
    const affordance = createAffordance(() => {})
    // Naive target is (50, 300) (see stubRect(el, 50, 100, 300, 130) in
    // beforeEach). Simulate the host's containing block being off by
    // (10, 210) in TRUE (unscaled) pixels, reported doubled (viewport
    // space) under a 2x-scaled ancestor: true delta (10, 210) * scale 2 =
    // (20, 420) as measured. The host's own untransformed layout box
    // (offsetWidth/offsetHeight) is stubbed to half its measured rect size,
    // recovering a scale of 2.
    Object.defineProperty(affordance.host, 'offsetWidth', { value: 100, configurable: true })
    Object.defineProperty(affordance.host, 'offsetHeight', { value: 60, configurable: true })
    affordance.host.getBoundingClientRect = () => (
      { top: 20, left: -120, right: -120, bottom: 20, width: 200, height: 120, x: -120, y: 20, toJSON() { return {} } }
    )
    affordance.showFor(el)

    // Naive target (50, 300); measured host rect (20, -120); raw delta
    // (30, 420); recovered scale (200/100=2, 120/60=2); corrected delta
    // (15, 210) — landing at (65, 510).
    expect(affordance.host.style.top).toBe('65px')
    expect(affordance.host.style.left).toBe('510px')

    affordance.dispose()
  })

  it('unscaled behavior is unchanged: a zero offsetWidth/offsetHeight (no real layout, e.g. under test) falls back to a scale of 1', () => {
    const affordance = createAffordance(() => {})
    // Same as the existing containing-block-correction test above (no scale
    // stub — happy-dom's default offsetWidth/offsetHeight is 0, so
    // rawScale is NaN and falls back to 1).
    affordance.host.getBoundingClientRect = () => (
      { top: 40, left: 90, right: 90, bottom: 40, width: 0, height: 0, x: 90, y: 40, toJSON() { return {} } }
    )
    affordance.showFor(el)

    expect(affordance.host.style.top).toBe('60px')
    expect(affordance.host.style.left).toBe('510px')

    affordance.dispose()
  })
})

describe('createAffordance: repositions while shown on scroll/resize', () => {
  it('a document scroll event while shown repositions the chip, rAF-throttled to at most one pending sync', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })

    const affordance = createAffordance(() => {})
    affordance.showFor(el)
    expect(affordance.host.style.top).toBe('50px')
    expect(affordance.host.style.left).toBe('300px')

    stubRect(el, 10, 5, 205, 40)
    document.dispatchEvent(new Event('scroll'))
    expect(rafCallbacks).toHaveLength(1)

    // A second scroll before the queued frame runs must not schedule a
    // second rAF.
    document.dispatchEvent(new Event('scroll'))
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks[0](0)
    expect(affordance.host.style.top).toBe('10px')
    expect(affordance.host.style.left).toBe('205px')

    affordance.dispose()
    rafSpy.mockRestore()
  })

  it('a window resize event while shown also repositions the chip', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })

    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    stubRect(el, 77, 3, 199, 120)
    window.dispatchEvent(new Event('resize'))
    expect(rafCallbacks).toHaveLength(1)
    rafCallbacks[0](0)

    expect(affordance.host.style.top).toBe('77px')
    expect(affordance.host.style.left).toBe('199px')

    affordance.dispose()
    rafSpy.mockRestore()
  })

  it('hide() and dispose() remove the scroll/resize listeners', () => {
    const docAddSpy = vi.spyOn(document, 'addEventListener')
    const docRemoveSpy = vi.spyOn(document, 'removeEventListener')
    const winAddSpy = vi.spyOn(window, 'addEventListener')
    const winRemoveSpy = vi.spyOn(window, 'removeEventListener')

    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    const scrollAdd = docAddSpy.mock.calls.find(([type]) => type === 'scroll')
    expect(scrollAdd).toBeDefined()
    expect(scrollAdd?.[2]).toMatchObject({ capture: true, passive: true })
    expect(winAddSpy).toHaveBeenCalledWith('resize', expect.any(Function))

    affordance.hide()
    expect(docRemoveSpy.mock.calls.some(([type]) => type === 'scroll')).toBe(true)
    expect(winRemoveSpy).toHaveBeenCalledWith('resize', expect.any(Function))

    // Showing again re-attaches the listeners; dispose() removes them once more.
    docAddSpy.mockClear()
    affordance.showFor(el)
    expect(docAddSpy.mock.calls.some(([type]) => type === 'scroll')).toBe(true)

    docRemoveSpy.mockClear()
    winRemoveSpy.mockClear()
    affordance.dispose()
    expect(docRemoveSpy.mock.calls.some(([type]) => type === 'scroll')).toBe(true)
    expect(winRemoveSpy).toHaveBeenCalledWith('resize', expect.any(Function))

    docAddSpy.mockRestore()
    docRemoveSpy.mockRestore()
    winAddSpy.mockRestore()
    winRemoveSpy.mockRestore()
  })
})

// I4 (closing sweep): currentEl was only ever replaced by the next showFor
// — nothing dropped it when the anchor field left the DOM (a Turbo/React
// re-render removing it fires no mouseout/focusout scout's leave path can
// key on). A ghost chip would then jump to (0,0) on the next reposition
// (a detached node's getBoundingClientRect is all zeros) and a real click
// on it would start a full session on a detached textarea.
describe('createAffordance: detached anchor (I4, closing sweep)', () => {
  it('reposition() with a detached currentEl hides the chip instead of jumping to (0,0)', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })

    const affordance = createAffordance(() => {})
    affordance.showFor(el)
    expect(affordance.host.style.display).not.toBe('none')

    el.remove()
    // A detached node's own getBoundingClientRect reports all zeros — if
    // reposition() didn't check isConnected, this scroll would drive the
    // chip's top/left to '0px' rather than hiding it.
    document.dispatchEvent(new Event('scroll'))
    expect(rafCallbacks).toHaveLength(1)
    rafCallbacks[0](0)

    expect(affordance.host.style.display).toBe('none')
    expect(affordance.host.style.top).not.toBe('0px')
    expect(affordance.host.style.left).not.toBe('0px')

    affordance.dispose()
    rafSpy.mockRestore()
  })

  it('a trusted click with a detached currentEl does not invoke the callback', () => {
    const onClick = vi.fn()
    const affordance = createAffordance(onClick)
    affordance.showFor(el)

    el.remove()
    const button = affordance.host.shadowRoot!.querySelector('button')!
    button.dispatchEvent(trustedClick())

    expect(onClick).not.toHaveBeenCalled()

    affordance.dispose()
  })
})

describe('createAffordance: hide/dispose', () => {
  it('hide() removes it from view without destroying the host', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    affordance.hide()

    expect(affordance.host.isConnected).toBe(true)
    expect(affordance.host.style.display).toBe('none')

    affordance.dispose()
  })

  it('dispose() removes the host from the DOM', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    affordance.dispose()

    expect(affordance.host.isConnected).toBe(false)
  })
})
