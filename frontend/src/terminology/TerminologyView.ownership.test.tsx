// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { de } from '../i18n/de'
import { en } from '../i18n/en'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type { Concept, Domain } from '../types'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getDomains: vi.fn(),
  getConcepts: vi.fn().mockResolvedValue([]),
  createDomain: vi.fn(),
  deleteDomain: vi.fn(),
  updateDomain: vi.fn(),
  saveConceptLanguage: vi.fn(),
  createConcept: vi.fn(),
  getConcept: vi.fn(),
  removeConceptFromDomain: vi.fn(),
  deleteConcept: vi.fn(),
  // This file renders TerminologyView directly, not LoginGate, so nothing
  // here would actually call getHealth — mocked anyway (Task 7) so a real
  // fetch is never one accidental render away.
  getHealth: vi.fn(async () => ({ status: 'ok', name: '', version: 'dev' })),
  postLogin: vi.fn(),
  // Resolved once here (see App.domains-guard.test.tsx's comment): this
  // file's beforeEach uses clearAllMocks(), which preserves the
  // implementation, and every logout() below runs with a real token.
  postLogout: vi.fn().mockResolvedValue(undefined),
}))
// documents.ts pulls in hydration.ts -> checking/controller.ts; logout()
// (via auth/session.ts) only needs these two exports, so the module is
// replaced outright rather than partially mocked (matching session.test.ts).
vi.mock('../documents/documents', () => ({
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))

import {
  createConcept,
  createDomain,
  deleteConcept,
  deleteDomain,
  getConcept,
  getConcepts,
  getDomains,
  HttpError,
  postLogin,
  removeConceptFromDomain,
  saveConceptLanguage,
  updateDomain,
} from '../api/client'
import { login, logout } from '../auth/session'
import { TerminologyView } from './TerminologyView'

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
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
    db_backend: 'sqlite',
    ...overrides,
  }
}

const globalDomain: Domain = { id: 1, name: 'Global Domain', description: '', is_global: true }
const privateDomain: Domain = { id: 2, name: 'Private Domain', description: '', is_global: false }

function conceptOf(id: number, text: string, domainIds: number[]): Concept {
  return {
    id,
    uid: `c${id}`,
    domain_ids: domainIds,
    is_global: false,
    revision: 1,
    created_at: null,
    created_by: null,
    modified_at: null,
    modified_by: null,
    sections: [
      {
        id: id * 10,
        language: 'en',
        definition: '',
        revision: 1,
        created_at: null,
        created_by: null,
        modified_at: null,
        modified_by: null,
        terms: [
          {
            id: id * 100,
            uid: `t${id}`,
            text,
            usage_status: 'preferred',
            process_status: 'active',
            status_reason: '',
            context: '',
            source: '',
            part_of_speech: null,
            case_sensitive: false,
            revision: 1,
            created_at: null,
            created_by: null,
            modified_at: null,
            modified_by: null,
          },
        ],
      },
    ],
  }
}

const concept = conceptOf(100, 'widget', [1])

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getDomains).mockResolvedValue([globalDomain, privateDomain])
  vi.mocked(getConcepts).mockResolvedValue([])
  useStore.setState({
    uiLocale: 'en',
    languages: FALLBACK_LANGUAGES,
    domains: [globalDomain, privateDomain],
    user: user({ is_admin: false }),
    token: 'old-token',
    authStatus: 'authenticated',
  })
})

describe('TerminologyView ownership affordances (non-admin)', () => {
  it('shows the built-in badge and hides rename/delete on a global domain row; double-click does not rename', async () => {
    render(<TerminologyView />)
    const globalRow = (await screen.findByText('Global Domain')).closest('.domain-row') as HTMLElement
    within(globalRow).getByText(en.globalBadge)
    expect(within(globalRow).queryByTitle(en.renameDomainTitle)).toBeNull()
    expect(within(globalRow).queryByTitle(en.deleteDomainTitle)).toBeNull()

    await userEvent.dblClick(within(globalRow).getByText('Global Domain'))
    expect(within(globalRow).queryByRole('textbox')).toBeNull()
  })

  it('keeps both buttons on a private domain row', async () => {
    render(<TerminologyView />)
    const privateRow = (await screen.findByText('Private Domain')).closest('.domain-row') as HTMLElement
    within(privateRow).getByTitle(en.renameDomainTitle)
    within(privateRow).getByTitle(en.deleteDomainTitle)
  })

  it('renders no new-concept button when a global domain is active', async () => {
    vi.mocked(getConcepts).mockResolvedValue([concept])
    useStore.setState({
      user: user({
        policy: { llm: { tiers: null, providers: null, models: null }, features: ['custom_domains'] },
      }),
    })
    render(<TerminologyView />)
    // The first domain (global) auto-selects as active.
    await screen.findByRole('button', { name: 'widget' })
    expect(screen.queryByRole('button', { name: en.newConcept })).toBeNull()
  })

  it('restores the new-concept button once is_admin flips to true, on the same fixtures', async () => {
    // An admin's /me policy already carries every feature (M4 §8) — the
    // button is gated on custom_domains, not on is_admin itself.
    useStore.setState({
      user: user({
        is_admin: true,
        policy: {
          llm: { tiers: null, providers: null, models: null },
          features: ['custom_domains'],
        },
      }),
    })
    vi.mocked(getConcepts).mockResolvedValue([concept])
    render(<TerminologyView />)

    const globalRow = (await screen.findByText('Global Domain')).closest('.domain-row') as HTMLElement
    within(globalRow).getByTitle(en.renameDomainTitle)
    within(globalRow).getByTitle(en.deleteDomainTitle)

    await screen.findByRole('button', { name: 'widget' })
    screen.getByRole('button', { name: en.newConcept })
  })
})

