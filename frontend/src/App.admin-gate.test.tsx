// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from './api/client'
import { useStore } from './state/store'

// Rendering the default App export (unlike Header alone, which every other
// App.*.test.tsx file renders) fires initDocuments(), mounts CodeMirror via
// Editor, and mounts the sidebars — none of which this gate test cares
// about, so all four are replaced with trivial stubs. api/client keeps the
// importOriginal-spread form (see App.test.tsx), extended with
// getAdminUsers/getAdminTiers so the second test below can assert they were
// never called.
vi.mock('./api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/client')>()),
  getProviders: vi.fn().mockResolvedValue([]),
  getDomains: vi.fn().mockResolvedValue([]),
  getLanguages: vi.fn().mockResolvedValue([]),
  getRouting: vi.fn().mockResolvedValue(null),
  getProfiles: vi.fn().mockResolvedValue([]),
  getAdminUsers: vi.fn().mockResolvedValue([]),
  getAdminTiers: vi.fn().mockResolvedValue([]),
}))
vi.mock('./documents/documents', () => ({ initDocuments: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./editor/Editor', () => ({ Editor: () => null }))
vi.mock('./documents/DocumentSidebar', () => ({ DocumentSidebar: () => null }))
vi.mock('./sidebar/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('./checking/controller', () => ({ runCheck: vi.fn() }))
vi.mock('./header/DomainMultiSelect', () => ({ DomainMultiSelect: () => null }))
vi.mock('./header/LlmSelector', () => ({ LlmSelector: () => null }))
vi.mock('./header/ProfileSelector', () => ({ ProfileSelector: () => null }))
vi.mock('./auth/AccountMenu', () => ({ AccountMenu: () => null }))

import { getAdminUsers, getAdminTiers } from './api/client'
import App from './App'

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
    usage: { used_today: 0, limit: 500 },
    limits: {
      max_document_chars: 200000,
      max_llm_document_chars: 200000,
      concurrent_llm_runs: 5,
    },
    allow_additional_admins: false,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    language: 'en',
    domainIds: [],
    provider: 'ollama',
    model: null,
    tier: 'balanced',
    profiles: [],
    profileId: null,
    lastProfileByLanguage: {},
    docMeta: null,
    uiLocale: 'en',
    activeView: 'editor',
    token: 'tok',
  })
})

describe('admin nav gating', () => {
  it('admin nav button renders only for admins', async () => {
    // Literal strings, not m.viewAdmin: this task adds the key itself, so at
    // RED time the catalogs don't have it yet (see the brief's mutation-pin
    // for the parallel reasoning on the store's ActiveView union).
    useStore.setState({ user: user({ is_admin: false }) })
    render(<App />)
    await waitFor(() => expect(useStore.getState().languages).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull()

    useStore.setState({ user: user({ is_admin: true }) })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeNull(),
    )
  })

  it('non-admin session issues no /api/admin request even if activeView is forced to admin', async () => {
    useStore.setState({ user: user({ is_admin: false }) })
    useStore.getState().setActiveView('admin')
    render(<App />)
    await waitFor(() => expect(useStore.getState().languages).toBeDefined())

    expect(getAdminUsers).not.toHaveBeenCalled()
    expect(getAdminTiers).not.toHaveBeenCalled()
    expect(screen.queryByText('User management')).toBeNull()
  })
})
