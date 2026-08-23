// I5 (B43 C2 closing sweep): panel.ts's onReadyChange posted the
// embedReady ctl directly on the raw port, three lines below the toPort
// wrapper whose own comment forbids exactly that ("a throw here ... must
// not propagate out of the window 'message' listener that calls into
// this"). MV3 suspends the worker after ~30s of no port traffic, so a quiet
// panel whose embed then reloads/readies hits port.postMessage on a
// disconnected port and throws out of that listener. This is the one test
// in the suite that drives panel.ts's own module (every other panel-side
// behavior is tested through relay.ts, the deliberately DOM-free testable
// core panel.ts wires up) — deliberately minimal: real iframe navigation is
// disabled below (network-free, no real cross-window postMessage) so the
// only thing under test is "a throwing port.postMessage must not escape".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '../../../frontend/src/embed/protocol'
import { HELLO_RETRY_MS, MAX_HELLO_ATTEMPTS } from './relay'
import { browserMock, type MockPort } from './testing/browserMock'

const SERVER_ORIGIN = 'https://fabulous-writing.fly.dev' // settings.ts's DEFAULT_SERVER_URL

function setupDom(): { iframeEl: HTMLIFrameElement } {
  document.body.innerHTML = `
    <button id="disconnect" type="button" hidden>Disconnect</button>
    <p id="status" role="status">embed not responding</p>
    <p id="hint" hidden>Click the ✳ chip on a text box to connect it.</p>
    <iframe id="embed" title="Fabulous Writing embed"></iframe>
    <button id="options" type="button">Options</button>
  `
  const iframeEl = document.getElementById('embed') as HTMLIFrameElement
  // Shadow both accessors as own, plain instance properties: this fully
  // bypasses happy-dom's real (network-hitting by default) iframe
  // navigation when panel.ts sets `.src`, and hands back a stable fake
  // window (with its own postMessage spy, since relay.ts's hello loop
  // calls it too) instead of whatever real cross-frame contentWindow
  // machinery would otherwise apply.
  Object.defineProperty(iframeEl, 'src', { value: '', writable: true, configurable: true })
  Object.defineProperty(iframeEl, 'contentWindow', {
    value: { postMessage: vi.fn() },
    configurable: true,
  })
  return { iframeEl }
}

function lastConnectedPort(): MockPort {
  const results = browserMock.runtime.connect.mock.results
  return results[results.length - 1].value as MockPort
}

const fieldConnectedEnvelope = {
  fw: PROTOCOL_VERSION,
  type: 'fieldConnected',
  payload: {
    fieldId: 'f1',
    text: '',
    capabilities: { mark: 'overlay', replace: 'reliable' },
    meta: { url: 'https://example.com', fieldKind: 'textarea' },
  },
}

const fieldDisconnectedEnvelope = {
  fw: PROTOCOL_VERSION,
  type: 'fieldDisconnected',
  payload: { fieldId: 'f1' },
}

async function bootPanel(): Promise<{ iframeEl: HTMLIFrameElement; port: MockPort }> {
  const { iframeEl } = setupDom()
  await import('./panel')
  await vi.waitFor(() => expect(browserMock.runtime.connect).toHaveBeenCalledTimes(1))
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return { iframeEl, port: lastConnectedPort() }
}

function emitReady(iframeEl: HTMLIFrameElement): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      fw: PROTOCOL_VERSION,
      type: 'ready',
      payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
    },
    origin: SERVER_ORIGIN,
    source: iframeEl.contentWindow,
  }))
}

describe('panel: I5 closing sweep — a dead port must not escape onReadyChange', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a throwing port.postMessage during the embedReady(true) send is caught, not thrown out of the window message listener', async () => {
    const { iframeEl } = setupDom()

    await import('./panel')
    // main() is async (getServerUrl, then windows.getCurrent) — flush the
    // microtask queue so panelHello has already gone out on the port
    // before this test starts making it throw.
    await vi.waitFor(() => expect(browserMock.runtime.connect).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const port = lastConnectedPort()
    port.postMessage.mockImplementationOnce(() => {
      throw new Error('Attempting to use a disconnected port object')
    })

    const onError = vi.fn()
    window.addEventListener('error', onError)
    try {
      // The embed's first 'ready' — same shape relay.fromEmbed expects,
      // routed the same way panel.ts's own window 'message' listener does:
      // origin-and-source-pinned to the iframe.
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          fw: PROTOCOL_VERSION,
          type: 'ready',
          payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
        },
        origin: SERVER_ORIGIN,
        source: iframeEl.contentWindow,
      }))
      // happy-dom's own EventTarget wraps listener bodies in try/catch and
      // re-surfaces an uncaught throw as a window 'error' event rather than
      // rethrowing to dispatchEvent's own caller — this is the only
      // reliable place to observe "did the throw escape the listener".
      expect(onError).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('error', onError)
    }
  })
})

