import { useEffect, useRef } from 'react'
import './App.css'
import { getDomains, getLanguages, getProfiles, getProviders, getRouting } from './api/client'
import { AccountMenu } from './auth/AccountMenu'
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
    // Mount-only fetch; grab the actions off the store object directly so the
    // effect has no reactive dependencies. No generation guard needed: these
    // are app-wide catalogs (providers/domains/languages/routing are not
    // scoped to a user or document — see app/api/providers.py, terminology.py,
    // languages.py, routing.py), so a write landing after a session turnover
    // still writes the same data the incoming session would itself fetch.
    const { setProviders, setDomains, setLanguages, setRouting } = useStore.getState()
    getProviders().then(setProviders).catch(() => setProviders([]))
    getDomains().then(setDomains).catch(() => setDomains([]))
    getLanguages().then(setLanguages).catch(() => {})
    getRouting().then(setRouting).catch(() => setRouting(null))
  }, [])

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
        // would strand and wrongly suppress the NEXT legitimate apply.
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
