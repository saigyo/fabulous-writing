// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { HeldBackSuggestion } from '../api/client'
import type { TrackedFinding } from '../editor/findings'
import type { Finding } from '../types'
import { persistConfig, resetSessionState, useStore } from './store'

function tracked(id: string, from: number, to: number, text: string): TrackedFinding {
  const finding: Finding = {
    id,
    category: 'style',
    severity: 'warning',
    source: 'rule',
    rule_id: 'style.test',
    message: 'm',
    span: { start: from, end: to, text },
    suggestions: [],
    advice: [],
  }
  return { finding, from, to }
}

const summary = (id: number, name: string, edited_at: string) => ({
  id,
  name,
  language: 'en' as const,
  folder_id: null,
  created_at: '2026-07-11T08:00:00+00:00',
  edited_at,
  checked_at: null,
  updated_at: edited_at,
})

describe('setTracked cache migration', () => {
  beforeEach(() => {
    useStore.setState({
      tracked: [],
      selectedId: null,
      extraSuggestions: {},
      suggestErrors: {},
      rewrites: {},
      rewriteErrors: {},
    })
  })

  it('migrates fetched suggestions and rewrites to the equivalent new finding', () => {
    const old = tracked('old', 8, 12, 'very')
    useStore.setState({
      tracked: [old],
      extraSuggestions: { old: ['extremely'] },
      rewrites: { old: { original: 'This is very good.', options: ['This shines.'] } },
      suggestErrors: { old: 'previous error' },
    })
    useStore.getState().setTracked([tracked('new', 8, 12, 'very')], 'new')
    const state = useStore.getState()
    expect(state.extraSuggestions).toEqual({ new: ['extremely'] })
    expect(state.rewrites.new?.options).toEqual(['This shines.'])
    expect(state.suggestErrors).toEqual({ new: 'previous error' })
  })

  it('still drops caches whose finding has no equivalent', () => {
    const old = tracked('old', 8, 12, 'very')
    useStore.setState({ tracked: [old], extraSuggestions: { old: ['extremely'] } })
    useStore.getState().setTracked([tracked('other', 30, 34, 'good')], null)
    expect(useStore.getState().extraSuggestions).toEqual({})
  })

  it('keeps caches for unchanged ids', () => {
    const same = tracked('keep', 8, 12, 'very')
    useStore.setState({ tracked: [same], extraSuggestions: { keep: ['extremely'] } })
    useStore.getState().setTracked([same], null)
    expect(useStore.getState().extraSuggestions).toEqual({ keep: ['extremely'] })
  })
})

describe('tier / pin semantics', () => {
  it('setTier enters tier mode', () => {
    useStore.getState().setTier('quality')
    expect(useStore.getState().tier).toBe('quality')
  })

  it('choosing a provider pins (clears the tier)', () => {
    useStore.getState().setTier('balanced')
    useStore.getState().setProvider('claude')
    expect(useStore.getState().tier).toBeNull()
    expect(useStore.getState().provider).toBe('claude')
    expect(useStore.getState().model).toBeNull()
  })

  it('choosing a model pins (clears the tier)', () => {
    useStore.getState().setTier('balanced')
    useStore.getState().setModel('claude-opus-4-8')
    expect(useStore.getState().tier).toBeNull()
    expect(useStore.getState().model).toBe('claude-opus-4-8')
  })

  it('setPinned pins a provider+model pair atomically', () => {
    useStore.getState().setTier('balanced')
    useStore.getState().setPinned('mistral', 'mistral-large-latest')
    const state = useStore.getState()
    expect(state.tier).toBeNull()
    expect(state.provider).toBe('mistral')
    expect(state.model).toBe('mistral-large-latest')
  })
})

