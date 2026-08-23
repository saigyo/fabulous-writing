// The content-script entry (spec: B43, C2 browser extension, Task 7).
// Deliberately thin — every behavior lives in detect.ts/affordance.ts/
// session.ts; this module only wires document-level delegation, the lazy
// runtime port, and the incoming ctl/relay traffic to those modules. Builds
// as one classic IIFE (vite.content.config.ts, ruling 1: no dynamic import
// from a content script — subject to the host page's CSP) with everything
// it needs statically imported, exactly like every other module here.
//
// Single-instance module: one scout runs per tab/page, so every piece of
// state below (port, session, the shown field) is a plain module-scoped
// singleton, not something instantiated per caller — scout.test.ts relies
// on this too (see that file's own header comment).
import browser from 'webextension-polyfill'
import type { EmbedMessage, Envelope, HostMessage } from '../../../frontend/src/embed/protocol'
import { createAffordance, type Affordance, type AffordanceState } from './affordance'
import { isEligibleField } from './detect'
import { MARKS_CSS } from './marks.css'
import { parsePortMessage, type PortMessage } from './messages'
import { startSession, type Session } from './session'

type Port = ReturnType<typeof browser.runtime.connect>

const HIDE_DELAY_MS = 250

let port: Port | null = null
let session: Session | null = null
let sessionEl: HTMLTextAreaElement | null = null
// The live session's own display state/count, tracked separately from
// what's actually rendered: renderChip() below only projects this onto the
// chip when the field currently shown IS the session's own field — hovering
// a DIFFERENT, unconnected field while a session is live elsewhere in the
// tab must show idle for THAT field, not borrow the connected field's look.
let sessionState: Exclude<AffordanceState, 'idle'> = 'busy'
let sessionCount = 0
let shownEl: HTMLTextAreaElement | null = null
let hideTimer: ReturnType<typeof setTimeout> | undefined
let marksInjected = false

function ensureMarksStyle(): void {
  if (marksInjected) return
  marksInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-fw-marks', '')
  style.textContent = MARKS_CSS
  document.head.appendChild(style)
}

function ensurePort(): Port {
  if (port) return port
  const p = browser.runtime.connect({ name: 'field' })
  p.onMessage.addListener(handlePortMessage)
  p.onDisconnect.addListener(handlePortDisconnect)
  port = p
  return p
}

function send(message: Envelope<HostMessage>): void {
  ensurePort().postMessage({ relay: message } satisfies PortMessage)
}

function renderChip(): void {
  if (!shownEl) return
  if (session && sessionEl === shownEl) {
    affordance.setState(sessionState)
    affordance.setCount(sessionCount)
  } else {
    affordance.setState('idle')
    affordance.setCount(0)
  }
}

function handleAffordanceClick(el: HTMLTextAreaElement): void {
  if (session && sessionEl === el) {
    // Connected-field chip click: user-initiated disconnect. The embed's
    // own status stream is not tied to connectivity, so nothing else needs
    // resetting here.
    session.stop()
    session = null
    sessionEl = null
    renderChip()
    return
  }
  // Idle chip click. A previous session for a DIFFERENT field in this tab
  // must be torn down locally first — same-tab replace, the SW sends no
  // detach for this case (registry rule 1: only the LOSING tab of a
  // cross-tab replace gets a detach message).
  if (session) {
    session.detach()
    session = null
    sessionEl = null
  }
  ensurePort().postMessage({ ctl: { kind: 'openPanel' } } satisfies PortMessage)
  ensureMarksStyle()
  sessionState = 'busy'
  sessionCount = 0
  session = startSession(el, send)
  sessionEl = el
  renderChip()
}

const affordance: Affordance = createAffordance(handleAffordanceClick)

function handlePortMessage(data: unknown): void {
  const parsed = parsePortMessage(data)
  if (parsed === null) return
  if ('ctl' in parsed) {
    if (parsed.ctl.kind === 'detach') {
      // A detach for a session already replaced by a same-tab reconnect
      // (or one that never matched) must not touch the CURRENT session —
      // see messages.ts's own CtlMessage doc comment.
      if (!session || parsed.ctl.fieldId !== session.fieldId) return
      session.detach()
      session = null
      sessionEl = null
      renderChip()
      return
    }
    if (parsed.ctl.kind === 'status') {
      sessionState = parsed.ctl.phase === 'signed-out' ? 'signed-out'
        : parsed.ctl.phase === 'error' ? 'error'
        : 'connected'
      sessionCount = parsed.ctl.findingCount
      renderChip()
    }
    return
  }
  session?.handleEmbedMessage(parsed.relay as Envelope<EmbedMessage>)
}

