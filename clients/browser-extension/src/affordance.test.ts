import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAffordance } from './affordance'

let el: HTMLTextAreaElement

function stubRect(target: HTMLElement, top: number, left: number, right: number, bottom: number): void {
  target.getBoundingClientRect = () => ({
    top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top,
    toJSON() { return {} },
  })
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
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onClick).toHaveBeenCalledExactlyOnceWith(el)
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
