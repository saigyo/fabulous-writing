import { useEffect, useState } from 'react'
import { AccountMenu } from '../auth/AccountMenu'
import { llmDisabled } from '../auth/policy'
import { cancelCheck, runCheck } from '../checking/controller'
import { createCheckScheduler } from '../checking/scheduler'
import { useHeaderData } from '../header/useHeaderData'
import { DomainMultiSelect } from '../header/DomainMultiSelect'
import { LlmSelector } from '../header/LlmSelector'
import { ProfileSelector } from '../header/ProfileSelector'
import { useMessages } from '../i18n'
import { LocaleSwitcher } from '../i18n/LocaleSwitcher'
import { languageLabel } from '../languages'
import { Sidebar } from '../sidebar/Sidebar'
import { useStore } from '../state/store'
import type { Language } from '../types'
import { readSelectorsCollapsed, writeSelectorsCollapsed } from './embedPrefs'
import { getEmbedOutbound } from './embedRef'

/**
 * The embed page's root component (spec: B43, C1 embed surface). Reuses the
 * main app's header widgets and Sidebar over the host-document shim
 * (hostDoc.ts) instead of a CodeMirror editor — nothing here imports
 * editor/Editor.tsx or App.tsx, which is what keeps CodeMirror out of this
 * entry's bundle (see scripts/check-embed-bundle.mjs).
 */