describe('TerminologyView concept list opens the concept entry', () => {
  it('opens a concept from its row and comes back to the list', async () => {
    vi.mocked(getConcepts).mockResolvedValue([concept])
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'widget' }))
    expect(screen.queryByRole('button', { name: 'widget' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: `← ${globalDomain.name}` }))
    screen.getByRole('button', { name: 'widget' })
  })

  it('leaves an open concept when the domain changes', async () => {
    vi.mocked(getConcepts).mockResolvedValue([concept])
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'widget' }))
    const privateRow = screen.getByText('Private Domain').closest('.domain-row') as HTMLElement
    await userEvent.click(within(privateRow).getByText('Private Domain'))
    expect(screen.queryByRole('button', { name: `← ${globalDomain.name}` })).toBeNull()
  })
})

describe('TerminologyView deleting a domain asks first', () => {
  it('names the concepts that are in no other domain and deletes only after confirming', async () => {
    useStore.setState({ domains: [privateDomain], user: user() })
    vi.mocked(getDomains).mockResolvedValue([privateDomain])
    vi.mocked(getConcepts).mockResolvedValue([
      conceptOf(1, 'alone', [2]),
      conceptOf(2, 'also alone', [2]),
      conceptOf(3, 'shared', [2, 3]),
    ])
    vi.mocked(deleteDomain).mockResolvedValue(undefined)
    render(<TerminologyView />)
    await screen.findByRole('button', { name: 'alone' })

    await userEvent.click(screen.getByTitle(en.deleteDomainTitle))
    const dialog = await screen.findByRole('dialog')
    within(dialog).getByText(en.deleteDomainConfirm('Private Domain', 2))
    expect(deleteDomain).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: en.deleteDomainTitle }))
    await waitFor(() => expect(deleteDomain).toHaveBeenCalledWith(2))
  })

  it('does not delete when the question is cancelled', async () => {
    useStore.setState({ domains: [privateDomain], user: user() })
    vi.mocked(getDomains).mockResolvedValue([privateDomain])
    render(<TerminologyView />)
    await userEvent.click(await screen.findByTitle(en.deleteDomainTitle))
    const dialog = await screen.findByRole('dialog')
    within(dialog).getByText(en.deleteDomainConfirm('Private Domain', 0))
    await userEvent.click(within(dialog).getByRole('button', { name: en.dialogCancel }))
    expect(deleteDomain).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('TerminologyView concepts fetch: latest-request-wins on domain switch', () => {
  const privateA: Domain = { id: 2, name: 'Private A', description: '', is_global: false }
  const privateB: Domain = { id: 3, name: 'Private B', description: '', is_global: false }

  it('clears rows immediately on switch and discards an out-of-order stale fetch from the previous domain', async () => {
    useStore.setState({ domains: [privateA, privateB] })
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB])

    let resolveA!: (concepts: Concept[]) => void
    let resolveB!: (concepts: Concept[]) => void
    const fetchA = new Promise<Concept[]>((resolve) => {
      resolveA = resolve
    })
    const fetchB = new Promise<Concept[]>((resolve) => {
      resolveB = resolve
    })
    vi.mocked(getConcepts).mockImplementation((domainId: number) => {
      if (domainId === privateA.id) return fetchA
      if (domainId === privateB.id) return fetchB
      return Promise.resolve([])
    })

    render(<TerminologyView />)
    await waitFor(() => expect(getConcepts).toHaveBeenCalledWith(privateA.id))

    const rowB = (await screen.findByText('Private B')).closest('.domain-row') as HTMLElement
    await userEvent.click(within(rowB).getByText('Private B'))
    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull()

    resolveB([conceptOf(202, 'beta', [3])])
    await screen.findByRole('button', { name: 'beta' })

    resolveA([conceptOf(201, 'alpha', [2])])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull()
    screen.getByRole('button', { name: 'beta' })
  })

  it('discards an older fetch of the same domain that resolves after a newer one', async () => {
    useStore.setState({ domains: [privateA, privateB] })
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB])

    let resolveOldA!: (concepts: Concept[]) => void
    let callsA = 0
    vi.mocked(getConcepts).mockImplementation((domainId: number) => {
      if (domainId !== privateA.id) return Promise.resolve([])
      callsA += 1
      if (callsA === 1) {
        return new Promise<Concept[]>((resolve) => {
          resolveOldA = resolve
        })
      }
      return Promise.resolve([conceptOf(203, 'fresh', [2])])
    })

    render(<TerminologyView />)
    await waitFor(() => expect(callsA).toBe(1))

    const rowB = (await screen.findByText('Private B')).closest('.domain-row') as HTMLElement
    await userEvent.click(within(rowB).getByText('Private B'))
    const rowA = screen.getByText('Private A').closest('.domain-row') as HTMLElement
    await userEvent.click(within(rowA).getByText('Private A'))
    await screen.findByRole('button', { name: 'fresh' })

    resolveOldA([conceptOf(204, 'old', [2])])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByRole('button', { name: 'old' })).toBeNull()
    screen.getByRole('button', { name: 'fresh' })
  })
})