describe('held-back suggestions', () => {
  const candidate: HeldBackSuggestion = {
    text: 'extremely',
    reason_kind: 'rules',
    rule_ids: ['style.weasel-words'],
    words: [],
  }

  it('stores and clears suggest held-back per finding', () => {
    useStore.getState().setSuggestHeldBack('f1', [candidate])
    expect(useStore.getState().suggestHeldBack['f1']).toEqual([candidate])
    useStore.getState().setSuggestHeldBack('f1', null)
    expect(useStore.getState().suggestHeldBack['f1']).toBeUndefined()
  })

  it('stores and clears rewrite held-back per finding', () => {
    useStore.getState().setRewriteHeldBack('f1', {
      original: 'This is very good.',
      candidates: [candidate],
    })
    expect(useStore.getState().rewriteHeldBack['f1']?.original).toBe('This is very good.')
    useStore.getState().setRewriteHeldBack('f1', null)
    expect(useStore.getState().rewriteHeldBack['f1']).toBeUndefined()
  })
})

describe('advice notes', () => {
  it('stores and clears suggest advice per finding', () => {
    useStore.getState().setSuggestAdvice('f1', ['Move this sentence.'])
    expect(useStore.getState().suggestAdvice['f1']).toEqual(['Move this sentence.'])
    useStore.getState().setSuggestAdvice('f1', null)
    expect(useStore.getState().suggestAdvice['f1']).toBeUndefined()
  })

  it('stores and clears rewrite advice per finding', () => {
    useStore.getState().setRewriteAdvice('f1', ['Split into two paragraphs.'])
    expect(useStore.getState().rewriteAdvice['f1']).toEqual(['Split into two paragraphs.'])
    useStore.getState().setRewriteAdvice('f1', null)
    expect(useStore.getState().rewriteAdvice['f1']).toBeUndefined()
  })
})

describe('folder state', () => {
  it('setFolders stores and toggleFolderCollapsed round-trips', () => {
    useStore.getState().setFolders([
      { id: 1, name: 'Blog', created_at: '2026-07-11T00:00:00+00:00' },
    ] as never[])
    expect(useStore.getState().folders[0].name).toBe('Blog')
    useStore.getState().toggleFolderCollapsed(1)
    expect(useStore.getState().docFoldersCollapsed).toEqual([1])
    useStore.getState().toggleFolderCollapsed(2)
    expect(useStore.getState().docFoldersCollapsed).toEqual([1, 2])
    useStore.getState().toggleFolderCollapsed(1)
    expect(useStore.getState().docFoldersCollapsed).toEqual([2])
  })
})

describe('document state', () => {
  it('setDocMeta mirrors currentDocId and patchDocMeta merges', () => {
    useStore.getState().setDocMeta({ id: 7, name: 'A', nameSource: 'fallback', revision: 0 })
    expect(useStore.getState().currentDocId).toBe(7)
    useStore.getState().patchDocMeta({ revision: 3 })
    expect(useStore.getState().docMeta).toEqual({ id: 7, name: 'A', nameSource: 'fallback', revision: 3 })
    useStore.getState().setDocMeta(null)
    expect(useStore.getState().currentDocId).toBeNull()
  })

  it('patchDocumentSummary merges and re-sorts by edited_at', () => {
    useStore.getState().setDocuments([
      summary(2, 'Two', '2026-07-11T10:00:00+00:00'),
      summary(1, 'One', '2026-07-11T09:00:00+00:00'),
    ])
    // Patch without edited_at: name updates, order unchanged.
    useStore.getState().patchDocumentSummary(1, { name: 'Renamed' })
    let docs = useStore.getState().documents
    expect(docs.map((d) => d.id)).toEqual([2, 1])
    expect(docs[1].name).toBe('Renamed')
    // Bumped edited_at moves the entry to the front.
    useStore.getState().patchDocumentSummary(1, { edited_at: '2026-07-11T11:00:00+00:00' })
    docs = useStore.getState().documents
    expect(docs.map((d) => d.id)).toEqual([1, 2])
    // Unknown id is a no-op.
    useStore.getState().patchDocumentSummary(99, { name: 'X' })
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([1, 2])
  })

  it('patchDocumentSummary breaks edited_at ties by id desc', () => {
    useStore.getState().setDocuments([
      summary(3, 'C', '2026-07-11T10:00:00+00:00'),
      summary(1, 'A', '2026-07-11T10:00:00+00:00'),
    ])
    useStore.getState().patchDocumentSummary(1, { edited_at: '2026-07-11T10:00:00+00:00' })
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([3, 1])
  })

  it('persist v1 -> v2 migration keeps old blobs loadable', () => {
    // The migrate function must accept a v1 blob (which still contains the
    // now-transient settings keys) without throwing.
    const migrated = persistConfig.migrate(
      { language: 'de', provider: 'ollama', uiLocale: 'de', rulesCollapsed: [] },
      1,
    )
    expect((migrated as any).uiLocale).toBe('de')
    expect(persistConfig.version).toBe(2)
  })

  it('persists the token but never the user object', () => {
    const persisted = persistConfig.partialize({
      ...useStore.getState(),
      token: 'a-token',
      user: { id: 1, email: 'ada@example.com', tier: 'basic', is_admin: false },
    } as never) as Record<string, unknown>
    expect(persisted.token).toBe('a-token')
    expect(persisted.user).toBeUndefined()
  })
})

