import { useEffect } from 'react'
import './App.css'
import { ActivityView } from './activity/ActivityView'
import { AdminView } from './admin/AdminView'
import { AccountMenu } from './auth/AccountMenu'
import { llmDisabled } from './auth/policy'
import { runCheck } from './checking/controller'
import { flush, noteChange } from './documents/autosave'
import { initDocuments } from './documents/documents'
import { DocumentSidebar } from './documents/DocumentSidebar'
import { Editor } from './editor/Editor'
import { setEditorText } from './editor/editorRef'
import { DomainMultiSelect } from './header/DomainMultiSelect'
import { LlmSelector } from './header/LlmSelector'
import { ProfileSelector } from './header/ProfileSelector'
import { useHeaderData } from './header/useHeaderData'
import { ProfilesView } from './profiles/ProfilesView'
import { RulesView } from './rules/RulesView'
import { Sidebar } from './sidebar/Sidebar'
import { useMessages } from './i18n'
import { LocaleSwitcher } from './i18n/LocaleSwitcher'
import { languageLabel } from './languages'
import { useStore } from './state/store'
import { TerminologyView } from './terminology/TerminologyView'
import type { Language, WindowUsage } from './types'
import { Wordmark } from './Wordmark'

export default function App() {
  const activeView = useStore((s) => s.activeView)
  const isAdmin = useStore((s) => s.user?.is_admin ?? false)

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
      {activeView === 'admin' && isAdmin && <AdminView />}
      {activeView === 'activity' && <ActivityView />}
    </div>
  )
}

export function Header() {
  const store = useStore()
  const m = useMessages()

  useHeaderData()

  const usageWindows = store.user?.usage.windows ?? []
  const tightestWindow = usageWindows.reduce<WindowUsage | null>(
    (acc, w) => (acc === null || w.used_percent > acc.used_percent ? w : acc),
    null,
  )

  return (
    <header className="header">
      <div className="brand">
        <Wordmark />
        {store.appVersion === 'dev' && (
          <span className="instance-badge">
            {store.user?.db_backend ? `dev · ${store.user.db_backend}` : 'dev'}
          </span>
        )}
      </div>
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
        {(store.user?.is_admin ?? false) && (
          <button
            className={store.activeView === 'admin' ? 'active' : ''}
            onClick={() => store.setActiveView('admin')}
          >
            {m.viewAdmin}
          </button>
        )}
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
        <AccountMenu />
        {store.user && !llmDisabled(store.user) && tightestWindow && (
          <span
            className="quota-indicator"
            title={usageWindows
              .map((w) => `${m.windowName(w.window)}: ${w.used_percent}%`)
              .join(' · ')}
            aria-label={`${m.quotaIndicatorTitle}: ${store.user.usage.label} · ${usageWindows
              .map((w) => `${m.windowName(w.window)}: ${w.used_percent}%`)
              .join(', ')}`}
          >
            {store.user.usage.label} · {tightestWindow.used_percent}%
          </span>
        )}
      </div>
    </header>
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