export function EmbedApp() {
  const store = useStore()
  const m = useMessages()
  const connectedField = useStore((s) => s.connectedField)
  const profilesReady = useStore((s) => s.profilesReady)
  // Distinguishes "no host has ever connected a field" (embedWaiting) from
  // "a field was connected and then went away" (embedDisconnected) — purely
  // local to this component; nothing else needs to know the difference.
  const [everConnected, setEverConnected] = useState(false)
  // Owner UX round 2 (B43 C2): the selector block (Profile/Language/Domain/
  // LLM) collapses independently of the always-visible action row (globe,
  // ✳, Check, account menu). Lazy initializer so the very first render
  // already reflects a prior session's choice instead of flashing expanded
  // before collapsing — persisted via embedPrefs.ts, deliberately outside
  // the Prefs schema (state/prefsStorage.ts) since it's local to this embed
  // page, not synced with the main app.
  const [selectorsCollapsed, setSelectorsCollapsed] = useState(() => readSelectorsCollapsed())

  function toggleSelectorsCollapsed(): void {
    setSelectorsCollapsed((prev) => {
      const next = !prev
      writeSelectorsCollapsed(next)
      return next
    })
  }

  useHeaderData()

  useEffect(() => {
    if (connectedField) setEverConnected(true)
  }, [connectedField])

  useEffect(() => {
    // Every fieldConnected() (including a reconnect to the same field)
    // writes a brand-new connectedField object (see its comment in
    // state/store.ts), so this fires on every connect, not just the first —
    // matching hostDoc.ts's whole-document-replacement semantics on
    // reconnect. StrictMode's double-invoked mount is tolerated: cancelCheck
    // + a fresh runCheck(false) is harmless to repeat.
    //
    // cancelCheck() runs on EVERY transition, including disconnect: a check
    // in flight against a field that just went away must not resolve and
    // publish stale findings for a document nobody is looking at anymore.
    //
    // runCheck(false) is additionally gated on profilesReady (Copilot round
    // 4): on a cold authenticated mount the profiles fetch (header/
    // useHeaderData.ts) is still in flight when a field connects, and
    // nothing else re-checks once the profile (and its rule_config) later
    // applies — firing the check anyway would silently run the FIRST check
    // without it. profilesReady is in the dep list so this effect re-fires
    // (cancelCheck + runCheck) the moment profiles resolve for an
    // already-connected field, not just on the next connect.
    cancelCheck()
    if (!connectedField || !profilesReady) return
    void runCheck(false)
  }, [connectedField, profilesReady])

  useEffect(() => {
    // Mirrors editor/Editor.tsx's scheduler wiring, minus the CodeMirror
    // update listener: the host shim's onInput is called from
    // hostDoc.ts:syncBuffer on every textChanged/replaceResult instead.
    //
    // Keyed on the connectedField OBJECT (not connectedField?.fieldId): a
    // same-field reconnect (host replaces the whole document, e.g. undo/
    // redo or a fresh page load into the same field) writes a brand-new
    // connectedField object with the SAME fieldId (see store.ts's own
    // comment). Depending on fieldId alone would keep the old scheduler
    // alive across that reconnect, so a timer armed by the prior document's
    // onInput could still fire runCheck against the replacement document.
    // Depending on the object's identity re-runs this effect on every
    // connect, matching hostDoc.ts's whole-document-replacement semantics:
    // a timer armed by field A's onInput must never fire runCheck against
    // field B's document after the host switches (or reconnects) fields.
    // Recreating the scheduler on every field change disposes the prior
    // pending timers before the new one gets a fresh, empty scheduler.
    // Copilot round 7: onFast/onFull must not bypass the same profilesReady
    // gate as the connect-time check above — a host textChanged during a
    // cold profile load or language switch would otherwise arm these timers
    // and run against stale/empty profile config (onFull could even run an
    // unnecessary LLM call). Read connectedField/profilesReady fresh via
    // getState() at fire time (mirrors llmEnabled below), not from the
    // closed-over connectedField prop, since a timer can fire after the
    // field disconnects. A check dropped here is fine to lose silently: the
    // connect-time effect above re-runs runCheck(false) itself the moment
    // profilesReady flips for an already-connected field, so no typing is
    // lost — see that effect's comment.
    function readyToCheck() {
      const s = useStore.getState()
      return Boolean(s.connectedField) && s.profilesReady
    }
    const scheduler = createCheckScheduler({
      fastDelayMs: 1000,
      llmDelayMs: 5000,
      onFast: () => {
        if (readyToCheck()) void runCheck(false)
      },
      onFull: () => {
        if (readyToCheck()) void runCheck(true)
      },
      llmEnabled: () => useStore.getState().llmAuto,
    })
    const outbound = getEmbedOutbound()
    if (outbound) outbound.onInput = scheduler.onInput
    return () => {
      if (outbound) outbound.onInput = () => {}
      scheduler.dispose()
    }
  }, [connectedField])

  return (
    <div className="embed-app">
      <header className="embed-header">
        <div className="header-controls">
          {/* Owner UX round 2 (B43 C2): the selector block collapses
              independently of the action row below it (globe, chevron, ✳,
              Check, account menu), which stays visible regardless. Grouped
              so the narrow (≤480px) embed.css media block can grid these
              four controls 2-per-row (Profile+Language, Domain+LLM)
              without touching the action row, which keeps wrapping onto
              its own row exactly as before. display: contents at wider
              widths (embed.css) makes this wrapper invisible to layout
              there, so ProfileSelector/label/label/LlmSelector are still
              direct flex children of .header-controls — pixel parity with
              the pre-existing wide layout. Unmounted rather than hidden
              when collapsed: no extra CSS needed, and nothing in a
              collapsed selector (a stale <select> value, an open popover)
              can linger in the DOM. */}
          {!selectorsCollapsed && (
            <div className="embed-selectors">
              <ProfileSelector />
              <label>
                {m.language}
                <select
                  value={store.language}
                  onChange={(e) => store.setLanguage(e.target.value as Language)}
                >
                  {store.languages.map((info) => (
                    <option key={info.code} value={info.code}>
                      {languageLabel(info, m)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {m.domain}
                <DomainMultiSelect />
              </label>
              <LlmSelector />
            </div>
          )}
          {/* Owner UX round 2 (B43 C2): the globe joins this always-visible
              action row (it used to sit in its own row above), right next
              to the chevron that collapses/expands the selector block
              above. */}
          <LocaleSwitcher />
          <button
            type="button"
            className="embed-selectors-toggle"
            aria-expanded={!selectorsCollapsed}
            aria-label={m.embedToggleSelectors}
            title={m.embedToggleSelectors}
            onClick={toggleSelectorsCollapsed}
          >
            <span className="chevron" aria-hidden="true">
              {selectorsCollapsed ? '▸' : '▾'}
            </span>
          </button>
          {!llmDisabled(store.user) && (
            <button
              type="button"
              className="auto-toggle"
              aria-pressed={store.llmAuto}
              title={m.autoTitle}
              onClick={() => store.setLlmAuto(!store.llmAuto)}
            >
              ✳
            </button>
          )}
          <button
            className="check-button"
            // Copilot round 7: same readiness gate as the scheduler timers
            // above — the manual button must not be clickable with no field
            // connected or while profiles are still loading (stale/empty
            // profile config).
            disabled={!connectedField || !profilesReady || store.checkPhase !== 'idle'}
            onClick={() => void runCheck(true)}
          >
            {store.checkPhase === 'idle' ? m.check : m.checking}
          </button>
          {/* hideActivity: EmbedApp has no activity view to switch into —
              see AccountMenu's own comment. Password change and sign-out
              stay: the embed's session is storage-partition-scoped to its
              iframe, and this is the only sign-out affordance in the app. */}
          <AccountMenu hideActivity />
        </div>
      </header>
      <div className="embed-connection-strip">
        {connectedField
          ? (connectedField.url || connectedField.fieldId)
          : everConnected
            ? m.embedDisconnected
            : m.embedWaiting}
      </div>
      <Sidebar />
    </div>
  )
}
