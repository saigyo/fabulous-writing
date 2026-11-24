// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from './api/client'
import { en } from './i18n/en'
import { useStore } from './state/store'

// The view switch is guarded in the store; the flag it reads is set here
// directly, so TerminologyView and the workspace are stubbed. AccountMenu
// stays real: its "Activity" item is one of the callers being guarded.
vi.mock('./api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/client')>()),
  getProviders: vi.fn().mockResolvedValue([]),
  getDomains: vi.fn().mockResolvedValue([]),
  getLanguages: vi.fn().mockResolvedValue([]),
  getRouting: vi.fn().mockResolvedValue(null),
  getProfiles: vi.fn().mockResolvedValue([]),
  getHealth: vi.fn(async () => ({ status: 'ok', name: '', version: 'dev' })),
}))
vi.mock('./documents/documents', () => ({
  initDocuments: vi.fn().mockResolvedValue(undefined),
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))
vi.mock('./editor/Editor', () => ({ Editor: () => null }))
vi.mock('./documents/DocumentSidebar', () => ({ DocumentSidebar: () => null }))
vi.mock('./sidebar/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('./checking/controller', () => ({ runCheck: vi.fn() }))
vi.mock('./header/DomainMultiSelect', () => ({ DomainMultiSelect: () => null }))
vi.mock('./header/LlmSelector', () => ({ LlmSelector: () => null }))
vi.mock('./header/ProfileSelector', () => ({ ProfileSelector: () => null }))
vi.mock('./terminology/TerminologyView', () => ({ TerminologyView: () => null }))
vi.mock('./activity/ActivityView', () => ({ ActivityView: () => null }))
vi.mock('./rules/RulesView', () => ({ RulesView: () => null }))

import App from './App'

const me: MeResponse = {
  id: 1,
  email: 'ada@example.com',
  display_name: null,
  tier: 'basic',
  is_admin: false,
  policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
  usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
  limits: { max_document_chars: 200000, max_llm_document_chars: 200000, concurrent_llm_runs: 5 },
  allow_additional_admins: false,
  db_backend: 'sqlite',
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    uiLocale: 'en',
    activeView: 'terminology',
    pendingView: null,
    terminologyUnsaved: false,
    token: 'tok',
    user: me,
    authStatus: 'authenticated',
  })
})

const ways = [
  ['a view in the header', 'rules', (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: en.viewRules }))],
  ['the account menu\'s "Activity" item', 'activity', async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: en.accountMenu }))
    await user.click(screen.getByRole('button', { name: en.accountActivity }))
  }],
] as const

describe('leaving the terminology view', () => {
  it.each(ways)('switches at once through %s while nothing is unsaved', async (_, view, leave) => {
    const user = userEvent.setup()
    render(<App />)
    await leave(user)
    expect(useStore.getState().activeView).toBe(view)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(ways)('asks first through %s while something is unsaved', async (_, view, leave) => {
    useStore.setState({ terminologyUnsaved: true })
    const user = userEvent.setup()
    render(<App />)
    await leave(user)
    const dialog = await screen.findByRole('dialog')
    within(dialog).getByText(en.leaveUnsavedConfirm)
    expect(useStore.getState().activeView).toBe('terminology')

    await user.click(within(dialog).getByRole('button', { name: en.leaveUnsaved }))
    expect(useStore.getState().activeView).toBe(view)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays when the question is cancelled', async () => {
    useStore.setState({ terminologyUnsaved: true })
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: en.viewEditor }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.dialogCancel }))
    expect(useStore.getState().activeView).toBe('terminology')
    expect(useStore.getState().pendingView).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
