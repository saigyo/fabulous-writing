// @vitest-environment happy-dom
//
// main.ts is the host simulator's bootstrap script (coverage-excluded, like
// src/main.tsx and src/embed/main.tsx — see vite.config.ts): it wires itself
// up against DOM elements at import time rather than exposing a factory.
// Testing it means recreating simulator.html's fixture and re-importing the
// module fresh per test (vi.resetModules(), mirroring
// state/prefsPersistence.test.ts's "boot wiring" tests).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHostMessage, PROTOCOL_VERSION } from '../embed/protocol'

function setUpFixture() {
  document.body.innerHTML = `
    <button id="connect" type="button">Connect</button>
    <button id="disconnect" type="button">Disconnect</button>
    <span id="sim-status">not connected</span>
    <textarea id="field">hello world</textarea>
    <iframe id="embed"></iframe>
  `
}

// happy-dom-only escape hatch to change the test window's URL (main.ts reads
// location.search once, at import time, to decide desyncMode) — not part of
// the standard DOM API surface, hence the cast.
function setTestUrl(url: string) {
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)
}

function embedMessage(
  iframeEl: HTMLIFrameElement,
  data: Record<string, unknown>,
  opts?: { origin?: string; source?: Window | null },
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { fw: PROTOCOL_VERSION, ...data },
      origin: opts?.origin ?? location.origin,
      source: opts?.source === undefined ? iframeEl.contentWindow : opts.source,
    }),
  )
}

beforeEach(() => {
  vi.resetModules()
  setUpFixture()
})

// Copilot round 3: a manual iframe reload during a hand-check drops in a
// fresh embed shim that has no memory of the prior session — it never
// readies/connects on its own, and it silently ignores any textChanged sent
// against the simulator's stale belief that a field is still connected.
describe('simulator main: iframe load resets stale ready/connected state', () => {
  it('a second load event re-disables Connect, clears markings, and prompts reconnect', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    // happy-dom's bare (src-less) iframe gets a real contentWindow at a
    // 'null' origin — a genuine cross-origin postMessage from the test's
    // http://localhost origin would throw. main.ts's own send() isn't under
    // test here (bridge.test.ts covers the wire format); stub it so hello's
    // fire-and-forget postMessage doesn't blow up. Installed BEFORE import:
    // main.ts now also sends an eager hello at module load time (Copilot
    // round 4), ahead of any 'load' event.
    vi.spyOn(iframeEl.contentWindow!, 'postMessage').mockImplementation(() => {})
    await import('./main')
    const connectBtn = document.getElementById('connect') as HTMLButtonElement
    const statusEl = document.getElementById('sim-status') as HTMLElement

    // First load: the embed boots, readies, and the host connects.
    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    expect(connectBtn.disabled).toBe(false)

    connectBtn.click()
    expect(statusEl.textContent).toBe('connected')

    // A finding arrives and gets marked on the overlay.
    embedMessage(iframeEl, {
      type: 'findings',
      payload: {
        fieldId: 'sim-field',
        findings: [{ id: 'f1', from: 0, to: 5, severity: 'warning', category: 'style' }],
      },
    })
    expect(document.querySelector('[data-finding-ids~="f1"]')).not.toBeNull()

    // The iframe reloads — a fresh shim, with no fieldConnected of its own.
    iframeEl.dispatchEvent(new Event('load'))

    expect(connectBtn.disabled).toBe(true)
    expect(statusEl.textContent).not.toBe('connected')
    expect(document.querySelector('[data-finding-ids~="f1"]')).toBeNull()
  })

  it('a stale ready from before the reload no longer re-enables Connect ahead of the fresh shim (old hello timer cleared)', async () => {
    vi.useFakeTimers()
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    vi.spyOn(iframeEl.contentWindow!, 'postMessage').mockImplementation(() => {})
    await import('./main')
    const connectBtn = document.getElementById('connect') as HTMLButtonElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    connectBtn.click()

    iframeEl.dispatchEvent(new Event('load'))
    expect(connectBtn.disabled).toBe(true)

    // The fresh shim readies for real — Connect becomes available again.
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    expect(connectBtn.disabled).toBe(false)

    vi.useRealTimers()
  })
})

