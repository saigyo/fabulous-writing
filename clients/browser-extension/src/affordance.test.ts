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
  it('attaches exactly one shadow host to document.documentElement (not body), positioned at the top-right corner', () => {
    const affordance = createAffordance(() => {})
    affordance.showFor(el)

    expect(affordance.host.parentElement).toBe(document.documentElement)
    expect(document.body.contains(affordance.host)).toBe(false)
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
    expect(affordance.host.style.top).toBe('10px')
    expect(affordance.host.style.left).toBe('220px')

    affordance.dispose()
    el2.remove()
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
