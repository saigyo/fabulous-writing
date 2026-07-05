import { useEffect } from 'react'
import './App.css'
import { getDemoText, getDomains, getLanguages, getProviders } from './api/client'
import { runCheck } from './checking/controller'
import { Editor } from './editor/Editor'
import { setEditorText } from './editor/editorRef'
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
      </nav>
      <div className="header-controls">
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
          <select
            value={store.domainIds[0] ?? ''}
            onChange={(e) =>
              store.setDomainIds(e.target.value ? [Number(e.target.value)] : [])
            }
          >
            <option value="">{m.domainNone}</option>
            {store.domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.name}
              </option>
            ))}
          </select>
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
  return (
    <button
      className="load-example"
      title={m.exampleTitle}
      onClick={() => {
        const store = useStore.getState()
        // Terminology only runs with a domain; default to the first one.
        if (store.domainIds.length === 0 && store.domains.length > 0) {
          store.setDomainIds([store.domains[0].id])
        }
        void getDemoText(store.language)
          .then(({ text }) => setEditorText(text))
          .catch(() => {})
      }}
    >
      ⤓ {m.loadExample}
    </button>
  )
}
