// @vitest-environment happy-dom
//
// main.ts is the host simulator's bootstrap script (coverage-excluded, like
// src/main.tsx and src/embed/main.tsx — see vite.config.ts): it wires itself
// up against DOM elements at import time rather than exposing a factory.
// Testing it means recreating simulator.html's fixture and re-importing the
// module fresh per test (vi.resetModules(), mirroring
// state/prefsPersistence.test.ts's "boot wiring" tests).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '../embed/protocol'

function setUpFixture() {
  document.body.innerHTML = `
    <button id="connect" type="button">Connect</button>
    <span id="sim-status">not connected</span>
    <textarea id="field">hello world</textarea>
    <iframe id="embed"></iframe>
  `
}

function embedMessage(
  iframeEl: HTMLIFrameElement,
  data: Record<string, unknown>,
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { fw: PROTOCOL_VERSION, ...data },
      origin: location.origin,
      source: iframeEl.contentWindow,
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
    embedMessage(iframeEl, { type: 'ready' })
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
    embedMessage(iframeEl, { type: 'ready' })
    connectBtn.click()

    iframeEl.dispatchEvent(new Event('load'))
    expect(connectBtn.disabled).toBe(true)

    // The fresh shim readies for real — Connect becomes available again.
    embedMessage(iframeEl, { type: 'ready' })
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
  it('a mismatched-field request leaves the textarea untouched and answers ok:false', async () => {
    const iframeEl = document.getElementById('embed') as HTMLIFrameElement
    const postMessage = vi
      .spyOn(iframeEl.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await import('./main')
    const fieldEl = document.getElementById('field') as HTMLTextAreaElement

    iframeEl.dispatchEvent(new Event('load'))
    embedMessage(iframeEl, { type: 'ready' })
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
      payload: { fieldId: 'sim-field', ok: false, text: before },
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
    embedMessage(iframeEl, { type: 'ready' })
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

    embedMessage(iframeEl, { type: 'ready' })
    expect(connectBtn.disabled).toBe(false)

    vi.useRealTimers()
  })
})
