// The panel-side protocol relay (spec: B43, C2 browser extension, Task 8) —
// the testable core of the panel: translates window 'message' events from
// the embed iframe and PortMessage traffic from the sw port into each
// other, plus the hello handshake loop. Deliberately polyfill-free: panel.ts
// hands in origin/source-pinned data via RelayCallbacks and plain function
// calls, so this module has no browser.* import and stays unit-testable
// with fake timers, matching simulator/main.ts's host-side hello loop (same
// constants, same Finding-28 attempt cap) but for the browser-extension host.
import { parseEmbedMessage, parseHostMessage, PROTOCOL_VERSION } from '../../../frontend/src/embed/protocol'
import type { Envelope, EmbedMessage } from '../../../frontend/src/embed/protocol'
import { HOST_KIND, parsePortMessage, type PortMessage } from './messages'

export interface RelayCallbacks {
  toEmbed(msg: object): void          // iframe.contentWindow.postMessage(msg, serverOrigin)
  toPort(msg: PortMessage): void      // port.postMessage
  onReadyChange(ready: boolean): void // -> ctl embedReady
  // Live-test UX decision (B43 C2, PR #139): pure side-channel observation
  // of fromPort's own pass-through traffic — panel.ts's connect hint and
  // Disconnect button both need to know when a field connects/disconnects,
  // but fromPort's job is strictly to forward host->embed envelopes
  // untranslated (the relay's pass-through contract), so these fire
  // ALONGSIDE that forwarding rather than replacing or gating it. Optional:
  // only panel.ts's own real usage needs them (relay.test.ts's
  // makeCallbacks() omits them for every other test).
  onFieldConnected?(): void
  onFieldDisconnected?(): void
}

export const HELLO_RETRY_MS = 250
// Finding 28 (simulator/main.ts): without a cap, an embed that never readies
// retries forever with no visible signal beyond "not connected". 30 attempts
// at HELLO_RETRY_MS is ~7.5s — long enough to cover a slow dev-server cold
// start without leaving the panel silently stuck.
export const MAX_HELLO_ATTEMPTS = 30

export function createRelay(cb: RelayCallbacks, hostVersion: string) {
  // bridge.ts answers EVERY hello with a ready, so 1-2 duplicates are
  // normal (both this host's own retries and, transiently, a stale embed).
  // This flag guards the false->true edge: an un-guarded embedReady per
  // duplicate would make the registry re-synthesize fieldConnected,
  // cancelling and restarting in-flight checks and burning LLM credits.
  let ready = false
  let helloTimer: ReturnType<typeof setInterval> | null = null
  let helloAttempts = 0

  function stopHelloTimer(): void {
    if (helloTimer !== null) {
      clearInterval(helloTimer)
      helloTimer = null
    }
  }

  function sendHello(): void {
    cb.toEmbed({
      fw: PROTOCOL_VERSION,
      type: 'hello',
      payload: { host: { kind: HOST_KIND, version: hostVersion } },
    })
  }

  function attemptHello(): void {
    helloAttempts += 1
    if (helloAttempts > MAX_HELLO_ATTEMPTS) {
      stopHelloTimer()
      return
    }
    sendHello()
  }

  function start(): void {
    stopHelloTimer()
    // A load-triggered re-arm (a reloaded embed forgets everything) is a
    // real true->false transition, not just internal bookkeeping: the
    // caller (panel.ts) forwards it as ctl embedReady:false so the SW's
    // registry (panelReady(false)) stops believing a field is still
    // connected to a now-amnesiac embed — otherwise the reloaded embed's
    // next `ready` would hit the registry's rule-4 duplicate no-op and
    // never get its field back. Guarded the same way as the false->true
    // edge below: only fires on an actual transition, and strictly before
    // this function arms any new hello attempt.
    if (ready) {
      ready = false
      cb.onReadyChange(false)
    }
    helloAttempts = 0
    attemptHello()
    helloTimer = setInterval(attemptHello, HELLO_RETRY_MS)
  }

  function fromEmbed(data: unknown): void {
    const msg = parseEmbedMessage(data)
    if (msg === null) return
    if (msg.type === 'ready') {
      stopHelloTimer()
      if (!ready) {
        ready = true
        cb.onReadyChange(true)
      }
      return
    }
    // Copilot round 7, F1: the iframe's WindowProxy survives navigation, so a
    // message the OLD embed document queued before unload can still arrive
    // AFTER start() has re-armed (ready went back to false) but BEFORE the
    // new embed's own 'ready'. It already passed the panel's origin/source
    // pins (both still name the same iframe), so without this gate a stale
    // findings message — or worse, a stale applyReplacement — would reach
    // the CURRENT field mid-reload. While not ready, only 'ready' itself is
    // ever legitimate; a fresh embed always re-readies before sending
    // anything else, so anything else arriving now is stale by definition
    // and must be dropped rather than forwarded.
    if (!ready) return
    // `data` (not `msg`) so the forwarded envelope is the exact object that
    // arrived — parseEmbedMessage's return type drops `fw` but the runtime
    // object (same reference) still carries it.
    cb.toPort({ relay: data as Envelope<EmbedMessage> })
  }

  function fromPort(data: unknown): void {
    const parsed = parsePortMessage(data)
    if (parsed === null) return
    if ('ctl' in parsed) return
    // Only host-direction relays are meant to reach the embed here — a panel
    // port never legitimately carries an embed-direction envelope, but
    // parsePortMessage accepts either shape generically (it's shared by both
    // port kinds), so this checks discriminately rather than trusting that.
    const hostMsg = parseHostMessage(parsed.relay)
    if (hostMsg === null) return
    // Observation only (see RelayCallbacks' own comment) — fires alongside
    // the unconditional forward below, never instead of it.
    if (hostMsg.type === 'fieldConnected') cb.onFieldConnected?.()
    else if (hostMsg.type === 'fieldDisconnected') cb.onFieldDisconnected?.()
    cb.toEmbed(parsed.relay)
  }

  function dispose(): void {
    stopHelloTimer()
    ready = false
  }

  return { fromEmbed, fromPort, start, dispose }
}