describe('TerminologyView answers from an entry the writer has left', () => {
  const privateA: Domain = { id: 2, name: 'Private A', description: '', is_global: false }
  const privateB: Domain = { id: 3, name: 'Private B', description: '', is_global: false }

  beforeEach(() => {
    useStore.setState({ domains: [privateA, privateB] })
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB])
  })

  it('does not put a concept saved for the previous domain into the list shown', async () => {
    vi.mocked(getConcepts).mockImplementation(async (domainId: number) =>
      domainId === privateA.id ? [conceptOf(201, 'alpha', [2])] : [conceptOf(202, 'beta', [3])],
    )
    let resolveSave!: (concept: Concept) => void
    vi.mocked(saveConceptLanguage).mockReturnValue(
      new Promise<Concept>((resolve) => {
        resolveSave = resolve
      }),
    )
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(screen.getByRole('textbox', { name: en.definitionLabel }), 'A letter')
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    expect(saveConceptLanguage).toHaveBeenCalledTimes(1)

    const rowB = screen.getAllByText('Private B').find((el) => el.closest('.domain-row')) as HTMLElement
    await userEvent.click(rowB)
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: en.leaveUnsaved }))
    await screen.findByRole('button', { name: 'beta' })

    resolveSave(conceptOf(201, 'alpha saved', [2]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByRole('button', { name: 'alpha saved' })).toBeNull()
    screen.getByRole('button', { name: 'beta' })
  })

  it('does not reload the previous domain when a removal answers after the switch', async () => {
    let callsA = 0
    vi.mocked(getConcepts).mockImplementation(async (domainId: number) => {
      if (domainId !== privateA.id) return [conceptOf(202, 'beta', [3])]
      callsA += 1
      return callsA === 1 ? [conceptOf(201, 'alpha', [2, 9])] : [conceptOf(205, 'alpha reloaded', [2])]
    })
    let resolveRemove!: () => void
    vi.mocked(removeConceptFromDomain).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRemove = resolve
      }),
    )
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.click(screen.getByRole('button', { name: en.removeFromDomain }))
    expect(removeConceptFromDomain).toHaveBeenCalledWith(2, 201)

    const rowB = screen.getAllByText('Private B').find((el) => el.closest('.domain-row')) as HTMLElement
    await userEvent.click(rowB)
    await screen.findByRole('button', { name: 'beta' })

    resolveRemove()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callsA).toBe(1)
    expect(screen.queryByRole('button', { name: 'alpha reloaded' })).toBeNull()
    screen.getByRole('button', { name: 'beta' })
  })

  const rowOf = (name: string) =>
    screen.getAllByText(name).find((el) => el.closest('.domain-row'))!.closest('.domain-row') as HTMLElement
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const definitionField = () => screen.getByRole('textbox', { name: en.definitionLabel }) as HTMLTextAreaElement

  function serverWithShared(shared: () => Concept[]) {
    vi.mocked(getConcepts).mockImplementation(async (domainId: number) =>
      domainId === privateA.id ? [conceptOf(201, 'alpha', [2, 3])] : shared(),
    )
  }

  it('does not let a late save answer replace a newer copy in the list', async () => {
    let shared = [conceptOf(201, 'alpha', [2, 3])]
    serverWithShared(() => shared)
    let resolveFirst!: (concept: Concept) => void
    vi.mocked(saveConceptLanguage)
      .mockReturnValueOnce(new Promise<Concept>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(async () => {
        shared = [conceptOf(201, 'newer', [2, 3])]
        return shared[0]
      })
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(definitionField(), 'first')
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    await userEvent.click(rowOf('Private B'))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.leaveUnsaved }))

    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(definitionField(), 'second')
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    await screen.findByText(`✓ ${en.sectionSaved}`)
    await userEvent.click(screen.getByRole('button', { name: `← ${privateB.name}` }))
    screen.getByRole('button', { name: 'newer' })

    resolveFirst(conceptOf(201, 'older', [2, 3]))
    await tick()
    await tick()
    expect(screen.queryByRole('button', { name: 'older' })).toBeNull()
    screen.getByRole('button', { name: 'newer' })
  })

  it('reloads the list shown when a save answers from an entry the writer has left', async () => {
    let shared = [conceptOf(201, 'alpha', [2, 3])]
    serverWithShared(() => shared)
    let resolveSave!: (concept: Concept) => void
    vi.mocked(saveConceptLanguage).mockReturnValue(new Promise<Concept>((resolve) => (resolveSave = resolve)))
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(definitionField(), 'first')
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    await userEvent.click(rowOf('Private B'))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.leaveUnsaved }))
    await screen.findByRole('button', { name: 'alpha' })

    shared = [conceptOf(201, 'omega', [2, 3])]
    resolveSave(shared[0])
    await screen.findByRole('button', { name: 'omega' })
  })

  it('closes an entry for a concept deleted while the writer moved to another domain', async () => {
    let shared = [conceptOf(201, 'alpha', [2, 3])]
    serverWithShared(() => shared)
    let resolveDelete!: () => void
    vi.mocked(deleteConcept).mockReturnValue(new Promise<void>((resolve) => (resolveDelete = resolve)))
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.click(screen.getByRole('button', { name: en.deleteConcept }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.deleteConcept }))
    await userEvent.click(rowOf('Private B'))
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))

    shared = []
    resolveDelete()
    await waitFor(() => expect(screen.queryByRole('button', { name: `← ${privateB.name}` })).toBeNull())
    await tick()
    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull()
  })

  it('keeps an entry in another domain open when the concept was only removed from the first', async () => {
    serverWithShared(() => [conceptOf(201, 'alpha', [3])])
    let resolveRemove!: () => void
    vi.mocked(removeConceptFromDomain).mockReturnValue(new Promise<void>((resolve) => (resolveRemove = resolve)))
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.click(screen.getByRole('button', { name: en.removeFromDomain }))
    await userEvent.click(rowOf('Private B'))
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))

    resolveRemove()
    await tick()
    await tick()
    screen.getByRole('button', { name: `← ${privateB.name}` })
  })

  it('keeps the entry of another domain when a pending domain delete answers', async () => {
    vi.mocked(getConcepts).mockImplementation(async (domainId: number) =>
      domainId === privateA.id ? [conceptOf(201, 'alpha', [2])] : [conceptOf(202, 'beta', [3])],
    )
    let resolveDelete!: () => void
    vi.mocked(deleteDomain).mockReturnValue(new Promise<void>((resolve) => (resolveDelete = resolve)))
    render(<TerminologyView />)
    await screen.findByRole('button', { name: 'alpha' })
    await userEvent.click(within(rowOf('Private A')).getByTitle(en.deleteDomainTitle))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.deleteDomainTitle }))
    expect(deleteDomain).toHaveBeenCalledWith(privateA.id)

    await userEvent.click(rowOf('Private B'))
    await userEvent.click(await screen.findByRole('button', { name: 'beta' }))
    await userEvent.type(definitionField(), 'B edit')
    vi.mocked(getDomains).mockResolvedValue([privateB])
    resolveDelete()
    await waitFor(() => expect(screen.queryByText('Private A')).toBeNull())

    screen.getByRole('button', { name: `← ${privateB.name}` })
    expect(definitionField().value).toBe('B edit')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('fetches nothing when a save answers after the view was left', async () => {
    vi.mocked(getConcepts).mockResolvedValue([conceptOf(201, 'alpha', [2])])
    let resolveSave!: (concept: Concept) => void
    vi.mocked(saveConceptLanguage).mockReturnValue(new Promise<Concept>((resolve) => (resolveSave = resolve)))
    const { unmount } = render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(definitionField(), 'A letter')
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    await userEvent.click(rowOf('Private B'))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.leaveUnsaved }))
    await tick()
    unmount()
    const before = vi.mocked(getConcepts).mock.calls.length

    resolveSave(conceptOf(201, 'alpha', [2]))
    await tick()
    expect(vi.mocked(getConcepts).mock.calls.length).toBe(before)
  })

  it('does not close another rename field when an earlier rename answers', async () => {
    let resolveRename!: () => void
    vi.mocked(updateDomain).mockReturnValue(new Promise((resolve) => (resolveRename = () => resolve(privateA))))
    render(<TerminologyView />)
    await userEvent.click(within(rowOf('Private A')).getByTitle(en.renameDomainTitle))
    await userEvent.type(screen.getByDisplayValue('Private A'), ' x{Enter}')
    await userEvent.click(within(rowOf('Private B')).getByTitle(en.renameDomainTitle))
    await userEvent.type(screen.getByDisplayValue('Private B'), ' y')

    resolveRename()
    await tick()
    await tick()
    screen.getByDisplayValue('Private B y')
  })
})