describe('ActiveView', () => {
  it('activeView accepts admin and resets to editor on session reset', () => {
    useStore.getState().setActiveView('admin')
    expect(useStore.getState().activeView).toBe('admin')
    resetSessionState()
    expect(useStore.getState().activeView).toBe('editor')
  })
})

describe('resetSessionState', () => {
  it('resets the whole data half of the store, not just the persisted blob', () => {
    useStore.setState({
      tracked: [tracked('dirty', 0, 4, 'very')],
      documents: [summary(9, 'Dirty doc', '2026-07-11T00:00:00+00:00')],
      folders: [{ id: 1, name: 'Dirty folder', created_at: '' }] as never[],
      docMeta: { id: 9, name: 'Dirty doc', nameSource: 'user', revision: 3 },
      scorecard: { overall: 10 } as never,
      rewrites: { f1: { original: 'x', options: ['y'] } },
      uiLocale: 'de',
      currentDocId: 9,
    })
    resetSessionState()
    const state = useStore.getState()
    expect(state.tracked).toEqual([])
    expect(state.documents).toEqual([])
    expect(state.folders).toEqual([])
    expect(state.docMeta).toBeNull()
    expect(state.scorecard).toBeNull()
    expect(state.rewrites).toEqual({})
    expect(state.uiLocale).toBeNull()
    expect(state.currentDocId).toBeNull()
  })
})

describe('setAuth', () => {
  const user = {
    id: 1,
    email: 'ada@example.com',
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
  }

  beforeEach(() => {
    useStore.setState({
      token: null,
      user: null,
      authStatus: 'unknown',
      sessionExpired: false,
      restoreFailed: false,
    })
  })

  it('derives authenticated when both token and user are present', () => {
    useStore.getState().setAuth('tok', user)
    const state = useStore.getState()
    expect(state.authStatus).toBe('authenticated')
    expect(state.token).toBe('tok')
    expect(state.user).toEqual(user)
  })

  it('derives anonymous when either is missing', () => {
    useStore.getState().setAuth(null, null)
    expect(useStore.getState().authStatus).toBe('anonymous')
  })

  it('leaves sessionExpired untouched', () => {
    useStore.setState({ sessionExpired: true })
    useStore.getState().setAuth('tok', user)
    expect(useStore.getState().sessionExpired).toBe(true)
  })

  it('always clears restoreFailed', () => {
    useStore.setState({ restoreFailed: true })
    useStore.getState().setAuth(null, null)
    expect(useStore.getState().restoreFailed).toBe(false)
  })
})
