// The side-panel entry (spec: B43, C2 browser extension, Task 8).
// Deliberately thin — the protocol/hello-loop logic lives in relay.ts; this
// module only wires the static panel.html DOM, the 'panel' runtime port,
// and the window 'message' listener to it. Mirrors simulator/main.ts's own
// host-side wiring (read-only reference for this task).
import browser from 'webextension-polyfill'
import { createRelay } from './relay'
import type { PortMessage } from './messages'
import { getServerUrl, onServerUrlChanged } from './settings'

const statusEl = document.getElementById('status') as HTMLElement
const iframeEl = document.getElementById('embed') as HTMLIFrameElement
const optionsBtn = document.getElementById('options') as HTMLButtonElement

optionsBtn.addEventListener('click', () => {
  void browser.runtime.openOptionsPage()
})

async function main(): Promise<void> {
  const serverOrigin = await getServerUrl()
  const port = browser.runtime.connect({ name: 'panel' })

  const relay = createRelay(
    {
      toEmbed: (msg) => iframeEl.contentWindow?.postMessage(msg, serverOrigin),
      toPort: (msg: PortMessage) => port.postMessage(msg),
      onReadyChange: (ready) => {
        statusEl.textContent = ready ? 'connected' : 'embed not responding'
        port.postMessage({ ctl: { kind: 'embedReady', ready } } satisfies PortMessage)
      },
    },
    browser.runtime.getManifest().version,
  )

  port.onMessage.addListener((data) => relay.fromPort(data))

  window.addEventListener('message', (event) => {
    if (event.origin !== serverOrigin || event.source !== iframeEl.contentWindow) return
    relay.fromEmbed(event.data)
  })

  // A reloaded embed forgets everything — same reasoning as the simulator's
  // iframe 'load' listener (simulator/main.ts): re-arm the hello loop so the
  // panel discovers the fresh embed instead of waiting on a dead timer.
  iframeEl.addEventListener('load', () => relay.start())

  // browser.windows.getCurrent() works in both the side panel and a plain
  // tab (the e2e path) with no extra permission needed.
  const { id: windowId } = await browser.windows.getCurrent()
  if (windowId !== undefined) {
    port.postMessage({ ctl: { kind: 'panelHello', windowId } } satisfies PortMessage)
  }

  // Setting src after the listeners above are registered: the resulting
  // navigation's own 'load' event must not be missed.
  iframeEl.src = `${serverOrigin}/embed`
  relay.start()
}

void main()

// Simplest correct response to a server URL change (the brief's own
// framing): reload the whole panel. The SW re-synthesizes fieldConnected on
// the next embedReady, so nothing else needs to reconnect by hand.
onServerUrlChanged(() => {
  location.reload()
})