describe('TerminologyView leaving an entry with unsaved changes', () => {
  const privateA: Domain = { id: 2, name: 'Private A', description: '', is_global: false }
  const privateB: Domain = { id: 3, name: 'Private B', description: '', is_global: false }
  const added: Domain = { id: 4, name: 'Fresh', description: '', is_global: false }
  const unsaved = () => useStore.getState().terminologyUnsaved
  const back = () => screen.queryByRole('button', { name: `← ${privateA.name}` })
  const rowOf = (name: string) =>
    screen.getAllByText(name).find((el) => el.closest('.domain-row')) as HTMLElement

  beforeEach(() => {
    useStore.setState({
      domains: [privateA, privateB],
      terminologyUnsaved: false,
      user: user({ policy: { llm: { tiers: null, providers: null, models: null }, features: ['custom_domains'] } }),
    })
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB])
    vi.mocked(getConcepts).mockImplementation(async (domainId: number) =>
      domainId === privateA.id ? [conceptOf(201, 'alpha', [2])] : [conceptOf(202, 'beta', [3])],
    )
  })

  async function editAlpha() {
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(screen.getByRole('textbox', { name: en.definitionLabel }), 'A letter')
    expect(unsaved()).toBe(true)
  }

  async function answerLeave(name: string) {
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name }))
  }

  it('asks before another domain and switches only after confirming', async () => {
    await editAlpha()
    await userEvent.click(rowOf('Private B'))
    await answerLeave(en.dialogCancel)
    expect(back()).not.toBeNull()
    expect(unsaved()).toBe(true)

    await userEvent.click(rowOf('Private B'))
    await answerLeave(en.leaveUnsaved)
    await screen.findByRole('button', { name: 'beta' })
    expect(back()).toBeNull()
    expect(unsaved()).toBe(false)
  })

  it('asks before the way back and is clear after leaving the entry', async () => {
    await editAlpha()
    await userEvent.click(back()!)
    await answerLeave(en.leaveUnsaved)
    screen.getByRole('button', { name: 'alpha' })
    expect(unsaved()).toBe(false)
  })

  it('asks before adding a domain, which makes it active', async () => {
    vi.mocked(createDomain).mockResolvedValue(added)
    await editAlpha()
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB, added])
    await userEvent.type(screen.getByPlaceholderText(en.newDomainPlaceholder), 'Fresh')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    await screen.findByRole('dialog')
    expect(createDomain).not.toHaveBeenCalled()

    await answerLeave(en.leaveUnsaved)
    await waitFor(() => expect(getConcepts).toHaveBeenCalledWith(added.id))
    expect(createDomain).toHaveBeenCalledWith('Fresh')
    expect(back()).toBeNull()
  })

  it('closes a clean entry as soon as a domain is being added', async () => {
    vi.mocked(createDomain).mockReturnValue(new Promise<Domain>(() => {}))
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(screen.getByPlaceholderText(en.newDomainPlaceholder), 'Fresh')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    expect(createDomain).toHaveBeenCalledWith('Fresh')
    expect(back()).toBeNull()
    expect(screen.queryByRole('textbox', { name: en.definitionLabel })).toBeNull()
  })

  it('does not make a new domain active over edits typed while it was being created', async () => {
    let answerCreate!: (domain: Domain) => void
    vi.mocked(createDomain).mockReturnValue(new Promise<Domain>((resolve) => (answerCreate = resolve)))
    render(<TerminologyView />)
    await userEvent.type(await screen.findByPlaceholderText(en.newDomainPlaceholder), 'Fresh')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(screen.getByRole('textbox', { name: en.definitionLabel }), 'A letter')

    vi.mocked(getDomains).mockResolvedValue([privateA, privateB, added])
    answerCreate(added)
    await waitFor(() => expect(rowOf('Fresh')).toBeDefined())
    const freshRow = rowOf('Fresh').closest('.domain-row') as HTMLElement
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(freshRow.classList.contains('selected')).toBe(false)
    expect(getConcepts).not.toHaveBeenCalledWith(added.id)
    expect(back()).not.toBeNull()
    expect((screen.getByRole('textbox', { name: en.definitionLabel }) as HTMLTextAreaElement).value).toBe('A letter')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('adds a domain at once while nothing is unsaved', async () => {
    vi.mocked(createDomain).mockResolvedValue(added)
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(screen.getByPlaceholderText(en.newDomainPlaceholder), 'Fresh')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    await waitFor(() => expect(createDomain).toHaveBeenCalledWith('Fresh'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks before deleting the active domain, after the delete question', async () => {
    vi.mocked(deleteDomain).mockResolvedValue(undefined)
    await editAlpha()
    const rowA = rowOf('Private A').closest('.domain-row') as HTMLElement
    await userEvent.click(within(rowA).getByTitle(en.deleteDomainTitle))
    await answerLeave(en.deleteDomainTitle)
    within(await screen.findByRole('dialog')).getByText(en.leaveUnsavedConfirm)
    expect(deleteDomain).not.toHaveBeenCalled()

    await answerLeave(en.leaveUnsaved)
    await waitFor(() => expect(deleteDomain).toHaveBeenCalledWith(privateA.id))
  })

  it('deletes nothing and keeps the entry when the leave question is cancelled', async () => {
    vi.mocked(deleteDomain).mockResolvedValue(undefined)
    await editAlpha()
    const rowA = rowOf('Private A').closest('.domain-row') as HTMLElement
    await userEvent.click(within(rowA).getByTitle(en.deleteDomainTitle))
    await answerLeave(en.deleteDomainTitle)
    await answerLeave(en.dialogCancel)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteDomain).not.toHaveBeenCalled()
    expect(back()).not.toBeNull()
    expect((screen.getByRole('textbox', { name: en.definitionLabel }) as HTMLTextAreaElement).value).toBe('A letter')
    expect(unsaved()).toBe(true)
  })

  it('deletes another domain without the leave question', async () => {
    vi.mocked(deleteDomain).mockResolvedValue(undefined)
    await editAlpha()
    const rowB = rowOf('Private B').closest('.domain-row') as HTMLElement
    await userEvent.click(within(rowB).getByTitle(en.deleteDomainTitle))
    await answerLeave(en.deleteDomainTitle)
    await waitFor(() => expect(deleteDomain).toHaveBeenCalledWith(privateB.id))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(back()).not.toBeNull()
  })

  it('is clear after saving', async () => {
    const saved = conceptOf(201, 'alpha', [2])
    saved.sections[0].definition = 'A letter'
    vi.mocked(saveConceptLanguage).mockResolvedValue(saved)
    await editAlpha()
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    await waitFor(() => expect(unsaved()).toBe(false))
  })

  it('is clear after discarding', async () => {
    await editAlpha()
    await userEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(unsaved()).toBe(false)
  })

  it('is clear after the view unmounts', async () => {
    await editAlpha()
    cleanup()
    expect(unsaved()).toBe(false)
  })

  it('holds back closing the tab only while something is unsaved', async () => {
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    await editAlpha()
    expect(unload()).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(unload()).toBe(false)
  })
})

describe('TerminologyView keeps the list behind the entry current', () => {
  const privateA: Domain = { id: 2, name: 'Private A', description: '', is_global: false }
  const back = () => screen.queryByRole('button', { name: `← ${privateA.name}` })

  beforeEach(() => {
    useStore.setState({ domains: [privateA] })
    vi.mocked(getDomains).mockResolvedValue([privateA])
  })

  it('starts the list on the interface language', async () => {
    useStore.setState({ uiLocale: 'de' })
    vi.mocked(getConcepts).mockResolvedValue([conceptOf(201, 'alpha', [2])])
    render(<TerminologyView />)
    await screen.findByRole('button', { name: 'alpha' })
    const selector = screen.getByRole('combobox', { name: de.conceptLanguageTitle }) as HTMLSelectElement
    expect(selector.value).toBe('de')
  })

  it('keeps the chosen language of the list after an entry was open', async () => {
    const bilingual = conceptOf(201, 'widget', [2])
    bilingual.sections.push({
      ...bilingual.sections[0],
      id: 2011,
      language: 'de',
      terms: [{ ...bilingual.sections[0].terms[0], id: 20111, uid: 'tde', text: 'Bauteil' }],
    })
    vi.mocked(getConcepts).mockResolvedValue([bilingual])
    render(<TerminologyView />)
    await screen.findByRole('button', { name: 'widget' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: en.conceptLanguageTitle }), 'de')

    await userEvent.click(screen.getByRole('button', { name: 'Bauteil' }))
    await userEvent.click(back()!)
    const selector = screen.getByRole('combobox', { name: en.conceptLanguageTitle }) as HTMLSelectElement
    expect(selector.value).toBe('de')
    screen.getByRole('button', { name: 'Bauteil' })
  })

  it('shows the list again and fetches it once more after a removal from this domain', async () => {
    let calls = 0
    vi.mocked(getConcepts).mockImplementation(async () => {
      calls += 1
      return calls === 1 ? [conceptOf(201, 'alpha', [2, 9])] : []
    })
    vi.mocked(removeConceptFromDomain).mockResolvedValue(undefined)
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.click(screen.getByRole('button', { name: en.removeFromDomain }))

    await waitFor(() => expect(calls).toBe(2))
    expect(back()).toBeNull()
    screen.getByRole('heading', { name: en.concepts })
  })

  it('shows the saved label after a language save and the way back', async () => {
    vi.mocked(getConcepts).mockResolvedValue([conceptOf(201, 'alpha', [2])])
    vi.mocked(saveConceptLanguage).mockResolvedValue(conceptOf(201, 'omega', [2]))
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    const text = screen.getByRole('textbox', { name: en.termLabel })
    await userEvent.clear(text)
    await userEvent.type(text, 'omega')
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    await screen.findByText(`✓ ${en.sectionSaved}`)

    await userEvent.click(back()!)
    screen.getByRole('button', { name: 'omega' })
    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull()
    expect(getConcepts).toHaveBeenCalledTimes(1)
  })

  it('keeps a concept saved while the first list request was pending', async () => {
    useStore.setState({
      user: user({ policy: { llm: { tiers: null, providers: null, models: null }, features: ['custom_domains'] } }),
    })
    const created = conceptOf(301, 'widget', [2])
    const answers: ((concepts: Concept[]) => void)[] = []
    vi.mocked(getConcepts).mockImplementation(
      () => new Promise<Concept[]>((resolve) => answers.push(resolve)),
    )
    vi.mocked(createConcept).mockResolvedValue(created)
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: en.newConcept }))
    await userEvent.type(screen.getByRole('textbox', { name: en.termLabel }), 'widget')
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    await waitFor(() => expect(answers).toHaveLength(2))

    answers[0]([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    answers[1]([created])
    await userEvent.click(back()!)
    await screen.findByRole('button', { name: 'widget' })
  })

  it('shows the loaded version in the list and opens the entry from it', async () => {
    vi.mocked(getConcepts).mockResolvedValue([conceptOf(201, 'alpha', [2])])
    vi.mocked(saveConceptLanguage).mockRejectedValue(
      new HttpError(409, 'PUT failed', 'conflict', { part: 'en' }),
    )
    vi.mocked(getConcept).mockResolvedValue(conceptOf(201, 'from server', [2]))
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.type(screen.getByRole('textbox', { name: en.definitionLabel }), 'A letter')
    await userEvent.click(screen.getByRole('button', { name: en.saveLanguage('English') }))
    await userEvent.click(await screen.findByRole('button', { name: en.loadCurrentVersion }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: en.loadCurrentVersion }),
    )
    await screen.findByText(`✓ ${en.sectionSaved}`)

    await userEvent.click(back()!)
    await userEvent.click(screen.getByRole('button', { name: 'from server' }))
    expect((screen.getByRole('textbox', { name: en.termLabel }) as HTMLInputElement).value).toBe('from server')
  })
})

