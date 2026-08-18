// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import {
  initPrefsPersistence,
  loadUserPrefs,
  PREFS_DEFAULTS,
} from './prefsPersistence'
import { prefsKey, writePrefs } from './prefsStorage'
import { useStore } from './store'

function user(id: number): MeResponse {
  return {
    id,
    email: `user${id}@example.com`,
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
    usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
    limits: {
      max_document_chars: 200000,
      max_llm_document_chars: 200000,
      concurrent_llm_runs: 5,
    },
    allow_additional_admins: false,
    db_backend: 'sqlite',
  }
}

initPrefsPersistence()

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    ...PREFS_DEFAULTS,
    token: null,
    user: null,
    authStatus: 'anonymous',
  })
})

describe('loadUserPrefs', () => {
  it('applies stored values over defaults', () => {
    writePrefs(1, {
      ...PREFS_DEFAULTS,
      uiLocale: 'de',
      currentDocId: 7,
      docFoldersCollapsed: [3],
    })
    loadUserPrefs(1)
    const state = useStore.getState()
    expect(state.uiLocale).toBe('de')
    expect(state.currentDocId).toBe(7)
    expect(state.docFoldersCollapsed).toEqual([3])
    expect(state.docSidebarCollapsed).toBe(false)
  })

  it("resets to defaults for a user with no blob even when memory holds another user's values (the #34 leak)", () => {
    useStore.setState({
      uiLocale: 'de',
      currentDocId: 42,
      docSidebarCollapsed: true,
      rulesCollapsed: ['style'],
    })
    loadUserPrefs(2)
    const state = useStore.getState()
    expect(state.uiLocale).toBeNull()
    expect(state.currentDocId).toBeNull()
    expect(state.docSidebarCollapsed).toBe(false)
    expect(state.rulesCollapsed).toEqual([])
  })

  it('merges a partial blob over defaults (fields absent from storage reset)', () => {
    useStore.setState({ docSidebarCollapsed: true })
    localStorage.setItem(
      prefsKey(1),
      JSON.stringify({ state: { uiLocale: 'fr' }, version: 2 }),
    )
    loadUserPrefs(1)
    expect(useStore.getState().uiLocale).toBe('fr')
    expect(useStore.getState().docSidebarCollapsed).toBe(false)
  })
})

describe('write subscriber', () => {
  it("writes pref changes to the signed-in user's namespace, envelope format, six fields only", () => {
    useStore.getState().setAuth('tok', user(1))
    useStore.getState().setUiLocale('fr')
    const blob = JSON.parse(localStorage.getItem(prefsKey(1))!)
    expect(blob.version).toBe(2)
    expect(blob.state.uiLocale).toBe('fr')
    // Exactly the six pref fields — never token, never user.
    expect(Object.keys(blob.state).sort()).toEqual([
      'currentDocId',
      'docFoldersCollapsed',
      'docSidebarCollapsed',
      'lastProfileByLanguage',
      'rulesCollapsed',
      'uiLocale',
    ])
  })

  it('does not write while logged out', () => {
    useStore.getState().setUiLocale('fr')
    // Assert on the namespaced keys, not localStorage.length: until Task 3
    // lands, the still-installed persist middleware writes the legacy key
    // on every setState, and after Task 3 other tests may share storage.
    expect(localStorage.getItem(prefsKey(1))).toBeNull()
    expect(localStorage.getItem(prefsKey(2))).toBeNull()
  })

  it('does not write when only non-persisted fields change', () => {
    useStore.getState().setAuth('tok', user(1))
    localStorage.removeItem(prefsKey(1))
    useStore.getState().setDocWords(50)
    useStore.getState().setCheckPhase('fast')
    useStore.getState().setLanguage('de')
    expect(localStorage.getItem(prefsKey(1))).toBeNull()
  })
})

describe('boot wiring', () => {
  it('initPrefsPersistence deletes the legacy pre-B1 blob', async () => {
    vi.resetModules()
    localStorage.setItem(
      'fabulous-writing-settings',
      '{"state":{"uiLocale":"de"},"version":2}',
    )
    const fresh = await import('./prefsPersistence')
    fresh.initPrefsPersistence()
    expect(localStorage.getItem('fabulous-writing-settings')).toBeNull()
  })

  it('the store boots with the token from the token key', async () => {
    vi.resetModules()
    localStorage.setItem('fabulous-writing-token', 'boot-tok')
    const { useStore: freshStore } = await import('./store')
    expect(freshStore.getState().token).toBe('boot-tok')
  })
})
