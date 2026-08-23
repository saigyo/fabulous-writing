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
import { setServerUrl } from './settings'
import { browserMock, type MockPort } from './testing/browserMock'
import './scout'

// Must exceed scout.ts's own (private) HIDE_DELAY_MS — this file has no
// access to that constant, so it advances generously past it instead of
// mirroring the exact value.
const PAST_HIDE_DELAY_MS = 1000
// Same reasoning, for scout.ts's own (private) PING_INTERVAL_MS (F1).
const PAST_PING_INTERVAL_MS = 21_000

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

function trustedClick(): MouseEvent {
  // affordance.ts's click handlers now require event.isTrusted (I4) — a
  // synthetic vitest/happy-dom event is untrusted by default, so it must be
  // stamped here, same as affordance.test.ts's own trustedClick() helper.
  const ev = new MouseEvent('click', { bubbles: true })
  Object.defineProperty(ev, 'isTrusted', { value: true })
  return ev
}

function clickChip(): void {
  chipButton().dispatchEvent(trustedClick())
}

function disconnectButton(): HTMLButtonElement {
  return affordanceHost().shadowRoot!.querySelector('.disconnect')!
}

function clickDisconnect(): void {
  disconnectButton().dispatchEvent(trustedClick())
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

function allFieldConnectedIds(port: MockPort): string[] {
  return port.postMessage.mock.calls
    .filter(([msg]) => (msg as { relay?: { type?: string } }).relay?.type === 'fieldConnected')
    .map(([msg]) => (msg as { relay: { payload: { fieldId: string } } }).relay.payload.fieldId)
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

// Copilot round 5, F5: the chip is now reachable by keyboard (Tab lands on
// it right after the field, since affordance.ts's showFor inserts the host
// as the field's own next sibling). handleEnter's isChipHost(target) check
// already covered this via the SHARED focusin/mouseover delegation — this
// pins that a keyboard focus round-trip (not just a pointer one) keeps the
// chip shown.
describe('scout: hide-on-leave round trip via keyboard focus (F5, round 5)', () => {
  it('Tab from the field onto the chip keeps it shown, and Shift+Tab back to the field keeps it shown too', () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      show(el)
      const host = affordanceHost()
      expect(host.style.display).not.toBe('none')

      // Tab from the field: focus leaves the field toward the host (an
      // event crossing the shadow boundary is retargeted to the host by
      // the platform, so dispatching focusin ON the host directly models
      // a real Tab keypress landing on the chip button inside it).
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: host }))
      host.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      vi.advanceTimersByTime(PAST_HIDE_DELAY_MS)
      expect(host.style.display).not.toBe('none')

      // Shift+Tab back to the field.
      host.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: el }))
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

    // F3 (Copilot round 4, closing sweep): the OLD port's onDisconnect
    // callback was captured against that specific port instance, so firing
    // it now (simulating a queued disconnect that lands AFTER the restore
    // already opened newPort) must be a no-op — not tear down the new
    // session/port. Assert the survivors are untouched: no new connect, the
    // chip still idle (not reset to some torn-down state), and a real click
    // on the current field still reuses newPort rather than opening a third.
    port.onDisconnect.emit(port)
    expect(browserMock.runtime.connect).toHaveBeenCalledTimes(2)
    expect(freshHost!.shadowRoot!.querySelector('button')!.dataset.state).toBe('idle')

    clickChip()
    expect(browserMock.runtime.connect).toHaveBeenCalledTimes(2)
    expect(lastConnectedPort()).toBe(newPort)
    expect(chipButton().dataset.state).toBe('busy')

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

// Live-test UX decision (B43 C2, PR #139): the chip is a split pill — a
// plain click on the main segment is never destructive; only the × (or the
// panel's Disconnect button, via ctl) disconnects.
describe('scout: split-pill click routing (live-test UX decision, B43 C2 PR #139)', () => {
  it('clicking the main segment while connected re-opens the panel instead of disconnecting', () => {
    const el = eligibleField()
    show(el)
    const port = lastConnectedPort()
    clickChip()
    port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 0 } })
    expect(chipButton().dataset.state).toBe('connected')

    const openPanelCalls = () => port.postMessage.mock.calls.filter(
      ([msg]) => (msg as { ctl?: { kind?: string } }).ctl?.kind === 'openPanel',
    ).length
    const before = openPanelCalls()

    clickChip()

    expect(openPanelCalls()).toBe(before + 1)
    // Still connected — the click did NOT disconnect.
    expect(chipButton().dataset.state).toBe('connected')

    port.onDisconnect.emit(port)
    el.remove()
  })

  it('clicking the × segment while connected disconnects (fieldDisconnected sent, chip idle)', () => {
    const el = eligibleField()
    show(el)
    const port = lastConnectedPort()
    clickChip()
    port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 0 } })
    expect(chipButton().dataset.state).toBe('connected')

    clickDisconnect()

    expect(chipButton().dataset.state).toBe('idle')
    const fieldDisconnectedSent = port.postMessage.mock.calls.some(
      ([msg]) => (msg as { relay?: { type?: string } }).relay?.type === 'fieldDisconnected',
    )
    expect(fieldDisconnectedSent).toBe(true)

    port.onDisconnect.emit(port)
    el.remove()
  })

  it('a ctl disconnect from the sw (panel Disconnect button) has the same effect as the ×', () => {
    const el = eligibleField()
    show(el)
    const port = lastConnectedPort()
    clickChip()
    port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 0 } })
    expect(chipButton().dataset.state).toBe('connected')

    port.onMessage.emit({ ctl: { kind: 'disconnect' } })

    expect(chipButton().dataset.state).toBe('idle')

    port.onDisconnect.emit(port)
    el.remove()
  })
})

