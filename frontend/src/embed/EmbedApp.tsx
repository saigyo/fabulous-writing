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
  // Distinguishes "no host has ever connected a field" (embedWaiting) from
  // "a field was connected and then went away" (embedDisconnected) — purely
  // local to this component; nothing else needs to know the difference.
  const [everConnected, setEverConnected] = useState(false)

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
    // runCheck(false) only makes sense when a field is actually connected.
    cancelCheck()
    if (!connectedField) return
    void runCheck(false)
  }, [connectedField])

  useEffect(() => {
    // Mirrors editor/Editor.tsx's scheduler wiring, minus the CodeMirror
    // update listener: the host shim's onInput is called from
    // hostDoc.ts:syncBuffer on every textChanged/replaceResult instead.
    //
    // Keyed on the connected field's identity (not just mounted once): a
    // timer armed by field A's onInput must never fire runCheck against
    // field B's document after the host switches fields. Recreating the
    // scheduler on every field change disposes A's pending timers before B
    // gets a fresh, empty one.
    const scheduler = createCheckScheduler({
      fastDelayMs: 1000,
      llmDelayMs: 5000,
      onFast: () => void runCheck(false),
      onFull: () => void runCheck(true),
      llmEnabled: () => useStore.getState().llmAuto,
    })
    const outbound = getEmbedOutbound()
    if (outbound) outbound.onInput = scheduler.onInput
    return () => {
      if (outbound) outbound.onInput = () => {}
      scheduler.dispose()
    }
  }, [connectedField?.fieldId])

  return (
    <div className="embed-app">
      <header className="embed-header">
        <LocaleSwitcher />
        <div className="header-controls">
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
            disabled={store.checkPhase !== 'idle'}
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
          ? (connectedField.url ?? connectedField.fieldId)
          : everConnected
            ? m.embedDisconnected
            : m.embedWaiting}
      </div>
      <Sidebar />
    </div>
  )
}