// Copilot round 11: applyReplacement used to call the adapter unconditionally,
// even for a delayed/mismatched request arriving after a disconnect/reload —
// unlike the other field-scoped handlers (findings, selectFinding), which all
// check payload.fieldId. A stale or mismatched-field request could still
// mutate the live textarea.
describe('simulator main: applyReplacement is scoped to connected + fieldId', () => {
  // Finding 20: the refusal echoes the FOREIGN request's own fieldId (not
  // FIELD_ID) and an empty string, not this field's real text — the embed's
  // shim discards a replaceResult whose fieldId doesn't match its connected
  // field anyway (hostDoc.ts's replaceResult), so this field's text was
  // never legitimately meant for that reply.
  it('a mismatched-field request leaves the textarea untouched and echoes the FOREIGN fieldId with empty text', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const fieldEl = document.getElementById('field') as HTMLTextAreaElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    const connectBtn = document.getElementById('connect') as HTMLButtonElement
    connectBtn.click()

    const before = fieldEl.value
    postMessage.mockClear()
    embedMessage(iframeEl, {
      type: 'applyReplacement',
      requestId: 'req-1',
      payload: { fieldId: 'not-sim-field', from: 0, to: 5, insert: 'xxxxx', expectedText: 'hello' },
    })

    expect(fieldEl.value).toBe(before) // untouched
    const [message] = postMessage.mock.calls[0]
    expect(message).toMatchObject({
      type: 'replaceResult',
      requestId: 'req-1',
      payload: { fieldId: 'not-sim-field', ok: false, text: '' },
    })
  })

  it('a request while not connected leaves the textarea untouched and answers ok:false', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const fieldEl = document.getElementById('field') as HTMLTextAreaElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    // Deliberately not clicking Connect — never transitions to connected.

    const before = fieldEl.value
    postMessage.mockClear()
    embedMessage(iframeEl, {
      type: 'applyReplacement',
      requestId: 'req-2',
      payload: { fieldId: 'sim-field', from: 0, to: 5, insert: 'xxxxx', expectedText: 'hello' },
    })

    expect(fieldEl.value).toBe(before)
    const [message] = postMessage.mock.calls[0]
    expect(message).toMatchObject({
      type: 'replaceResult',
      requestId: 'req-2',
      payload: { fieldId: 'sim-field', ok: false, text: before },
    })
  })
})

// Finding 6: a throw from the adapter's applyReplacement (real DOM edge
// cases the reference host doesn't fully characterize) must not take down
// main.ts's message listener — it must answer the same ok:false refusal the
// adapter's own range guard would give, with the CURRENT (unmutated) text.
describe('simulator main: applyReplacement survives a throwing adapter', () => {
  it('answers ok:false with the current text instead of propagating the throw', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const fieldEl = document.getElementById('field') as HTMLTextAreaElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    const connectBtn = document.getElementById('connect') as HTMLButtonElement
    connectBtn.click()

    // setSelectionRange throws a real DOMException for a negative start
    // once past the adapter's own range guard is the failure mode this
    // covers in a real browser; happy-dom doesn't implement
    // setSelectionRange's own validation, so stub it to force the throw
    // path deterministically instead of relying on that.
    vi.spyOn(fieldEl, 'setSelectionRange').mockImplementation(() => {
      throw new DOMException('boom')
    })
    const before = fieldEl.value
    postMessage.mockClear()
    embedMessage(iframeEl, {
      type: 'applyReplacement',
      requestId: 'req-3',
      payload: { fieldId: 'sim-field', from: 0, to: 5, insert: 'xxxxx', expectedText: before.slice(0, 5) },
    })

    expect(fieldEl.value).toBe(before)
    const [message] = postMessage.mock.calls[0]
    expect(message).toMatchObject({
      type: 'replaceResult',
      requestId: 'req-3',
      payload: { fieldId: 'sim-field', ok: false, text: before },
    })
  })
})

// Copilot round 4: main.ts is a deferred module script, so a cached
// /embed.html can finish loading and register its own message listener
// before this script's 'load' listener even runs — waiting for 'load' alone
// to arm the hello-retry loop can miss that window entirely. The loop must
// start eagerly too.
describe('simulator main: eager hello retry loop', () => {
  it('sends hello and can be answered by a ready before any load event fires', async () => {
    vi.useFakeTimers()
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})

    await import('./main')
    const connectBtn = document.getElementById('connect') as HTMLButtonElement

    // The eager hello fires at import time, with no 'load' event dispatched.
    expect(postMessage).toHaveBeenCalled()
    const [message] = postMessage.mock.calls[0]
    expect((message as { type: string }).type).toBe('hello')

    // The retry loop is live too, not just the one-shot call.
    postMessage.mockClear()
    vi.advanceTimersByTime(250)
    expect(postMessage).toHaveBeenCalled()

    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    expect(connectBtn.disabled).toBe(false)

    vi.useRealTimers()
  })
})


