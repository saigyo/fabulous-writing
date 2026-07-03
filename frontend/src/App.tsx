import { useEffect } from 'react'
import './App.css'
import { getDomains, getProviders } from './api/client'
import { runCheck } from './checking/controller'
import { Editor } from './editor/Editor'
import { Sidebar } from './sidebar/Sidebar'
import { useStore } from './state/store'
import { TerminologyView } from './terminology/TerminologyView'
import type { Language } from './types'

export default function App() {
  const activeView = useStore((s) => s.activeView)

  return (
    <div className="app">
      <Header />
      {activeView === 'editor' ? (
        <main className="workspace">
          <Editor />
          <Sidebar />
        </main>
      ) : (
        <TerminologyView />
      )}
    </div>
  )
}

function Header() {
  const store = useStore()

  useEffect(() => {
    getProviders().then(store.setProviders).catch(() => store.setProviders([]))
    getDomains().then(store.setDomains).catch(() => store.setDomains([]))
  }, [])

  const activeProvider = store.providers.find((p) => p.name === store.provider)

  return (
    <header className="header">
      <h1>
        Fabulous <span className="accent">Writing</span>
      </h1>
      <nav className="view-switch">
        <button
          className={store.activeView === 'editor' ? 'active' : ''}
          onClick={() => store.setActiveView('editor')}
        >
          Editor
        </button>
        <button
          className={store.activeView === 'terminology' ? 'active' : ''}
          onClick={() => store.setActiveView('terminology')}
        >
          Terminology
        </button>
      </nav>
      <div className="header-controls">
        <label>
          Language
          <select
            value={store.language}
            onChange={(e) => store.setLanguage(e.target.value as Language)}
          >
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </select>
        </label>
        <label>
          Domain
          <select
            value={store.domainId ?? ''}
            onChange={(e) =>
              store.setDomainId(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">none</option>
            {store.domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          LLM
          <select
            value={store.provider}
            onChange={(e) => store.setProvider(e.target.value)}
          >
            {store.providers.map((provider) => (
              <option key={provider.name} value={provider.name}>
                {provider.name}
                {provider.available ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
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
        <label className="auto-toggle" title="Run the LLM check automatically after a pause">
          <input
            type="checkbox"
            checked={store.llmAuto}
            onChange={(e) => store.setLlmAuto(e.target.checked)}
          />
          auto
        </label>
        <button
          className="check-button"
          disabled={store.checkPhase !== 'idle'}
          onClick={() => void runCheck(true)}
        >
          {store.checkPhase === 'idle' ? 'Check' : 'Checking…'}
        </button>
      </div>
    </header>
  )
}