// Live-test finding (B43 C2, PR #139): a React-style host (GitHub's own
// composer included) commonly replaces the field's DOM node on blur —
// session.ts's MutationObserver correctly self-detaches, but a hard stop
// there used to cost the whole session. scout.ts now opens a short grace
// window that probes for a same-fingerprint replacement first.
// F1 (B43 C2 round 3): the keepalive ping timer starts the moment a session
// becomes active and stops the moment it doesn't — a quiet stretch (an LLM
// check running, the user reading findings) with no other port traffic must
// still keep Chrome's ~30s MV3 idle timer from firing and dropping the
// session.
describe('scout: F1 keepalive ping timer', () => {
  function pingCount(port: MockPort): number {
    return port.postMessage.mock.calls.filter(
      ([msg]) => (msg as { ctl?: { kind?: string } }).ctl?.kind === 'ping',
    ).length
  }

  it('sends no ping before a session starts, then one ctl ping per interval while connected', () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      show(el)
      const port = lastConnectedPort()

      // No session yet (idle chip) — no ping timer running.
      vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
      expect(pingCount(port)).toBe(0)

      clickChip()
      expect(pingCount(port)).toBe(0)

      vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
      expect(pingCount(port)).toBe(1)

      vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
      expect(pingCount(port)).toBe(2)

      port.onDisconnect.emit(port)
      el.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops pinging once the session is disconnected (the × segment)', () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      show(el)
      const port = lastConnectedPort()
      clickChip()
      vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
      expect(pingCount(port)).toBe(1)

      clickDisconnect()
      const afterDisconnect = pingCount(port)

      vi.advanceTimersByTime(PAST_PING_INTERVAL_MS * 2)
      expect(pingCount(port)).toBe(afterDisconnect)

      port.onDisconnect.emit(port)
      el.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops pinging once the port itself dies', () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      show(el)
      const port = lastConnectedPort()
      clickChip()
      vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
      expect(pingCount(port)).toBe(1)

      port.onDisconnect.emit(port)

      vi.advanceTimersByTime(PAST_PING_INTERVAL_MS * 2)
      // The port is dead — nothing to assert pings against, but a live
      // (unhandled) timer would throw trying to post through the reused
      // mock, or a subsequent interaction would open a second, spuriously
      // ping-armed port. Reconnecting confirms no stray timer survived.
      show(el)
      const newPort = lastConnectedPort()
      expect(newPort).not.toBe(port)
      expect(pingCount(newPort)).toBe(0)
      vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
      expect(pingCount(newPort)).toBe(0)

      newPort.onDisconnect.emit(newPort)
      el.remove()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('scout: field re-acquisition after DOM replacement (live-test finding, B43 C2 PR #139)', () => {
  it('a same-id replacement appearing within the grace window silently reconnects: a NEW fieldConnected is sent, the chip never goes idle', async () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      el.id = 'box'
      show(el)
      const port = lastConnectedPort()
      clickChip()
      port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 0 } })
      expect(chipButton().dataset.state).toBe('connected')
      expect(allFieldConnectedIds(port)).toHaveLength(1)

      // A React-style rebuild: a fresh same-id node appears, the old one
      // leaves — both in the same synchronous tick, as a real re-render
      // would do it.
      const replacement = eligibleField()
      replacement.id = 'box'
      el.remove()
      // session.ts's MutationObserver self-detach fires as a microtask.
      await Promise.resolve()

      // No idle flicker while scout is still quietly probing.
      expect(chipButton().dataset.state).not.toBe('idle')

      vi.advanceTimersByTime(300) // > the reacquire poll interval

      expect(allFieldConnectedIds(port)).toHaveLength(2)
      // A genuinely NEW session (new fieldId) — not the old one resent.
      expect(allFieldConnectedIds(port)[1]).not.toBe(allFieldConnectedIds(port)[0])
      expect(chipButton().dataset.state).not.toBe('idle')

      port.onDisconnect.emit(port)
      replacement.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('no replacement within the grace window: the chip goes idle and no reconnect happens', async () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      el.id = 'box'
      show(el)
      const port = lastConnectedPort()
      clickChip()
      port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 0 } })
      expect(allFieldConnectedIds(port)).toHaveLength(1)

      el.remove()
      await Promise.resolve()

      vi.advanceTimersByTime(2500) // > the reacquire grace window, nothing ever appears

      expect(chipButton().dataset.state).toBe('idle')
      expect(allFieldConnectedIds(port)).toHaveLength(1) // no reconnect happened

      port.onDisconnect.emit(port)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a user-initiated disconnect (×) does not start a reacquire probe', async () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      el.id = 'box'
      show(el)
      const port = lastConnectedPort()
      clickChip()
      port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 0 } })
      expect(allFieldConnectedIds(port)).toHaveLength(1)

      clickDisconnect()
      expect(chipButton().dataset.state).toBe('idle')

      // Same shape as the successful-reacquire test above (a same-id
      // replacement appears after the field leaves) — but this time there
      // is no live/reacquiring session for it to matter to.
      const replacement = eligibleField()
      replacement.id = 'box'
      el.remove()
      await Promise.resolve()

      vi.advanceTimersByTime(2500)

      expect(allFieldConnectedIds(port)).toHaveLength(1) // no second connect
      expect(chipButton().dataset.state).toBe('idle')

      port.onDisconnect.emit(port)
      replacement.remove()
    } finally {
      vi.useRealTimers()
    }
  })
})