// Finding 7: the simulator plays the HOST role of the protocol — everything
// it sends must itself be a well-formed HostMessage (parseHostMessage is the
// same hardened validator the real embed runs incoming messages through),
// posted only to location.origin (never '*' or some other value a hostile
// listener could read).
describe('simulator main: conformance pins', () => {
  it('every outbound envelope in a scripted session parses as a valid HostMessage, posted to location.origin', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const connectBtn = document.getElementById('connect') as HTMLButtonElement
    const fieldEl = document.getElementById('field') as HTMLTextAreaElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    connectBtn.click() // -> fieldConnected
    fieldEl.value = 'hello world!'
    fieldEl.dispatchEvent(new Event('input')) // -> textChanged
    embedMessage(iframeEl, {
      type: 'findings',
      payload: {
        fieldId: 'sim-field',
        findings: [{ id: 'f1', from: 0, to: 5, severity: 'warning', category: 'style' }],
      },
    })
    fieldEl.selectionStart = 2
    fieldEl.selectionEnd = 2
    fieldEl.dispatchEvent(new Event('click')) // -> markingClicked (hits the f1 span)
    embedMessage(iframeEl, {
      type: 'applyReplacement',
      requestId: 'r1',
      payload: { fieldId: 'sim-field', from: 0, to: 5, insert: 'HELLO', expectedText: 'hello' },
    }) // -> replaceResult

    expect(postMessage.mock.calls.length).toBeGreaterThan(0)
    for (const [message, origin] of postMessage.mock.calls) {
      expect(parseHostMessage(message)).not.toBeNull()
      expect(origin).toBe(location.origin)
    }
  })

  // Finding 7(c): capabilities and meta are exactly what hostDoc.ts's
  // fieldConnected() needs to publish connectedField and pick a replace
  // strategy — omitting either would silently degrade the whole session.
  it('Connect emits a fieldConnected carrying capabilities and meta', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const connectBtn = document.getElementById('connect') as HTMLButtonElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    postMessage.mockClear()
    connectBtn.click()

    const [message] = postMessage.mock.calls[0]
    expect(message).toMatchObject({
      type: 'fieldConnected',
      payload: {
        fieldId: 'sim-field',
        capabilities: { mark: 'overlay', replace: 'reliable' },
        meta: { fieldKind: 'textarea' },
      },
    })
    const fieldConnected = message as { payload: { meta: { url: string } } }
    expect(typeof fieldConnected.payload.meta.url).toBe('string')
    expect(fieldConnected.payload.meta.url.length).toBeGreaterThan(0)
  })

  // Finding 7(d): the simulator's own listener (main.ts, not the embed's
  // bridge.ts) must apply the same origin+source pinning discipline to
  // messages it receives, even though it's a dev-only harness.
  describe('negative paths: wrong origin / wrong source are no-ops', () => {
    it('a ready from the wrong origin does not enable Connect', async () => {
      const iframeEl = document.getElementById('embed') as HTMLIFrameElement
      vi.spyOn(iframeEl.contentWindow!, 'postMessage').mockImplementation(() => {})
      await import('./main')
      const connectBtn = document.getElementById('connect') as HTMLButtonElement

      iframeEl.dispatchEvent(new Event('load'))
      embedMessage(
        iframeEl,
        { type: 'ready', payload: { protocolVersion: PROTOCOL_VERSION, features: [] } },
        { origin: 'https://evil.example' },
      )

      expect(connectBtn.disabled).toBe(true)
    })

    it('a ready from the wrong source does not enable Connect', async () => {
      const iframeEl = document.getElementById('embed') as HTMLIFrameElement
      vi.spyOn(iframeEl.contentWindow!, 'postMessage').mockImplementation(() => {})
      await import('./main')
      const connectBtn = document.getElementById('connect') as HTMLButtonElement
      const impostor = { postMessage: vi.fn() } as unknown as Window

      iframeEl.dispatchEvent(new Event('load'))
      embedMessage(
        iframeEl,
        { type: 'ready', payload: { protocolVersion: PROTOCOL_VERSION, features: [] } },
        { source: impostor },
      )

      expect(connectBtn.disabled).toBe(true)
    })
  })
})


// Finding 19: the Disconnect button is the human-driven counterpart to a
// host-initiated fieldDisconnected — it must send the wire message AND
// clear the local overlay's markings so the demo textarea doesn't keep
// showing stale highlights for a field the embed was just told is gone.
describe('simulator main: Disconnect button', () => {
  it('sends fieldDisconnected, clears markings, and re-enables Connect', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const connectBtn = document.getElementById('connect') as HTMLButtonElement
    const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    connectBtn.click()
    embedMessage(iframeEl, {
      type: 'findings',
      payload: {
        fieldId: 'sim-field',
        findings: [{ id: 'f1', from: 0, to: 5, severity: 'warning', category: 'style' }],
      },
    })
    expect(document.querySelector('[data-finding-ids~="f1"]')).not.toBeNull()
    expect(disconnectBtn.disabled).toBe(false)

    postMessage.mockClear()
    disconnectBtn.click()

    const [message] = postMessage.mock.calls[0]
    expect(message).toMatchObject({
      type: 'fieldDisconnected',
      payload: { fieldId: 'sim-field' },
    })
    expect(document.querySelector('[data-finding-ids~="f1"]')).toBeNull()
    expect(disconnectBtn.disabled).toBe(true)
    expect(connectBtn.disabled).toBe(false) // still ready — can reconnect
  })

  it('is a no-op while not connected', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement

    postMessage.mockClear()
    disconnectBtn.click()

    expect(postMessage).not.toHaveBeenCalled()
  })
})

