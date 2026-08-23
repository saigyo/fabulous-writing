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
import { browserMock, type MockPort } from './testing/browserMock'

const SERVER_ORIGIN = 'https://fabulous-writing.fly.dev' // settings.ts's DEFAULT_SERVER_URL

function setupDom(): { iframeEl: HTMLIFrameElement } {
  document.body.innerHTML = `
    <p id="status" role="status">embed not responding</p>
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