// Live-test UX decision (B43 C2, PR #139): a one-line connect hint and a
// Disconnect button, both derived from relay.ts's fromPort observation of
// host-role fieldConnected/fieldDisconnected traffic (relay.test.ts's own
// "fromPort field-connect observation" describe block pins the derivation
// itself — this is panel.ts's own wiring of it to the DOM).
describe('panel: connect hint + Disconnect button (live-test UX decision, B43 C2 PR #139)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('the hint stays hidden until the embed readies', async () => {
    await bootPanel()
    const hintEl = document.getElementById('hint') as HTMLElement
    expect(hintEl.hidden).toBe(true)
  })

  it('the hint shows once the embed is ready, with no field connected yet', async () => {
    const { iframeEl } = await bootPanel()
    emitReady(iframeEl)
    const hintEl = document.getElementById('hint') as HTMLElement
    expect(hintEl.hidden).toBe(false)
  })

  it('a fieldConnected relay hides the hint for good, even after a later disconnect', async () => {
    const { iframeEl, port } = await bootPanel()
    emitReady(iframeEl)
    const hintEl = document.getElementById('hint') as HTMLElement
    expect(hintEl.hidden).toBe(false)

    port.onMessage.emit({ relay: fieldConnectedEnvelope })
    expect(hintEl.hidden).toBe(true)

    port.onMessage.emit({ relay: fieldDisconnectedEnvelope })
    expect(hintEl.hidden).toBe(true)
  })

  it('the Disconnect button is hidden until a field connects, shown while connected, hidden again on disconnect', async () => {
    const { port } = await bootPanel()
    const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement
    expect(disconnectBtn.hidden).toBe(true)

    port.onMessage.emit({ relay: fieldConnectedEnvelope })
    expect(disconnectBtn.hidden).toBe(false)

    port.onMessage.emit({ relay: fieldDisconnectedEnvelope })
    expect(disconnectBtn.hidden).toBe(true)
  })

  it('clicking Disconnect posts a ctl disconnect message on the port', async () => {
    const { port } = await bootPanel()
    port.onMessage.emit({ relay: fieldConnectedEnvelope })
    const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement

    disconnectBtn.click()

    expect(port.postMessage).toHaveBeenCalledWith({ ctl: { kind: 'disconnect' } })
  })

  // Copilot round 11, F5: while the registry is not-ready (the window
  // between the iframe 'load' re-arm and the new embed's next 'ready'), a
  // fieldDisconnected relay is suppressed by design (registry.ts's own
  // panelReady(false)) — a real disconnect in that window used to leave the
  // button showing "Disconnect" long after the field it named was gone.
  it('a mid-reload-window disconnect leaves the button hidden once the new embed re-readies (round 11, F5)', async () => {
    const { iframeEl, port } = await bootPanel()
    emitReady(iframeEl)
    const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement

    port.onMessage.emit({ relay: fieldConnectedEnvelope })
    expect(disconnectBtn.hidden).toBe(false)

    // iframe 'load' re-arm: relay.start()'s true->false edge — the panel
    // itself never receives a fieldDisconnected for the field that vanished
    // during this window (registry.ts suppresses it while not-ready).
    iframeEl.dispatchEvent(new Event('load'))
    // The false edge alone must already hide the button — nothing else
    // ever tells this panel the field is gone in this scenario.
    expect(disconnectBtn.hidden).toBe(true)

    // The new embed readies with NO synthesized fieldConnected (the field
    // did not survive) — the button must stay hidden.
    emitReady(iframeEl)
    expect(disconnectBtn.hidden).toBe(true)
  })

  it('a reload with a surviving field re-shows the button via the synthesized fieldConnected on re-ready (round 11, F5)', async () => {
    const { iframeEl, port } = await bootPanel()
    emitReady(iframeEl)

    port.onMessage.emit({ relay: fieldConnectedEnvelope })
    const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement
    expect(disconnectBtn.hidden).toBe(false)

    iframeEl.dispatchEvent(new Event('load'))
    expect(disconnectBtn.hidden).toBe(true)

    // registry.ts's panelReady(true) re-synthesizes fieldConnected for a
    // field that survived the reload — same relay shape as a fresh connect.
    emitReady(iframeEl)
    port.onMessage.emit({ relay: fieldConnectedEnvelope })
    expect(disconnectBtn.hidden).toBe(false)
  })
})

