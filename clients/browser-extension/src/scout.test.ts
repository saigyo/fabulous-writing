// Drives scout.ts's wiring through the global browser mock's stub port and
// real (delegated, document-level) DOM events — see scout.ts's own module
// comment for why a single shared import is safe here: every test below
// ends by disconnecting whatever port it opened, which is what actually
// resets scout's module-scoped session/port state back to a clean baseline
// for the next test (vi.resetModules() would instead leave STALE document
// listeners from a torn-down module instance attached alongside the fresh
// ones — worse, not better, isolation). Only the three behaviors the brief
// pins are covered here; the hover/focus delegation delay and the pagehide
// teardown are exercised structurally by the build + the manual gesture
// check (Task 7 step 5), not unit-tested.
import { describe, expect, it, vi } from 'vitest'
import { browserMock, type MockPort } from './testing/browserMock'
import './scout'

// Must exceed scout.ts's own (private) HIDE_DELAY_MS — this file has no
// access to that constant, so it advances generously past it instead of
// mirroring the exact value.
const PAST_HIDE_DELAY_MS = 1000

function stubRect(el: HTMLElement): void {
  el.getBoundingClientRect = () => ({
    top: 0, left: 0, right: 200, bottom: 80, width: 200, height: 80, x: 0, y: 0,
    toJSON() { return {} },
  })
}

function eligibleField(): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  document.body.appendChild(el)
  stubRect(el)
  return el
}

function show(el: HTMLTextAreaElement): void {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

function affordanceHost(): HTMLElement {
  return document.documentElement.querySelector('[data-fw-affordance]') as HTMLElement
}

function chipButton(): HTMLButtonElement {
  return affordanceHost().shadowRoot!.querySelector('button')!
}

function clickChip(): void {
  chipButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function lastConnectedPort(): MockPort {
  const results = browserMock.runtime.connect.mock.results
  return results[results.length - 1].value as MockPort
}

function fieldIdFromConnect(port: MockPort): string {
  const call = port.postMessage.mock.calls.find(
    ([msg]) => (msg as { relay?: { type?: string } }).relay?.type === 'fieldConnected',
  )
  return (call![0] as { relay: { payload: { fieldId: string } } }).relay.payload.fieldId
}

describe('scout: ctl detach fieldId filter', () => {
  it('ignores a detach naming a foreign fieldId, but detaches locally + idles the chip for its own fieldId', () => {
    const el = eligibleField()
    show(el)
    const port = lastConnectedPort()
    clickChip()
    const fieldId = fieldIdFromConnect(port)
    expect(chipButton().dataset.state).toBe('busy')

    port.onMessage.emit({ ctl: { kind: 'detach', fieldId: 'not-this-field' } })
    expect(chipButton().dataset.state).toBe('busy')

    port.onMessage.emit({ ctl: { kind: 'detach', fieldId } })
    expect(chipButton().dataset.state).toBe('idle')

    port.onDisconnect.emit(port)
    el.remove()
  })
})

describe('scout: port onDisconnect', () => {
  it('idles the chip, keeps the affordance host in the DOM, and the next interaction opens a NEW port', () => {
    const el = eligibleField()
    show(el)
    expect(browserMock.runtime.connect).toHaveBeenCalledTimes(1)
    const port1 = lastConnectedPort()
    clickChip()
    expect(chipButton().dataset.state).toBe('busy')

    port1.onDisconnect.emit(port1)

    expect(chipButton().dataset.state).toBe('idle')
    expect(document.documentElement.querySelector('[data-fw-affordance]')).not.toBeNull()

    show(el)
    expect(browserMock.runtime.connect).toHaveBeenCalledTimes(2)
    const port2 = lastConnectedPort()
    expect(port2).not.toBe(port1)

    port2.onDisconnect.emit(port2)
    el.remove()
  })
})

describe('scout: ctl status', () => {
  it('maps phase to chip state/count, including signed-out and error', () => {
    const el = eligibleField()
    show(el)
    const port = lastConnectedPort()
    clickChip()

    port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 2 } })
    expect(chipButton().dataset.state).toBe('connected')
    expect(chipButton().textContent).toBe('2')

    port.onMessage.emit({ ctl: { kind: 'status', phase: 'idle', findingCount: 0 } })
    expect(chipButton().dataset.state).toBe('connected')
    expect(chipButton().textContent).toBe('✓')

    port.onMessage.emit({ ctl: { kind: 'status', phase: 'signed-out', findingCount: 0 } })
    expect(chipButton().dataset.state).toBe('signed-out')
    expect(chipButton().textContent).toBe('⚠')

    port.onMessage.emit({ ctl: { kind: 'status', phase: 'error', findingCount: 0 } })
    expect(chipButton().dataset.state).toBe('error')
    expect(chipButton().textContent).toBe('!')

    port.onDisconnect.emit(port)
    el.remove()
  })
})

describe('scout: hide-on-leave round trip (chip side)', () => {
  it('field -> chip -> away from both hides the chip after the delay', () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      show(el)
      const host = affordanceHost()
      expect(host.style.display).not.toBe('none')

      // Leaving the field toward the chip must not hide it.
      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: host }))
      vi.advanceTimersByTime(PAST_HIDE_DELAY_MS)
      expect(host.style.display).not.toBe('none')

      // Leaving the CHIP toward neither the field nor anywhere in
      // particular must schedule the same delayed hide (the bug: this
      // path previously scheduled nothing at all, leaving the chip stuck
      // visible forever once hovered).
      host.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
      expect(host.style.display).not.toBe('none') // not yet — still within the delay
      vi.advanceTimersByTime(PAST_HIDE_DELAY_MS)
      expect(host.style.display).toBe('none')

      const port = lastConnectedPort()
      port.onDisconnect.emit(port)
      el.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('field -> chip -> back to the field keeps the chip shown', () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      show(el)
      const host = affordanceHost()

      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: host }))
      host.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: el }))
      vi.advanceTimersByTime(PAST_HIDE_DELAY_MS)

      expect(host.style.display).not.toBe('none')

      const port = lastConnectedPort()
      port.onDisconnect.emit(port)
      el.remove()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('scout: chip state is gated per shown field', () => {
  it('shows idle for a different, unconnected field while another field\'s session is live', () => {
    const elA = eligibleField()
    show(elA)
    const portA = lastConnectedPort()
    clickChip()
    portA.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 1 } })
    expect(chipButton().dataset.state).toBe('connected')

    const elB = eligibleField()
    show(elB)

    expect(chipButton().dataset.state).toBe('idle')

    portA.onDisconnect.emit(portA)
    elA.remove()
    elB.remove()
  })
})