// Issue #142 round 2 (Copilot finding): sw.ts's registry-driven
// serverChanged() has no entry for a field mid-reacquire (its own removal
// already cleared the registry) — the scout must abort the grace window
// itself, and must also locally tear down a LIVE session as belt-and-
// suspenders for a lost/never-arriving SW detach ctl.
describe('scout: server-URL change (issue #142 round 2)', () => {
  it('aborts a pending reacquire outright: probing stops, chip idles, and a matching element ' +
    'appearing afterward does not rebind', async () => {
    vi.useFakeTimers()
    try {
      const el = eligibleField()
      el.id = 'box'
      show(el)
      const port = lastConnectedPort()
      clickChip()
      port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 0 } })
      expect(allFieldConnectedIds(port)).toHaveLength(1)

      el.remove()
      await Promise.resolve() // session.ts's MutationObserver self-detach -> beginReacquire
      expect(chipButton().dataset.state).not.toBe('idle') // still probing

      await setServerUrl('https://other.example')

      expect(chipButton().dataset.state).toBe('idle')

      // A same-id replacement appears AFTER the URL change — must not
      // rebind even though it would have matched the (now-aborted) probe.
      const replacement = eligibleField()
      replacement.id = 'box'
      vi.advanceTimersByTime(2500) // > the reacquire grace window

      expect(allFieldConnectedIds(port)).toHaveLength(1) // no second connect
      expect(chipButton().dataset.state).toBe('idle')

      port.onDisconnect.emit(port)
      replacement.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it('locally detaches and idles a LIVE session, without any SW detach ctl ever arriving on the ' +
    'port', async () => {
    const el = eligibleField()
    el.id = 'box'
    show(el)
    const port = lastConnectedPort()
    clickChip()
    port.onMessage.emit({ ctl: { kind: 'status', phase: 'checking', findingCount: 0 } })
    expect(chipButton().dataset.state).toBe('connected')
    expect(allFieldConnectedIds(port)).toHaveLength(1)

    // No incoming ctl of any kind — this teardown must be entirely
    // client-side, driven by the settings subscription itself.
    await setServerUrl('https://another.example')

    expect(chipButton().dataset.state).toBe('idle')

    // Reconnecting produces a genuinely NEW session (new fieldId), proving
    // the old one was actually torn down (adapter disposed, session
    // nulled) rather than just painted idle cosmetically.
    clickChip()
    expect(allFieldConnectedIds(port)).toHaveLength(2)
    expect(allFieldConnectedIds(port)[1]).not.toBe(allFieldConnectedIds(port)[0])

    port.onDisconnect.emit(port)
    el.remove()
  })

  it('is a no-op when there is no live session and no pending reacquire', async () => {
    const el = eligibleField()
    show(el)
    const port = lastConnectedPort()
    expect(chipButton().dataset.state).toBe('idle')

    await setServerUrl('https://yet-another.example')

    expect(chipButton().dataset.state).toBe('idle')
    port.onDisconnect.emit(port)
    el.remove()
  })
})
