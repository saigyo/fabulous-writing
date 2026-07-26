import { useEffect, useRef } from 'react'
import './App.css'
import { getDomains, getLanguages, getProfiles, getProviders, getRouting } from './api/client'
import { AccountMenu } from './auth/AccountMenu'
import { sessionGeneration } from './auth/session'
import { runCheck } from './checking/controller'
import { currentGeneration, flush, noteChange } from './documents/autosave'
import { initDocuments } from './documents/documents'
import {
  applyHeaderProfileSelection,
  consumeProfileApplySuppression,
} from './documents/profileApply'
import { DocumentSidebar } from './documents/DocumentSidebar'
import { Editor } from './editor/Editor'
import { setEditorText } from './editor/editorRef'
import { DomainMultiSelect } from './header/DomainMultiSelect'
import { LlmSelector } from './header/LlmSelector'
import { ProfileSelector } from './header/ProfileSelector'
import { ProfilesView } from './profiles/ProfilesView'
import { RulesView } from './rules/RulesView'
import { Sidebar } from './sidebar/Sidebar'
import { LOCALES, LOCALE_NAMES, useLocale, useMessages, type Locale } from './i18n'
import { languageLabel } from './languages'
import { useStore } from './state/store'
import { TerminologyView } from './terminology/TerminologyView'
import type { Language } from './types'
import { Wordmark } from './Wordmark'

export default function App() {
  const activeView = useStore((s) => s.activeView)

  useEffect(() => {
    // Startup: replay dirty buffer, load the document list, open the last
    // document. Runs once; StrictMode double-invocation is tolerated because
    // a clean replay is a no-op and hydration is idempotent.
    void initDocuments()
  }, [])

  useEffect(() => {
    // Leaving the editor view is a natural save point.
    if (activeView !== 'editor') void flush()
  }, [activeView])

  useEffect(() => {
    // Per-document settings autosave: any change to the header selection
    // fields buffers + debounces a save, exactly like typing does.
    let previous = useStore.getState()
    return useStore.subscribe((state) => {
      const changed =
        state.language !== previous.language ||
        state.domainIds !== previous.domainIds ||
        state.provider !== previous.provider ||
        state.model !== previous.model ||
        state.tier !== previous.tier ||
        state.llmAuto !== previous.llmAuto ||
        state.profileId !== previous.profileId
      previous = state
      if (changed && state.docMeta) noteChange()
    })
  }, [])

  // The workspace is hidden (not unmounted) while another view is shown:
  // the findings live in the CodeMirror instance, so unmounting would
  // discard them — including LLM results — on every tab switch, and any
  // in-flight LLM check could no longer deliver.
  return (
    <div className="app">
      <Header />
      <main className="workspace" hidden={activeView !== 'editor'}>
        <DocumentSidebar />
        <div className="editor-area">
          <Editor />
          <LoadExampleButton />
        </div>
        <Sidebar />
      </main>
      {activeView === 'rules' && <RulesView />}
      {activeView === 'terminology' && <TerminologyView />}
      {activeView === 'profiles' && <ProfilesView />}
    </div>
  )
}

export function Header() {
  const store = useStore()
  const m = useMessages()

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
      })
  }, [store.language])

  return (
    <header className="header">
      <Wordmark />
      <LocaleSwitcher />
      <nav className="view-switch">
        <button
          className={store.activeView === 'editor' ? 'active' : ''}
          onClick={() => store.setActiveView('editor')}
        >
          {m.viewEditor}
        </button>
        <button
          className={store.activeView === 'rules' ? 'active' : ''}
          onClick={() => store.setActiveView('rules')}
        >
          {m.viewRules}
        </button>
        <button
          className={store.activeView === 'terminology' ? 'active' : ''}
          onClick={() => store.setActiveView('terminology')}
        >
          {m.viewTerminology}
        </button>
        <button
          className={store.activeView === 'profiles' ? 'active' : ''}
          onClick={() => store.setActiveView('profiles')}
        >
          {m.viewProfiles}
        </button>
      </nav>
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
        <button
          type="button"
          className="auto-toggle"
          aria-pressed={store.llmAuto}
          title={m.autoTitle}
          onClick={() => store.setLlmAuto(!store.llmAuto)}
        >
          ✳
        </button>
        <button
          className="check-button"
          disabled={store.checkPhase !== 'idle'}
          onClick={() => void runCheck(true)}
        >
          {store.checkPhase === 'idle' ? m.check : m.checking}
        </button>
        <AccountMenu />
      </div>
    </header>
  )
}

function LocaleSwitcher() {
  const locale = useLocale()
  const setUiLocale = useStore((s) => s.setUiLocale)
  const m = useMessages()
  return (
    <label className="locale-switch" title={m.uiLocaleTitle}>
      <span aria-hidden="true">🌐</span>
      <span className="locale-caret" aria-hidden="true">
        ▾
      </span>
      <select
        value={locale}
        aria-label={m.uiLocaleTitle}
        onChange={(e) => setUiLocale(e.target.value as Locale)}
      >
        {LOCALES.map((code) => (
          <option key={code} value={code}>
            {LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  )
}

function LoadExampleButton() {
  const m = useMessages()
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const docWords = useStore((s) => s.docWords)
  const exampleText =
    profiles.find((p) => p.id === profileId)?.example_text ?? ''
  // Only offered while the editor is empty: loading the example replaces the
  // whole document, which must never be able to erase the user's writing.
  if (docWords > 0) return null
  return (
    <button
      className="load-example"
      title={m.exampleTitle}
      disabled={!exampleText.trim()}
      onClick={() => setEditorText(exampleText)}
    >
      ⤓ {m.loadExample}
    </button>
  )
}
