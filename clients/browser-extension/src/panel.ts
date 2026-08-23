// The side-panel entry (spec: B43, C2 browser extension, Task 8).
// Deliberately thin — the protocol/hello-loop logic lives in relay.ts; this
// module only wires the static panel.html DOM, the 'panel' runtime port,
// and the window 'message' listener to it. Mirrors simulator/main.ts's own
// host-side wiring (read-only reference for this task).
import browser from 'webextension-polyfill'
import { createRelay, HELLO_RETRY_MS, MAX_HELLO_ATTEMPTS } from './relay'
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

  // Only used on the true->false edge below (a load-triggered re-arm) — the
  // initial boot path never touches this, matching panel.html's own static
  // "embed not responding" default for the first-ever hello loop.
  let capFallbackTimer: ReturnType<typeof setTimeout> | undefined

  const relay = createRelay(
    {
      toEmbed: (msg) => iframeEl.contentWindow?.postMessage(msg, serverOrigin),
      toPort: (msg: PortMessage) => {
        // A throw here (e.g. the port already disconnected — SW crash,
        // extension update) must not propagate out of the window 'message'
        // listener that calls into this: the onDisconnect handler below
        // reloads the panel on its own; this call just must not blow up
        // first.
        try {
          port.postMessage(msg)
        } catch {
          // ignored — onDisconnect below handles recovery
        }
      },
      onReadyChange: (ready) => {
        if (ready) {
          clearTimeout(capFallbackTimer)
          statusEl.textContent = 'connected'
        } else {
          // relay.start()'s true->false edge (the iframe 'load' re-arm): the
          // stale "connected" text must not linger through a fresh hello
          // loop, but landing straight on "embed not responding" would
          // misreport an ordinary reload as a permanent failure before the
          // new loop even gets a chance. Show a connecting state instead,
          // and fall back to "embed not responding" only if THIS attempt
          // caps out too — relay.ts doesn't expose the cap trip itself, so
          // this mirrors its own HELLO_RETRY_MS/MAX_HELLO_ATTEMPTS locally
          // rather than widening RelayCallbacks for one status string.
          statusEl.textContent = 'connecting…'
          capFallbackTimer = setTimeout(() => {
            statusEl.textContent = 'embed not responding'
          }, HELLO_RETRY_MS * MAX_HELLO_ATTEMPTS)
        }
        port.postMessage({ ctl: { kind: 'embedReady', ready } } satisfies PortMessage)
      },
    },
    browser.runtime.getManifest().version,
  )

  port.onMessage.addListener((data) => relay.fromPort(data))

  // The SW can die out from under a live panel port — not just a crash: only
  // port TRAFFIC resets MV3's ~30s idle timer, so a quiet worker suspending
  // is a normal, expected occurrence, not an edge case (see sw.ts's own
  // header comment). A dead port never fires onMessage again, so the
  // reconnected field is never relayed; simplest correct recovery, matching
  // onServerUrlChanged below, is to reload and let the panel reconnect and
  // re-derive fresh state via a new panelHello.
  port.onDisconnect.addListener(() => location.reload())

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