// F1 (B43 C2 round 3): the panel's port is exactly as quiet during a check
// as the field's — same keepalive protection, reusing the Disconnect
// button's own connected-state signal (setFieldConnected).
describe('panel: F1 keepalive ping timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function pingCount(port: MockPort): number {
    return port.postMessage.mock.calls.filter(
      ([msg]) => (msg as { ctl?: { kind?: string } }).ctl?.kind === 'ping',
    ).length
  }

  // Same reasoning as scout.test.ts's own PAST_PING_INTERVAL_MS: this file
  // has no access to panel.ts's private PING_INTERVAL_MS, so it advances
  // generously past the documented 20s cadence instead of mirroring it.
  const PAST_PING_INTERVAL_MS = 21_000

  it('sends no ping while no field is connected, then pings on cadence once one is', async () => {
    const { port } = await bootPanel()

    vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
    expect(pingCount(port)).toBe(0)

    port.onMessage.emit({ relay: fieldConnectedEnvelope })

    vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
    expect(pingCount(port)).toBe(1)

    vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
    expect(pingCount(port)).toBe(2)
  })

  it('stops pinging once the field disconnects', async () => {
    const { port } = await bootPanel()
    port.onMessage.emit({ relay: fieldConnectedEnvelope })
    vi.advanceTimersByTime(PAST_PING_INTERVAL_MS)
    expect(pingCount(port)).toBe(1)

    port.onMessage.emit({ relay: fieldDisconnectedEnvelope })
    const afterDisconnect = pingCount(port)

    vi.advanceTimersByTime(PAST_PING_INTERVAL_MS * 2)
    expect(pingCount(port)).toBe(afterDisconnect)
  })
})

// B43 C2 (owner UX round 2): the status line stops showing a resting
// "connected" — it renders ONLY "connecting…" (during a reload's hello
// loop), "embed not responding" (the cap), or nothing at all once the embed
// is ready. The "click the chip" case is hintEl's own job (tested above);
// this block pins statusEl's text specifically.
describe('panel: status line has no resting "connected" text (B43 C2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the static "embed not responding" default until the embed first readies, then clears', async () => {
    const { iframeEl } = await bootPanel()
    const statusEl = document.getElementById('status') as HTMLElement
    expect(statusEl.textContent).toBe('embed not responding')

    emitReady(iframeEl)
    expect(statusEl.textContent).toBe('')
  })

  it('a reload shows "connecting…" and clears again once the new embed readies', async () => {
    const { iframeEl } = await bootPanel()
    emitReady(iframeEl)
    const statusEl = document.getElementById('status') as HTMLElement
    expect(statusEl.textContent).toBe('')

    // iframe 'load' re-arm (relay.start()'s true->false edge).
    iframeEl.dispatchEvent(new Event('load'))
    expect(statusEl.textContent).toBe('connecting…')

    emitReady(iframeEl)
    expect(statusEl.textContent).toBe('')
  })

  it('falls back to "embed not responding" if the reload never readies within the cap', async () => {
    const { iframeEl } = await bootPanel()
    emitReady(iframeEl)
    iframeEl.dispatchEvent(new Event('load'))
    const statusEl = document.getElementById('status') as HTMLElement
    expect(statusEl.textContent).toBe('connecting…')

    vi.advanceTimersByTime(HELLO_RETRY_MS * MAX_HELLO_ATTEMPTS)
    expect(statusEl.textContent).toBe('embed not responding')
  })
})
