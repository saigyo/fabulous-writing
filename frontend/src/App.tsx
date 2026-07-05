import { useEffect, useRef } from 'react'
import './App.css'
import { getDomains, getLanguages, getProfiles, getProviders } from './api/client'
import { runCheck } from './checking/controller'
import { Editor } from './editor/Editor'
import { setEditorText } from './editor/editorRef'
import { DomainMultiSelect } from './header/DomainMultiSelect'
import { ProfileSelector } from './header/ProfileSelector'
import { ProfilesView } from './profiles/ProfilesView'
import { RulesView } from './rules/RulesView'
import { Sidebar } from './sidebar/Sidebar'
import { LOCALES, LOCALE_NAMES, useLocale, useMessages, type Locale } from './i18n'
import { languageLabel } from './languages'
import { useStore } from './state/store'
import { TerminologyView } from './terminology/TerminologyView'
import type { Language } from './types'

export default function App() {
  const activeView = useStore((s) => s.activeView)

  return (
    <div className="app">
      <Header />
      {activeView === 'editor' && (
        <main className="workspace">
          <div className="editor-area">
            <Editor />
            <LoadExampleButton />
          </div>
          <Sidebar />
        </main>
      )}
      {activeView === 'rules' && <RulesView />}
      {activeView === 'terminology' && <TerminologyView />}
      {activeView === 'profiles' && <ProfilesView />}
    </div>
  )
}

function Header() {
  const store = useStore()
  const m = useMessages()

  useEffect(() => {
    getProviders().then(store.setProviders).catch(() => store.setProviders([]))
    getDomains().then(store.setDomains).catch(() => store.setDomains([]))
    getLanguages().then(store.setLanguages).catch(() => {})
  }, [])

  const prevLanguage = useRef<Language | null>(null)
  useEffect(() => {
    const language = store.language
    // Apply profile values only on a real language switch. Comparing the
    // previous language (instead of a consumed boolean) keeps this correct
    // under StrictMode's double-invoked effects.
    const isSwitch = prevLanguage.current !== null && prevLanguage.current !== language
    prevLanguage.current = language
    getProfiles(language)
      .then((profiles) => {
        const s = useStore.getState()
        s.setProfiles(profiles)
        const remembered = profiles.find(
          (p) => p.id === s.lastProfileByLanguage[language],
        )
        const chosen =
          remembered ?? profiles.find((p) => p.is_standard) ?? profiles[0]
        if (chosen) s.selectProfile(chosen, isSwitch)
      })
      .catch(() => {})
  }, [store.language])

  const activeProvider = store.providers.find((p) => p.name === store.provider)

  return (
    <header className="header">
      <h1>
        Fabulous <span className="accent">Writing</span>
      </h1>
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
        <label>
          {m.llm}
          <select
            value={store.provider}
            onChange={(e) => store.setProvider(e.target.value)}
          >
            {store.providers.map((provider) => (
              <option key={provider.name} value={provider.name}>
                {provider.name}
                {provider.available ? '' : m.offlineSuffix}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.model}
          <select
            value={store.model ?? activeProvider?.default_model ?? ''}
            onChange={(e) => store.setModel(e.target.value)}
          >
            {(activeProvider?.models.length
              ? activeProvider.models
              : [activeProvider?.default_model ?? '']
            ).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="auto-toggle" title={m.autoTitle}>
          <input
            type="checkbox"
            checked={store.llmAuto}
            onChange={(e) => store.setLlmAuto(e.target.checked)}
          />
          {m.autoLabel}
        </label>
        <button
          className="check-button"
          disabled={store.checkPhase !== 'idle'}
          onClick={() => void runCheck(true)}
        >
          {store.checkPhase === 'idle' ? m.check : m.checking}
        </button>
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
  const exampleText =
    profiles.find((p) => p.id === profileId)?.example_text ?? ''
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
