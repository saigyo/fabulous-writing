import { useEffect, useRef } from 'react'
import { getDomains, getLanguages, getProfiles, getProviders, getRouting } from '../api/client'
import { sessionGeneration } from '../auth/session'
import { currentGeneration } from '../documents/autosave'
import {
  applyHeaderProfileSelection,
  consumeProfileApplySuppression,
} from '../documents/profileApply'
import { useStore } from '../state/store'
import type { Language } from '../types'

/**
 * Header's data-fetching effects, extracted from App.tsx so a non-App entry
 * point (the embed, Task 6) can reuse them without importing App.tsx and
 * pulling in the whole app graph (Editor -> CodeMirror). Header calls this
 * hook; the JSX and everything else it needs (store, useMessages) stays in
 * Header itself.
 */
export function useHeaderData(): void {
  const store = useStore()

  useEffect(() => {
    // Re-runs on mount AND on every login() commit — depending on
    // authGeneration, which login() bumps unconditionally (see its own
    // comment in state/store.ts and the bump site in auth/session.ts),
    // including the silent same-user re-login the password-change flow
    // performs (auth/AccountMenu.tsx handleSubmit -> login(email, next)).
    // That flow bumps sessionGeneration() while Header stays mounted
    // (authStatus never leaves 'authenticated', so LoginGate never unmounts
    // it). Without this, a mount-time domains fetch still in flight at that
    // moment gets discarded by the generation guard below with no
    // replacement ever issued, leaving the domain picker empty for the rest
    // of the session (Copilot round-9 U1). authGeneration is deliberately
    // NOT bumped by logout()/expireSession() (unlike store.user, which also
    // goes null on those) — see App.domains-guard.test.tsx's session-turnover
    // test, which relies on this effect NOT re-firing on logout while Header
    // stays mounted only for the test's sake. providers/languages/routing
    // are app-wide catalogs (app/api/providers.py, languages.py,
    // routing.py) — refetching them on a same-user re-login is harmless, and
    // a write landing after a session turnover writes the same data the
    // incoming session would fetch, so they stay unguarded. domains are
    // per-user since M3 (owner-scoped in app/services/terminology.py): a
    // fetch started under user A must not land in user B's store — the
    // guard below stays.
    const { setProviders, setDomains, setLanguages, setRouting } = useStore.getState()
    const gen = sessionGeneration()
    getProviders().then(setProviders).catch(() => setProviders([]))
    getDomains()
      .then((domains) => { if (sessionGeneration() === gen) setDomains(domains) })
      .catch(() => { if (sessionGeneration() === gen) setDomains([]) })
    getLanguages().then(setLanguages).catch(() => {})
    getRouting().then(setRouting).catch(() => setRouting(null))
  }, [store.authGeneration])

  const prevLanguage = useRef<Language | null>(null)
  useEffect(() => {
    const language = store.language
    // Apply profile values only on a real language switch. Comparing the
    // previous language (instead of a consumed boolean) keeps this correct
    // under StrictMode's double-invoked effects.
    const isSwitch = prevLanguage.current !== null && prevLanguage.current !== language
    prevLanguage.current = language
    // A real switch re-fires the fetch below for a new language's profile
    // list — the embed's connect-time check (EmbedApp.tsx) gates on
    // profilesReady, so it must go false again the instant a fresh fetch
    // starts, not just while a document is loading for the first time
    // (Copilot round 4).
    if (isSwitch) useStore.getState().setProfilesReady(false)
    // Captured before the request goes out: a session ending mid-request
    // (logout/expiry — see documents/autosave.ts's currentGeneration()) must
    // not let user A's profile list and header selection (language,
    // domainIds, provider, model, tier) land in user B's store, where the
    // live subscription below would autosave them onto B's open document.
    const gen = currentGeneration()
    getProfiles(language)
      .then((profiles) => {
        if (gen !== currentGeneration()) return // session ended: do not write
        const s = useStore.getState()
        s.setProfiles(profiles)
        const remembered = profiles.find(
          (p) => p.id === s.lastProfileByLanguage[language],
        )
        const chosen =
          remembered ?? profiles.find((p) => p.is_standard) ?? profiles[0]
        if (chosen) applyHeaderProfileSelection(s.selectProfile, chosen, isSwitch)
      })
      .catch(() => {
        // A failed fetch must still consume the one-shot suppression, or it
        // would strand and wrongly suppress the NEXT legitimate apply — but
        // only for ITS OWN generation: without this guard, a rejection that
        // arrives after a session turnover could consume a suppression flag
        // the *incoming* session has since armed for its own document open,
        // silently discarding it before that session's own profile fetch
        // gets to see it.
        if (gen !== currentGeneration()) return
        consumeProfileApplySuppression()
        // The embed's connect-time check is gated on profilesReady
        // (Copilot round 4) — a failed fetch must still flip it, or a
        // connected field would wait on a profile list that is never
        // coming.
        useStore.getState().setProfilesReady(true)
      })
  }, [store.language])
}