// Finding 21: the status line now renders even before Connect is clicked —
// a cold, unauthenticated embed can show signed-out from the start (real
// embed's F5 behavior, bridge.ts), and the simulator must reflect it rather
// than staying gated behind "connected".
describe('simulator main: pre-connect status line', () => {
  it('renders a status message received before Connect is ever clicked', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    vi.spyOn(iframeEl.contentWindow!, 'postMessage').mockImplementation(() => {})
    await import('./main')
    const statusEl = document.getElementById('sim-status') as HTMLElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    embedMessage(iframeEl, {
      type: 'status',
      payload: { phase: 'signed-out', findingCount: 0 },
    })

    expect(statusEl.textContent).toBe('signed-out (0 findings)')
  })
})

// Finding 28: an embed that never readies must not retry forever with no
// visible signal.
describe('simulator main: hello retry cap', () => {
  it('gives up after 30 attempts and shows "embed not responding"', async () => {
    vi.useFakeTimers()
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const statusEl = document.getElementById('sim-status') as HTMLElement

    // 1 eager attempt at import time + 29 more ticks reaches the 30th.
    vi.advanceTimersByTime(250 * 29)
    expect(statusEl.textContent).not.toBe('embed not responding')

    postMessage.mockClear()
    vi.advanceTimersByTime(250) // the 31st attempt: past the cap

    expect(statusEl.textContent).toBe('embed not responding')
    postMessage.mockClear()
    vi.advanceTimersByTime(250 * 5) // the retry loop is truly stopped, not just silent
    expect(postMessage).not.toHaveBeenCalled()

    vi.useRealTimers()
  })
})

// Finding 25: the desync hook's one-shot suppress/mutate state machine.
describe('simulator main: desync hook state machine (?desync=1)', () => {
  afterEach(() => {
    // Restore the un-desynced default URL so later tests in this file (and
    // any other file sharing this happy-dom window) don't inherit it.
    setTestUrl('http://localhost:3000/simulator.html')
  })

  it('does not consume the suppress flag on an edit typed before Connect', async () => {
    setTestUrl('http://localhost:3000/simulator.html?desync=1')
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const fieldEl = document.getElementById('field') as HTMLTextAreaElement
    const connectBtn = document.getElementById('connect') as HTMLButtonElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    // Typed before Connect — must not be sent, and must not consume the
    // one-shot suppress flag either.
    fieldEl.value = 'typed before connect'
    fieldEl.dispatchEvent(new Event('input'))

    connectBtn.click()
    postMessage.mockClear()
    fieldEl.value = 'typed after connect'
    fieldEl.dispatchEvent(new Event('input'))

    // The suppress flag was still armed — this first post-connect edit is
    // the one that gets suppressed (no textChanged sent for it).
    const textChangedCalls = postMessage.mock.calls.filter(
      ([m]) => (m as { type?: string }).type === 'textChanged',
    )
    expect(textChangedCalls).toHaveLength(0)
  })

  it('re-arms both flags on an iframe reload', async () => {
    setTestUrl('http://localhost:3000/simulator.html?desync=1')
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    vi.spyOn(iframeEl.contentWindow!, 'postMessage').mockImplementation(() => {})
    await import('./main')
    const fieldEl = document.getElementById('field') as HTMLTextAreaElement
    const connectBtn = document.getElementById('connect') as HTMLButtonElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    connectBtn.click()
    // Consume the suppress flag with a first post-connect edit.
    fieldEl.value = 'consumes suppress'
    fieldEl.dispatchEvent(new Event('input'))

    // Reload — a fresh session must get its own fresh one-shot pair.
    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, {
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    })
    connectBtn.click()
    const postMessage = vi.mocked(iframeEl.contentWindow!.postMessage)
    postMessage.mockClear()
    fieldEl.value = 'first edit after reload'
    fieldEl.dispatchEvent(new Event('input'))

    // Suppressed again — proves the flag was re-armed by the reload, not
    // left consumed from before it.
    const textChangedCalls = postMessage.mock.calls.filter(
      ([m]) => (m as { type?: string }).type === 'textChanged',
    )
    expect(textChangedCalls).toHaveLength(0)
  })
})