describe('TerminologyView domain actions and late answers', () => {
  const privateA: Domain = { id: 2, name: 'Private A', description: '', is_global: false }
  const privateB: Domain = { id: 3, name: 'Private B', description: '', is_global: false }
  const added: Domain = { id: 4, name: 'Fresh', description: '', is_global: false }
  const rowOf = (name: string) =>
    screen.getAllByText(name).find((el) => el.closest('.domain-row'))!.closest('.domain-row') as HTMLElement
  const back = () => screen.queryByRole('button', { name: `← ${privateA.name}` })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const lists = () => {
    vi.mocked(getConcepts).mockImplementation(async (domainId: number) =>
      domainId === privateA.id ? [conceptOf(201, 'alpha', [2])] : [conceptOf(202, 'beta', [3])],
    )
  }

  beforeEach(() => {
    useStore.setState({
      domains: [privateA, privateB],
      user: user({ policy: { llm: { tiers: null, providers: null, models: null }, features: ['custom_domains'] } }),
    })
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB])
    lists()
  })

  async function deleteDomainVia(name: string) {
    await userEvent.click(within(rowOf(name)).getByTitle(en.deleteDomainTitle))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.deleteDomainTitle }))
  }

  it('selects the next domain after deleting the selected first one', async () => {
    let deleted = false
    vi.mocked(getConcepts).mockImplementation(async (domainId: number) => {
      if (domainId !== privateA.id) return [conceptOf(202, 'beta', [3])]
      if (deleted) throw new HttpError(404, 'GET failed')
      return [conceptOf(201, 'alpha', [2])]
    })
    let answerRefresh!: (domains: Domain[]) => void
    vi.mocked(deleteDomain).mockImplementation(async () => {
      deleted = true
      vi.mocked(getDomains).mockReturnValue(new Promise<Domain[]>((resolve) => (answerRefresh = resolve)))
    })
    render(<TerminologyView />)
    await screen.findByRole('button', { name: 'alpha' })
    await deleteDomainVia('Private A')
    await waitFor(() => expect(answerRefresh).toBeDefined())
    await tick()
    answerRefresh([privateB])

    await screen.findByRole('button', { name: 'beta' })
    expect(rowOf('Private B').classList.contains('selected')).toBe(true)
    expect(vi.mocked(getConcepts).mock.calls.filter(([id]) => id === privateA.id)).toHaveLength(2)
  })

  it('selects the first remaining domain when the active one vanishes from the list', async () => {
    render(<TerminologyView />)
    await screen.findByRole('button', { name: 'alpha' })
    act(() => useStore.getState().setDomains([privateB]))
    await screen.findByRole('button', { name: 'beta' })
    expect(rowOf('Private B').classList.contains('selected')).toBe(true)
  })

  it('does not leave a failed list fetch unhandled', async () => {
    vi.mocked(getConcepts).mockRejectedValue(new HttpError(500, 'GET failed'))
    render(<TerminologyView />)
    await waitFor(() => expect(getConcepts).toHaveBeenCalled())
    await tick()
  })

  it('asks about the domain clicked last when the count answers arrive in reverse order', async () => {
    render(<TerminologyView />)
    await screen.findByRole('button', { name: 'alpha' })
    const counts: Partial<Record<number, (concepts: Concept[]) => void>> = {}
    vi.mocked(getConcepts).mockImplementation(
      (domainId: number) => new Promise<Concept[]>((resolve) => (counts[domainId] = resolve)),
    )
    vi.mocked(deleteDomain).mockResolvedValue(undefined)
    await userEvent.click(within(rowOf('Private A')).getByTitle(en.deleteDomainTitle))
    await userEvent.click(within(rowOf('Private B')).getByTitle(en.deleteDomainTitle))

    counts[privateB.id]!([conceptOf(202, 'beta', [3])])
    within(await screen.findByRole('dialog')).getByText(en.deleteDomainConfirm('Private B', 1))
    counts[privateA.id]!([])
    await tick()
    const dialog = screen.getByRole('dialog')
    within(dialog).getByText(en.deleteDomainConfirm('Private B', 1))
    await userEvent.click(within(dialog).getByRole('button', { name: en.deleteDomainTitle }))
    await waitFor(() => expect(deleteDomain).toHaveBeenCalledWith(privateB.id))
    expect(deleteDomain).not.toHaveBeenCalledWith(privateA.id)
  })

  it('asks nothing when the domain has left the list before its count answers', async () => {
    render(<TerminologyView />)
    await screen.findByRole('button', { name: 'alpha' })
    let answer!: (concepts: Concept[]) => void
    vi.mocked(getConcepts).mockImplementation(() => new Promise<Concept[]>((resolve) => (answer = resolve)))
    await userEvent.click(within(rowOf('Private B')).getByTitle(en.deleteDomainTitle))
    act(() => useStore.getState().setDomains([privateA]))
    answer([])
    await tick()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes a clean entry before its domain is deleted', async () => {
    vi.mocked(deleteDomain).mockReturnValue(new Promise<void>(() => {}))
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await deleteDomainVia('Private A')
    expect(deleteDomain).toHaveBeenCalledWith(privateA.id)
    expect(back()).toBeNull()
  })

  it('keeps text typed into the new-domain field while the domain was created', async () => {
    let answerCreate!: (domain: Domain) => void
    vi.mocked(createDomain).mockReturnValue(new Promise<Domain>((resolve) => (answerCreate = resolve)))
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB, added])
    render(<TerminologyView />)
    const field = screen.getByPlaceholderText(en.newDomainPlaceholder) as HTMLInputElement
    await userEvent.type(field, 'Fresh')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    await userEvent.type(field, ' more')
    answerCreate(added)
    await waitFor(() => expect(getConcepts).toHaveBeenCalledWith(added.id))
    expect(field.value).toBe('Fresh more')
  })

  it('clears the new-domain field when it still holds the name sent', async () => {
    vi.mocked(createDomain).mockResolvedValue(added)
    vi.mocked(getDomains).mockResolvedValue([privateA, privateB, added])
    render(<TerminologyView />)
    const field = screen.getByPlaceholderText(en.newDomainPlaceholder) as HTMLInputElement
    await userEvent.type(field, 'Fresh')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    await waitFor(() => expect(field.value).toBe(''))
  })

  it('sends one create when Add is clicked twice while it is pending', async () => {
    vi.mocked(createDomain).mockReturnValue(new Promise<Domain>(() => {}))
    render(<TerminologyView />)
    await userEvent.type(screen.getByPlaceholderText(en.newDomainPlaceholder), 'Fresh')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    expect(createDomain).toHaveBeenCalledTimes(1)
  })

  it('accepts another Add once the first create has answered', async () => {
    vi.mocked(createDomain).mockResolvedValue(added)
    render(<TerminologyView />)
    const field = screen.getByPlaceholderText(en.newDomainPlaceholder)
    await userEvent.type(field, 'Fresh')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    await waitFor(() => expect(createDomain).toHaveBeenCalledTimes(1))
    await tick()
    await userEvent.clear(field)
    await userEvent.type(field, 'Second')
    await userEvent.click(screen.getByRole('button', { name: en.add }))
    await waitFor(() => expect(createDomain).toHaveBeenCalledWith('Second'))
  })

  it('applies only the latest domain list answer', async () => {
    const answers: ((domains: Domain[]) => void)[] = []
    vi.mocked(getDomains).mockImplementation(() => new Promise<Domain[]>((resolve) => answers.push(resolve)))
    vi.mocked(updateDomain).mockResolvedValue({ ...privateA, name: 'Renamed' })
    render(<TerminologyView />)
    await userEvent.click(within(rowOf('Private A')).getByTitle(en.renameDomainTitle))
    const input = screen.getByDisplayValue('Private A')
    await userEvent.clear(input)
    await userEvent.type(input, 'Renamed{Enter}')
    await waitFor(() => expect(answers).toHaveLength(2))

    answers[1]([{ ...privateA, name: 'Renamed' }, privateB])
    await tick()
    answers[0]([privateA, privateB])
    await tick()
    expect(useStore.getState().domains.map((d) => d.name)).toEqual(['Renamed', 'Private B'])
  })

  it('closes an entry reopened in the domain the concept was removed from', async () => {
    let removed = false
    vi.mocked(getConcepts).mockImplementation(async (domainId: number) =>
      domainId === privateA.id
        ? removed
          ? []
          : [conceptOf(201, 'alpha', [2, 9])]
        : [conceptOf(202, 'beta', [3])],
    )
    let resolveRemove!: () => void
    vi.mocked(removeConceptFromDomain).mockReturnValue(new Promise<void>((resolve) => (resolveRemove = resolve)))
    render(<TerminologyView />)
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    await userEvent.click(screen.getByRole('button', { name: en.removeFromDomain }))
    await userEvent.click(rowOf('Private B'))
    await screen.findByRole('button', { name: 'beta' })
    await userEvent.click(rowOf('Private A'))
    await userEvent.click(await screen.findByRole('button', { name: 'alpha' }))
    expect(back()).not.toBeNull()

    removed = true
    resolveRemove()
    await waitFor(() => expect(back()).toBeNull())
    await tick()
    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull()
  })
})

