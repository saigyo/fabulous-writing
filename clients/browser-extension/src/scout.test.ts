// Drives scout.ts's wiring through the global browser mock's stub port and
// real (delegated, document-level) DOM events — see scout.ts's own module
// comment for why a single shared import is safe here: every test below
// ends by disconnecting whatever port it opened, which is what actually
// resets scout's module-scoped session/port state back to a clean baseline
// for the next test (vi.resetModules() would instead leave STALE document
// listeners from a torn-down module instance attached alongside the fresh
// ones — worse, not better, isolation). Only the three behaviors the brief
// pins are covered here; the hover/focus delegation delay is exercised
// structurally by the build + the manual gesture check (Task 7 step 5), not
// unit-tested. The pagehide/bfcache teardown (Copilot round 3, S6) IS
// unit-tested below, since a real 'pagehide' event dispatches and runs
// scout's listener the same as any other delegated one under happy-dom.
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
  // affordance.ts's click handler now requires event.isTrusted (I4) — a
  // synthetic vitest/happy-dom event is untrusted by default, so it must be
  // stamped here, same as affordance.test.ts's own trustedClick() helper.
  const ev = new MouseEvent('click', { bubbles: true })
  Object.defineProperty(ev, 'isTrusted', { value: true })
  chipButton().dispatchEvent(ev)
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

describe('scout: leave handling is identity-based (Copilot round 3, S1)', () => {
  it('a leave from a field that became disabled/ineligible mid-blur still hides the chip', () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      show(el)
      const host = affordanceHost()
      expect(host.style.display).not.toBe('none')

      // Simulate a blur handler that disables the field before the
      // mouseout/focusout listener runs — isEligibleField(el) is now false,
      // but the leave must still be based on el === shownEl, not eligibility.
      el.disabled = true
      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
      vi.advanceTimersByTime(PAST_HIDE_DELAY_MS)
      expect(host.style.display).toBe('none')

      const port = lastConnectedPort()
      port.onDisconnect.emit(port)
      el.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a leave event from a different, never-shown textarea does not hide the current chip', () => {
    vi.useFakeTimers()
    try {
      const shown = eligibleField()
      const other = eligibleField()
      show(shown)
      const host = affordanceHost()
      expect(host.style.display).not.toBe('none')

      other.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
      vi.advanceTimersByTime(PAST_HIDE_DELAY_MS)
      expect(host.style.display).not.toBe('none')

      const port = lastConnectedPort()
      port.onDisconnect.emit(port)
      shown.remove()
      other.remove()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('scout: pagehide/bfcache teardown (Copilot round 3, S6; I2 closing sweep)', () => {
  it('resets session/shown/port state on pagehide so a post-restore focusin shows a clean idle chip through a NEW port', () => {
    const el = eligibleField()
    show(el)
    expect(browserMock.runtime.connect).toHaveBeenCalledTimes(1)
    const port = lastConnectedPort()
    clickChip()
    port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 3 } })
    expect(chipButton().dataset.state).toBe('connected')

    // pagehide (e.g. navigating away, possibly into the bfcache).
    window.dispatchEvent(new Event('pagehide'))
    expect(affordanceHost()).toBeNull()
    // I2: the port itself must be disconnected and nulled too, not just the
    // session/shown state above — otherwise ensurePort() would hand back
    // this same (possibly already-severed) port forever.
    expect(port.disconnect).toHaveBeenCalledTimes(1)

    // pageshow from the bfcache restores the page without re-running any
    // module top-level code — the next interaction is a plain focusin on the
    // SAME field.
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    const freshHost = affordanceHost()
    expect(freshHost).not.toBeNull()
    // The bug: without resetting session/sessionEl, this would read
    // 'connected' (the stale, already-stopped session's own last state)
    // instead of a clean idle chip for the field's post-restore reconnect.
    expect(freshHost!.shadowRoot!.querySelector('button')!.dataset.state).toBe('idle')
    // I2 / M14: the post-restore interaction above must have opened a NEW
    // port, not reused the pre-pagehide (nulled) one.
    expect(browserMock.runtime.connect).toHaveBeenCalledTimes(2)
    const newPort = lastConnectedPort()
    expect(newPort).not.toBe(port)

    // A trailing disconnect of the OLD, already-nulled port must be a
    // harmless no-op — tolerant of the port having been nulled out from
    // under it.
    port.onDisconnect.emit(port)
    newPort.onDisconnect.emit(newPort)
    el.remove()
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

describe('scout: I3 closing sweep — a throwing runtime.connect must not escape hover delegation', () => {
  it('a throwing browser.runtime.connect ("Extension context invalidated") during hover does not throw out of the mouseover listener', () => {
    // The scout is the one context that lives in an arbitrary, long-lived
    // host page — an extension reload/update while the tab stays open makes
    // EVERY browser.runtime.connect call throw, and showAffordance() (run
    // from document-level mouseover delegation) calls ensurePort()
    // unconditionally. Before I3, this threw uncaught on every hover over
    // any textarea on the page, forever, for the life of the tab.
    browserMock.runtime.connect.mockImplementationOnce(() => {
      throw new Error('Extension context invalidated.')
    })
    const el = eligibleField()

    expect(() => show(el)).not.toThrow()
    expect(chipButton().dataset.state).toBe('idle')

    el.remove()
  })
})