function handlePortDisconnect(): void {
  // The port itself is gone (SW restart, extension update) — there is
  // nowhere for a fieldDisconnected send to land, so this is a silent local
  // teardown (session.stop()'s semantics don't apply, same as the ctl
  // detach path above). The affordance host is deliberately NOT disposed:
  // losing it until page reload would strand the tab with no way back in.
  // The next interaction (showAffordance below) reconnects.
  session?.detach()
  session = null
  sessionEl = null
  port = null
  renderChip()
}

function showAffordance(el: HTMLTextAreaElement): void {
  shownEl = el
  affordance.showFor(el)
  ensurePort()
  renderChip()
}

function hideAffordance(): void {
  shownEl = null
  affordance.hide()
}

function scheduleHide(): void {
  if (hideTimer !== undefined) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = undefined
    hideAffordance()
  }, HIDE_DELAY_MS)
}

function cancelHide(): void {
  if (hideTimer === undefined) return
  clearTimeout(hideTimer)
  hideTimer = undefined
}

// True when `target` is the chip's own shadow host — an event crossing a
// shadow boundary is retargeted to the host by the platform, so this is the
// only identity a listener OUTSIDE the shadow tree can compare against.
function isChipHost(target: EventTarget | null): boolean {
  return target instanceof Node && target === affordance.host
}

// Shared by both event pairs below: entering the field OR the chip cancels
// any pending hide (a hide scheduled while crossing the gap between them
// must not fire while the pointer/focus is now sitting on either one).
function handleEnter(target: EventTarget | null): void {
  if (isChipHost(target)) {
    cancelHide()
    return
  }
  if (!isEligibleField(target)) return
  cancelHide()
  showAffordance(target)
}

// The round-trip half the field-only version was missing: leaving the
// FIELD toward the chip must not schedule a hide (existing relatedTarget
// check below), but leaving the CHIP is exactly as much a "the pointer/
// focus might be gone for good" event as leaving the field is — it must
// schedule the same delayed hide, unless it's headed right back at the
// field currently shown (relatedTarget/new focus target === shownEl),
// which keeps the chip visible instead.
//
// Copilot round 3, S1: both branches below key off `target === shownEl`
// (plus the chip-host case) rather than re-running isEligibleField(target).
// Eligibility is a SHOW-path concern only — by the time something is
// leaving, the only question is "is this the field whose chip is currently
// shown", i.e. an identity check against shownEl. Re-checking eligibility on
// the leave path had two bugs: a blur handler that disables/resizes the
// field out of eligibility (some rich-text-adjacent widgets do this) made
// isEligibleField(target) false, so the leave was dropped entirely and the
// chip stuck visible forever; and leave events fired by some OTHER,
// unrelated textarea (never eligible, or eligible but not the shown one)
// could still reach isEligibleField and, worse, would be indistinguishable
// from the shown field's own leave once eligibility no longer gated it —
// identity against shownEl fixes both.
function handleLeave(target: EventTarget | null, relatedTarget: EventTarget | null): void {
  if (isChipHost(target)) {
    if (relatedTarget === shownEl) return
    scheduleHide()
    return
  }
  if (target !== shownEl) return
  if (isChipHost(relatedTarget)) return
  scheduleHide()
}

// Delegation: document-level focusin/focusout + mouseover/mouseout — all
// four BUBBLE (mouseenter/mouseleave do not and cannot be delegated this
// way). No scanning, no detection observer: a Turbo-injected field is
// noticed the moment it's interacted with, not before.
document.addEventListener('focusin', (e) => handleEnter(e.target))
document.addEventListener('focusout', (e) => handleLeave(e.target, (e as FocusEvent).relatedTarget))
document.addEventListener('mouseover', (e) => handleEnter(e.target))
document.addEventListener('mouseout', (e) => handleLeave(e.target, (e as MouseEvent).relatedTarget))

// Copilot round 3, S6: pagehide can be followed by pageshow restoring the
// page from the back/forward cache (bfcache) instead of a real reload — the
// module's top-level state (session/sessionEl/shownEl/hideTimer) survives
// that round-trip untouched, since nothing here re-runs. Without resetting
// them, a subsequent focusin on an eligible field would set shownEl to it
// and renderChip() would find the STALE session (already .stop()'d, but
// still assigned) still pointing at sessionEl === shownEl whenever the same
// field is refocused — rendering the chip as connected/busy for a session
// that no longer exists. Nulling session/sessionEl/shownEl here (same shape
// as every other local teardown path above) and cancelling any pending hide
// timer makes the post-restore state identical to a fresh page load; the
// affordance itself needs no special handling — dispose() only removes its
// host from the DOM, and showFor() (via the next showAffordance call)
// already re-appends it when not connected, so it recreates cleanly on the
// next interaction.
window.addEventListener('pagehide', () => {
  session?.stop()
  session = null
  sessionEl = null
  shownEl = null
  cancelHide()
  affordance.dispose()
})

// Startup one-shot: an autofocused composer is already eligible before any
// interaction ever fires.
if (isEligibleField(document.activeElement)) {
  showAffordance(document.activeElement)
}