describe('TerminologyView refreshDomains generation guard', () => {
  it('discards a refreshDomains fetch that resolves after a session turnover', async () => {
    let resolveFetch!: (domains: Domain[]) => void
    vi.mocked(getDomains).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )
    render(<TerminologyView />) // mount fires refreshDomains()
    await waitFor(() => expect(getDomains).toHaveBeenCalled())
    logout() // session ends while it is in flight; store's domains reset to []
    resolveFetch([{ id: 9, name: 'Foreign', description: '', is_global: false }])
    // Drain the .then chain before asserting — see App.domains-guard.test.tsx
    // for why a waitFor here would pass before the stale write even lands.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().domains).toEqual([]) // nothing landed
  })
})

describe('TerminologyView refreshDomains re-fires on same-user re-login (Copilot round-9 U2)', () => {
  it('issues and applies a replacement domains fetch after the password-change silent re-login, while the stale pre-login fetch stays discarded', async () => {
    let resolveFirst!: (domains: Domain[]) => void
    const firstFetch = new Promise<Domain[]>((resolve) => {
      resolveFirst = resolve
    })
    let resolveSecond!: (domains: Domain[]) => void
    const secondFetch = new Promise<Domain[]>((resolve) => {
      resolveSecond = resolve
    })
    let getDomainsCalls = 0
    vi.mocked(getDomains).mockImplementation(() => {
      getDomainsCalls += 1
      return getDomainsCalls === 1 ? firstFetch : secondFetch
    })
    // login() always returns a fresh `user` object (see auth/session.ts) —
    // a brand-new object literal here mirrors that, even though every field
    // is identical to the pre-login user (same-user re-login).
    vi.mocked(postLogin).mockResolvedValue({
      token: 'new-token',
      refresh_token: null,
      expires_at: null,
      user: user({ is_admin: false }),
    })

    render(<TerminologyView />) // mount fires the first (pre-login) refreshDomains()
    await waitFor(() => expect(getDomainsCalls).toBe(1))

    // The password-change flow (auth/AccountMenu.tsx handleSubmit) silently
    // re-authenticates the SAME user via login(email, newPassword) while
    // TerminologyView stays mounted — authStatus never leaves
    // 'authenticated', so LoginGate does not unmount/remount it.
    const reauthenticated = await login('ada@example.com', 'new-password-123')
    expect(reauthenticated).toBe(true)

    // A replacement fetch must be issued for the new session.
    await waitFor(() => expect(getDomainsCalls).toBe(2))

    // The pre-login fetch, still pending, must stay discarded when it lands.
    resolveFirst([{ id: 9, name: 'Foreign', description: '', is_global: false }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().domains).toEqual([globalDomain, privateDomain])

    // The replacement fetch's result IS applied — the domain picker must
    // not stay stuck on stale data for the rest of the session.
    const freshDomain: Domain = { id: 3, name: 'Fresh', description: '', is_global: true }
    resolveSecond([freshDomain])
    await waitFor(() => expect(useStore.getState().domains).toEqual([freshDomain]))
  })
})
