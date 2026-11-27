// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type { Concept, ConceptTerm, Domain, Language, LanguageSection, TransferOutcome } from '../types'
import { ConceptEntry } from './ConceptEntry'
import { TerminologyView } from './TerminologyView'

const docs: Domain = { id: 2, name: 'Product docs', description: '', is_global: false }
const support: Domain = { id: 3, name: 'Support', description: '', is_global: false }
const legal: Domain = { id: 4, name: 'Legal', description: '', is_global: false }
const builtIn: Domain = { id: 1, name: 'Built-in', description: '', is_global: true }
const DOMAINS = [builtIn, docs, support, legal]

function term(id: number, text: string, over: Partial<ConceptTerm> = {}): ConceptTerm {
  return {
    id,
    uid: `t${id}`,
    text,
    usage_status: 'admitted',
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
    ...over,
  }
}

function section(
  id: number,
  language: Language,
  terms: ConceptTerm[],
  over: Partial<LanguageSection> = {},
): LanguageSection {
  return {
    id,
    language,
    definition: '',
    revision: 1,
    created_at: null,
    created_by: null,
    modified_at: null,
    modified_by: null,
    terms,
    ...over,
  }
}

const DE = section(
  70,
  'de',
  [
    term(701, 'Anmeldung', { usage_status: 'preferred' }),
    term(702, 'Login', { usage_status: 'deprecated' }),
  ],
  { revision: 2 },
)
const EN = section(71, 'en', [term(711, 'sign-in', { usage_status: 'preferred' })], { revision: 5 })

function conceptOf(over: Partial<Concept> = {}): Concept {
  return {
    id: 7,
    uid: 'c7',
    domain_ids: [2],
    is_global: false,
    sections: [DE, EN],
    revision: 3,
    created_at: null,
    created_by: null,
    modified_at: null,
    modified_by: null,
    ...over,
  }
}

let fetchMock: MockInstance<typeof fetch>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function answer(...responses: Response[]) {
  for (const response of responses) fetchMock.mockResolvedValueOnce(response)
}

function pending(): (response: Response) => void {
  let resolve!: (response: Response) => void
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((r) => {
      resolve = r
    }),
  )
  return resolve
}

interface Sent {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

function requests(): Sent[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    method: init?.method ?? 'GET',
    path: new URL(String(url)).pathname,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  }))
}

function writes(): Sent[] {
  return requests().filter((r) => r.method !== 'GET')
}

const CANDIDATE = conceptOf({
  id: 8,
  uid: 'c8',
  revision: 1,
  sections: [section(80, 'de', [term(801, 'Konto', { usage_status: 'preferred' })])],
})

function renderEntry(props: Partial<Parameters<typeof ConceptEntry>[0]> = {}) {
  const handlers = {
    onBack: vi.fn(),
    onSaved: vi.fn(),
    onGone: vi.fn(),
    onUnsavedChange: vi.fn(),
    onTransferred: vi.fn(),
  }
  render(
    <ConceptEntry
      domain={docs}
      domains={DOMAINS}
      concept={conceptOf()}
      newLanguage="de"
      readOnly={false}
      candidates={[CANDIDATE]}
      canCreate
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

const region = (name: string) => screen.getByRole('region', { name })
const deSection = () => region('Deutsch')
const enSection = () => region('English')
const button = (name: string, scope: HTMLElement = document.body) =>
  within(scope).getByRole('button', { name }) as HTMLButtonElement
const termTexts = (scope: HTMLElement) =>
  within(scope).getAllByRole('textbox', { name: en.termLabel }) as HTMLInputElement[]
const definition = (scope: HTMLElement) =>
  within(scope).getByRole('textbox', { name: en.definitionLabel }) as HTMLTextAreaElement
const newTitle = () => screen.queryByRole('heading', { name: `← ${docs.name} / ${en.newConceptTitle}` })
const reason = () => screen.getByRole('textbox', { name: en.changeReason }) as HTMLInputElement

async function replace(user: ReturnType<typeof userEvent.setup>, input: HTMLElement, text: string) {
  await user.clear(input)
  if (text) await user.type(input, text)
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch')
  useStore.setState({
    uiLocale: 'en',
    languages: FALLBACK_LANGUAGES,
    domains: DOMAINS,
    token: 'token',
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ConceptEntry saving one language', () => {
  it('sends only that section with its id and version number and keeps the other edit unsaved', async () => {
    const user = userEvent.setup()
    renderEntry()
    await replace(user, termTexts(deSection())[1], 'Log-in')
    await user.type(definition(enSection()), 'The step of proving who you are.')

    const savedDe = section(70, 'de', [DE.terms[0], term(702, 'Log-in', { usage_status: 'deprecated', revision: 2 })], {
      revision: 3,
    })
    answer(json(200, conceptOf({ sections: [savedDe, EN], revision: 3 })))
    await user.click(button(en.saveLanguage('Deutsch')))

    await waitFor(() => expect(writes()).toHaveLength(1))
    const [sent] = writes()
    expect(sent.method).toBe('PUT')
    expect(sent.path).toBe('/api/concepts/7/languages/de')
    expect(sent.body).toMatchObject({ id: 70, revision: 2 })
    expect(sent.body).not.toHaveProperty('language')
    expect((sent.body!.terms as { text: string }[]).map((t) => t.text)).toEqual(['Anmeldung', 'Log-in'])
    expect(JSON.stringify(sent.body)).not.toContain('sign-in')

    await within(deSection()).findByText(`✓ ${en.sectionSaved}`)
    expect(definition(enSection()).value).toBe('The step of proving who you are.')
    within(enSection()).getByText(`● ${en.unsavedChanges(1)}`)
  })
})

describe('ConceptEntry "Save all"', () => {
  it('sends exactly the two edited sections and no links when the links are untouched', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    await user.type(definition(enSection()), 'Step')
    answer(json(200, conceptOf({ revision: 4 })))
    await user.click(button(en.saveAll))

    await waitFor(() => expect(writes()).toHaveLength(1))
    const [sent] = writes()
    expect(sent.method).toBe('PUT')
    expect(sent.path).toBe('/api/concepts/7')
    expect((sent.body!.sections as { language: string }[]).map((s) => s.language)).toEqual(['de', 'en'])
    expect(sent.body).not.toHaveProperty('domain_ids')
    expect(sent.body).not.toHaveProperty('revision')
  })

  it('sends the domain ids and the revision when a link was edited', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.selectOptions(screen.getByRole('combobox', { name: en.addConceptDomain }), 'Support')
    answer(json(200, conceptOf({ domain_ids: [2, 3], revision: 4 })))
    await user.click(button(en.saveAll))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body).toEqual({ sections: [], domain_ids: [2, 3], revision: 3 })
  })

  it('treats the links as saved afterwards and sends the new revision with the next link change', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.selectOptions(screen.getByRole('combobox', { name: en.addConceptDomain }), 'Support')
    answer(json(200, conceptOf({ domain_ids: [2, 3], revision: 4 })))
    await user.click(button(en.saveAll))
    await waitFor(() => expect(button(en.saveAll).disabled).toBe(true))
    expect(screen.queryByText(en.unsavedList(en.unsavedLinks))).toBeNull()

    await user.selectOptions(screen.getByRole('combobox', { name: en.addConceptDomain }), 'Legal')
    answer(json(200, conceptOf({ domain_ids: [2, 3, 4], revision: 5 })))
    await user.click(button(en.saveAll))
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes()[1].body).toMatchObject({ domain_ids: [2, 3, 4], revision: 4 })
  })
})

describe('ConceptEntry checks before sending', () => {
  it('disables both save buttons while nothing is unsaved', () => {
    renderEntry()
    expect(button(en.saveLanguage('Deutsch')).disabled).toBe(true)
    expect(button(en.saveLanguage('English')).disabled).toBe(true)
    expect(button(en.saveAll).disabled).toBe(true)
  })

  it('disables the section save and shows the reason for an empty term text', async () => {
    const user = userEvent.setup()
    renderEntry()
    await replace(user, termTexts(deSection())[1], '')
    within(deSection()).getByText(en.problemEmptyText)
    expect(button(en.saveLanguage('Deutsch')).disabled).toBe(true)
    expect(button(en.saveAll).disabled).toBe(true)
  })

  it('disables the section save and shows the reason for the same text twice', async () => {
    const user = userEvent.setup()
    renderEntry()
    await replace(user, termTexts(deSection())[1], 'Anmeldung')
    within(deSection()).getByText(en.problemDuplicateText)
    expect(button(en.saveLanguage('Deutsch')).disabled).toBe(true)
    expect(button(en.saveAll).disabled).toBe(true)
  })

  it('disables the section save and shows the reason for a second active preferred term', async () => {
    const user = userEvent.setup()
    renderEntry()
    const statuses = within(deSection()).getAllByRole('combobox', { name: en.usageStatusLabel })
    await user.selectOptions(statuses[1], 'preferred')
    within(deSection()).getByText(en.problemSecondPreferred)
    expect(button(en.saveLanguage('Deutsch')).disabled).toBe(true)
    expect(button(en.saveAll).disabled).toBe(true)
  })

  it('disables the section save and shows the reason for a language without terms', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.click(within(enSection()).getByRole('button', { name: en.removeTermNamed('sign-in') }))
    within(enSection()).getByText(en.problemNoTerms)
    expect(button(en.saveLanguage('English')).disabled).toBe(true)
    expect(button(en.saveAll).disabled).toBe(true)
  })

  it('keeps the other section saveable on an existing concept', async () => {
    const user = userEvent.setup()
    renderEntry()
    await replace(user, termTexts(deSection())[1], '')
    await user.type(definition(enSection()), 'Step')
    expect(button(en.saveLanguage('English')).disabled).toBe(false)
  })
})

describe('ConceptEntry for a new concept', () => {
  it('sends one POST with every section that has terms, then continues with PUT', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderEntry({ concept: null, newLanguage: 'de' })
    expect(newTitle()).not.toBeNull()
    await user.type(termTexts(deSection())[0], 'Anmeldung')
    await user.selectOptions(screen.getByRole('combobox', { name: en.addLanguage }), 'English')
    await user.type(termTexts(enSection())[0], 'sign-in')

    const created = conceptOf({
      id: 9,
      revision: 1,
      sections: [
        section(90, 'de', [term(901, 'Anmeldung', { usage_status: 'preferred' })]),
        section(91, 'en', [term(911, 'sign-in', { usage_status: 'preferred' })]),
      ],
    })
    answer(json(201, created))
    await user.click(button(en.saveLanguage('Deutsch')))

    await waitFor(() => expect(writes()).toHaveLength(1))
    const [post] = writes()
    expect(post.method).toBe('POST')
    expect(post.path).toBe('/api/domains/2/concepts')
    const sections = post.body!.sections as { language: string; id?: number; terms: { text: string }[] }[]
    expect(sections.map((s) => s.language)).toEqual(['de', 'en'])
    expect(sections.map((s) => s.terms.map((t) => t.text))).toEqual([['Anmeldung'], ['sign-in']])
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created))
    expect(newTitle()).toBeNull()

    await user.type(definition(deSection()), 'Vorgang')
    answer(json(200, created))
    await user.click(button(en.saveLanguage('Deutsch')))
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes()[1]).toMatchObject({ method: 'PUT', path: '/api/concepts/9/languages/de' })
    expect(writes()[1].body).toMatchObject({ id: 90, revision: 1, definition: 'Vorgang' })
  })

  it('disables both save buttons while a second language still has an empty term', async () => {
    const user = userEvent.setup()
    renderEntry({ concept: null, newLanguage: 'de' })
    await user.type(termTexts(deSection())[0], 'Anmeldung')
    await user.selectOptions(screen.getByRole('combobox', { name: en.addLanguage }), 'English')
    await user.type(definition(enSection()), 'Step')

    expect(button(en.saveLanguage('Deutsch')).disabled).toBe(true)
    expect(button(en.saveLanguage('English')).disabled).toBe(true)
    expect(button(en.saveAll).disabled).toBe(true)
  })

  it('disables "Save all" while only the links are edited', async () => {
    const user = userEvent.setup()
    renderEntry({ concept: null, newLanguage: 'de' })
    await user.selectOptions(screen.getByRole('combobox', { name: en.addConceptDomain }), 'Support')
    screen.getByText(en.unsavedList(en.unsavedLinks))
    expect(button(en.saveAll).disabled).toBe(true)
  })

  it('leaves without asking on "Discard all" and on "Discard" of its last section', async () => {
    const user = userEvent.setup()
    const { onBack } = renderEntry({ concept: null, newLanguage: 'de' })
    await user.type(termTexts(deSection())[0], 'Anmeldung')
    await user.click(button(en.discardAll))
    expect(onBack).toHaveBeenCalledTimes(1)
    await user.click(button(en.discard, deSection()))
    expect(onBack).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('ConceptEntry inside TerminologyView', () => {
  const me: MeResponse = {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy: { llm: { tiers: null, providers: null, models: null }, features: ['custom_domains'] },
    usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
    limits: { max_document_chars: 200000, max_llm_document_chars: 200000, concurrent_llm_runs: 5 },
    allow_additional_admins: false,
    db_backend: 'sqlite',
  }

  it('keeps a link added before the first save unsaved and sends it with the new revision', async () => {
    const created = conceptOf({
      id: 9,
      revision: 1,
      sections: [section(90, 'en', [term(901, 'widget', { usage_status: 'preferred' })])],
    })
    fetchMock.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname
      const method = init?.method ?? 'GET'
      if (method === 'GET' && path === '/api/domains') return json(200, [docs, support])
      if (method === 'GET' && path === '/api/domains/2/concepts') return json(200, [])
      if (method === 'POST' && path === '/api/domains/2/concepts') return json(201, created)
      if (method === 'PUT' && path === '/api/concepts/9') {
        return json(200, { ...created, domain_ids: [2, 3], revision: 2 })
      }
      return json(404, {})
    })
    useStore.setState({ domains: [docs, support], user: me })
    const user = userEvent.setup()
    render(<TerminologyView />)

    await user.click(await screen.findByRole('button', { name: en.newConcept }))
    await user.type(termTexts(enSection())[0], 'widget')
    await user.selectOptions(screen.getByRole('combobox', { name: en.addConceptDomain }), 'Support')
    await user.click(button(en.saveLanguage('English')))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].method).toBe('POST')
    expect(writes()[0].body).not.toHaveProperty('domain_ids')
    await waitFor(() => expect(newTitle()).toBeNull())
    screen.getByRole('button', { name: en.removeDomainLink('Support') })
    screen.getByText(en.unsavedList(en.unsavedLinks))

    await user.click(button(en.saveAll))
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes()[1]).toMatchObject({ method: 'PUT', path: '/api/concepts/9' })
    expect(writes()[1].body).toMatchObject({ domain_ids: [2, 3], revision: 1 })
  })
})

describe('ConceptEntry while a save is pending', () => {
  it('enables no field and no button, and a second save cannot be sent', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.click(button(en.termDetailsOf('Anmeldung'), deSection()))
    await user.type(definition(deSection()), 'Vorgang')
    await user.type(definition(enSection()), 'Step')
    const resolve = pending()
    await user.click(button(en.saveLanguage('Deutsch')))

    const controls = [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('checkbox'),
    ] as HTMLButtonElement[]
    expect(controls.filter((c) => !c.disabled).map((c) => c.getAttribute('aria-label') ?? c.textContent)).toEqual([])

    await user.click(button(en.saveAll))
    expect(writes()).toHaveLength(1)

    resolve(json(200, conceptOf({ sections: [section(70, 'de', DE.terms, { definition: 'Vorgang', revision: 3 }), EN] })))
    await waitFor(() => expect(button(en.saveAll).disabled).toBe(false))
    expect(writes()).toHaveLength(1)
  })
})

describe('ConceptEntry discard and links', () => {
  it('disables "Discard" for a section without unsaved changes', async () => {
    const user = userEvent.setup()
    renderEntry()
    expect(button(en.discard, deSection()).disabled).toBe(true)
    await user.type(definition(deSection()), 'Vorgang')
    expect(button(en.discard, deSection()).disabled).toBe(false)
    expect(button(en.discard, enSection()).disabled).toBe(true)
    await user.click(button(en.discard, deSection()))
    expect(definition(deSection()).value).toBe('')
  })

  it('offers only the other domains with the concept\'s is_global value', () => {
    renderEntry()
    const select = screen.getByRole('combobox', { name: en.addConceptDomain })
    const offered = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent)
      .slice(1)
    expect(offered).toEqual(['Support', 'Legal'])
  })

  it('"Discard all" returns every section and the links to what was read', async () => {
    const user = userEvent.setup()
    const { onBack } = renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    await user.click(button(en.removeLanguage, enSection()))
    await user.selectOptions(screen.getByRole('combobox', { name: en.addConceptDomain }), 'Support')
    await user.click(button(en.discardAll))
    expect(definition(deSection()).value).toBe('')
    expect(termTexts(enSection()).map((i) => i.value)).toEqual(['sign-in'])
    expect(screen.queryByRole('button', { name: en.removeDomainLink('Support') })).toBeNull()
    expect(button(en.saveAll).disabled).toBe(true)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('lists the concept\'s other domains and removes one from the draft', async () => {
    const user = userEvent.setup()
    renderEntry({ concept: conceptOf({ domain_ids: [2, 3] }) })
    await user.click(button(en.removeDomainLink('Support')))
    screen.getByText(en.unsavedList(en.unsavedLinks))
    answer(json(200, conceptOf({ domain_ids: [2], revision: 4 })))
    await user.click(button(en.saveAll))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body).toMatchObject({ domain_ids: [2], revision: 3 })
  })
})

describe('ConceptEntry languages', () => {
  it('sends a new language without id and version number', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.selectOptions(screen.getByRole('combobox', { name: en.addLanguage }), 'Français')
    await user.type(termTexts(region('Français'))[0], 'connexion')
    answer(json(200, conceptOf()))
    await user.click(button(en.saveLanguage('Français')))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].path).toBe('/api/concepts/7/languages/fr')
    expect(writes()[0].body).not.toHaveProperty('id')
    expect(writes()[0].body).not.toHaveProperty('revision')
  })

  it('offers only the languages the concept does not have', () => {
    renderEntry()
    const options = within(screen.getByRole('combobox', { name: en.addLanguage }))
      .getAllByRole('option')
      .slice(1)
      .map((o) => o.textContent)
    expect(options).toEqual(['Français', 'Español', 'Italiano', '日本語', '中文'])
  })

  it('sends a removed language with an empty term list', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.click(button(en.removeLanguage, enSection()))
    within(enSection()).getByText(en.languageRemovedNote)
    answer(json(200, conceptOf({ sections: [DE] })))
    await user.click(button(en.saveLanguage('English')))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].path).toBe('/api/concepts/7/languages/en')
    expect(writes()[0].body).toMatchObject({ id: 71, revision: 5, terms: [] })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'English' })).toBeNull())
  })

  it('restores a removed language on "Discard"', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.click(button(en.removeLanguage, enSection()))
    await user.click(button(en.discard, enSection()))
    expect(termTexts(enSection()).map((i) => i.value)).toEqual(['sign-in'])
    expect(within(enSection()).queryByText(en.languageRemovedNote)).toBeNull()
  })

  it('drops a language that was never saved on "Remove language"', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.selectOptions(screen.getByRole('combobox', { name: en.addLanguage }), 'Français')
    await user.click(button(en.removeLanguage, region('Français')))
    expect(screen.queryByRole('region', { name: 'Français' })).toBeNull()
  })

  it('shows the base-form hint in each section', () => {
    renderEntry()
    within(deSection()).getByText(en.baseFormHint)
    within(enSection()).getByText(en.baseFormHint)
  })
})

describe('ConceptEntry reason field', () => {
  it('is sent as comment once and is empty after a successful save', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    await user.type(reason(), 'typo')
    answer(json(200, conceptOf({ sections: [section(70, 'de', DE.terms, { definition: 'Vorgang', revision: 3 }), EN] })))
    await user.click(button(en.saveLanguage('Deutsch')))
    await waitFor(() => expect(reason().value).toBe(''))
    expect(writes()[0].body).toMatchObject({ comment: 'typo' })

    await user.type(definition(enSection()), 'Step')
    answer(json(200, conceptOf()))
    await user.click(button(en.saveAll))
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes()[1].body).not.toHaveProperty('comment')
  })

  it('is still filled after a failed save', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    await user.type(reason(), 'typo')
    answer(json(500, { detail: 'boom' }))
    await user.click(button(en.saveAll))
    await screen.findByText(en.changeFailed('boom'))
    expect(reason().value).toBe('typo')
  })
})

describe('ConceptEntry failed saves', () => {
  it('keeps every edit and shows the error only next to the button used', async () => {
    const user = userEvent.setup()
    renderEntry()
    await replace(user, termTexts(deSection())[1], 'Log-in')
    await user.type(definition(enSection()), 'Step')
    answer(json(500, { detail: 'boom' }))
    await user.click(button(en.saveLanguage('Deutsch')))

    const errors = await screen.findAllByText(en.changeFailed('boom'))
    expect(errors).toHaveLength(1)
    expect(deSection().contains(errors[0])).toBe(true)
    expect(termTexts(deSection())[1].value).toBe('Log-in')
    expect(definition(enSection()).value).toBe('Step')
    within(deSection()).getByText(`● ${en.unsavedChanges(1)}`)
  })

  it('shows a failed "Save all" at "Save all" and not in a section', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    answer(json(500, {}))
    await user.click(button(en.saveAll))
    const errors = await screen.findAllByText(en.changeFailed('PUT /api/concepts/7 failed: 500'))
    expect(errors).toHaveLength(1)
    expect(deSection().contains(errors[0])).toBe(false)
    expect(enSection().contains(errors[0])).toBe(false)
  })

  it.each([
    ['second_preferred', en.problemSecondPreferred],
    ['duplicate_text', en.problemDuplicateText],
  ])('translates a save refused with %s', async (code, text) => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    answer(json(409, { detail: { code, message: 'store text' } }))
    await user.click(button(en.saveLanguage('Deutsch')))
    await within(deSection()).findByText(text)
    expect(screen.queryByText('store text', { exact: false })).toBeNull()
  })

  it('names the changed part of a refused out-of-date save and offers to load it', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    answer(json(409, { detail: { code: 'conflict', message: 'out of date', part: 'de' } }))
    await user.click(button(en.saveLanguage('Deutsch')))
    await within(deSection()).findByText(en.conceptConflict('Deutsch'))
    within(deSection()).getByRole('button', { name: en.loadCurrentVersion })
    expect(definition(deSection()).value).toBe('Vorgang')
  })
})

describe('ConceptEntry after a save refused as out of date', () => {
  const conflict = (part: string) =>
    json(409, { detail: { code: 'conflict', message: 'out of date', part } })
  const gets = () => requests().filter((r) => r.method === 'GET')
  const DE_SERVER = section(
    70,
    'de',
    [term(701, 'Anmeldung', { usage_status: 'preferred' }), term(703, 'Einloggen', { usage_status: 'deprecated' })],
    { definition: 'Vom Server', revision: 3 },
  )

  async function refusedGermanSave(user: ReturnType<typeof userEvent.setup>) {
    const handlers = renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    await user.type(definition(enSection()), 'Step')
    answer(conflict('de'))
    await user.click(button(en.saveLanguage('Deutsch')))
    await within(deSection()).findByText(en.conceptConflict('Deutsch'))
    return handlers
  }

  it('loads the changed language after asking and leaves the other section alone', async () => {
    const user = userEvent.setup()
    const { onSaved } = await refusedGermanSave(user)
    expect(definition(deSection()).value).toBe('Vorgang')

    await user.click(button(en.loadCurrentVersion, deSection()))
    const dialog = await screen.findByRole('dialog')
    within(dialog).getByText(en.reloadLanguageConfirm('Deutsch'))
    expect(gets()).toEqual([])

    const server = conceptOf({ sections: [DE_SERVER, EN], revision: 4 })
    answer(json(200, server))
    await user.click(within(dialog).getByRole('button', { name: en.loadCurrentVersion }))

    await waitFor(() => expect(definition(deSection()).value).toBe('Vom Server'))
    expect(onSaved).toHaveBeenCalledWith(server)
    expect(gets().map((r) => r.path)).toEqual(['/api/concepts/7'])
    expect(termTexts(deSection()).map((i) => i.value)).toEqual(['Anmeldung', 'Einloggen'])
    within(deSection()).getByText(`✓ ${en.sectionSaved}`)
    expect(screen.queryByText(en.conceptConflict('Deutsch'))).toBeNull()
    expect(definition(enSection()).value).toBe('Step')
    within(enSection()).getByText(`● ${en.unsavedChanges(1)}`)
  })

  it('changes nothing when the question is cancelled', async () => {
    const user = userEvent.setup()
    await refusedGermanSave(user)
    await user.click(button(en.loadCurrentVersion, deSection()))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.dialogCancel }))

    expect(gets()).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(definition(deSection()).value).toBe('Vorgang')
    within(deSection()).getByText(en.conceptConflict('Deutsch'))
  })

  it('disables the entry while the current version is loading', async () => {
    const user = userEvent.setup()
    await refusedGermanSave(user)
    await user.click(button(en.loadCurrentVersion, deSection()))
    const resolve = pending()
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.loadCurrentVersion }))

    expect(definition(enSection()).disabled).toBe(true)
    expect(button(en.loadCurrentVersion, deSection()).disabled).toBe(true)
    expect(button(`← ${docs.name}`).disabled).toBe(true)

    resolve(json(200, conceptOf({ sections: [DE_SERVER, EN], revision: 4 })))
    await waitFor(() => expect(definition(enSection()).disabled).toBe(false))
  })

  it('shows a failed load next to the same button and changes nothing else', async () => {
    const user = userEvent.setup()
    await refusedGermanSave(user)
    await user.click(button(en.loadCurrentVersion, deSection()))
    answer(json(404, { detail: 'Concept not found' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.loadCurrentVersion }))

    await within(deSection()).findByText(en.changeFailed('Concept not found'))
    expect(screen.getAllByText(en.changeFailed('Concept not found'))).toHaveLength(1)
    within(deSection()).getByRole('button', { name: en.loadCurrentVersion })
    expect(definition(deSection()).value).toBe('Vorgang')
    expect(definition(enSection()).value).toBe('Step')
  })

  it('names the domains at "Save all" and loads only the links', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.selectOptions(screen.getByRole('combobox', { name: en.addConceptDomain }), 'Support')
    await user.type(definition(deSection()), 'Vorgang')
    answer(conflict('links'))
    await user.click(button(en.saveAll))

    const message = await screen.findByText(en.conceptConflictLinks)
    expect(deSection().contains(message)).toBe(false)
    expect(enSection().contains(message)).toBe(false)

    await user.click(button(en.loadCurrentVersion))
    const dialog = await screen.findByRole('dialog')
    within(dialog).getByText(en.reloadLinksConfirm)
    answer(json(200, conceptOf({ domain_ids: [2, 4], revision: 5, sections: [DE_SERVER, EN] })))
    await user.click(within(dialog).getByRole('button', { name: en.loadCurrentVersion }))

    await screen.findByRole('button', { name: en.removeDomainLink('Legal') })
    expect(screen.queryByRole('button', { name: en.removeDomainLink('Support') })).toBeNull()
    expect(definition(deSection()).value).toBe('Vorgang')
    screen.getByText(en.unsavedList('Deutsch'))
    expect(screen.queryByText(en.conceptConflictLinks)).toBeNull()
  })

  it('marks nothing saved and names English when "Save all" is refused for English', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    await user.type(definition(enSection()), 'Step')
    answer(conflict('en'))
    await user.click(button(en.saveAll))

    const message = await screen.findByText(en.conceptConflict('English'))
    expect(deSection().contains(message)).toBe(false)
    expect(enSection().contains(message)).toBe(false)
    within(deSection()).getByText(`● ${en.unsavedChanges(1)}`)
    within(enSection()).getByText(`● ${en.unsavedChanges(1)}`)
    expect(screen.queryByText(`✓ ${en.sectionSaved}`)).toBeNull()
  })

  it('clears the message when the same part is then saved', async () => {
    const user = userEvent.setup()
    await refusedGermanSave(user)
    answer(json(200, conceptOf({ sections: [section(70, 'de', DE.terms, { definition: 'Vorgang', revision: 3 }), EN] })))
    await user.click(button(en.saveLanguage('Deutsch')))
    await within(deSection()).findByText(`✓ ${en.sectionSaved}`)
    expect(screen.queryByText(en.conceptConflict('Deutsch'))).toBeNull()
  })
})

describe('ConceptEntry messages of a discarded part', () => {
  const failed = (scope: () => HTMLElement) => within(scope()).findByText(en.changeFailed('boom'))
  const shown = () => screen.queryByText(en.changeFailed('boom'))

  it('shows no old message when a language that failed to save is removed and added again', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.selectOptions(screen.getByRole('combobox', { name: en.addLanguage }), 'Français')
    await user.type(termTexts(region('Français'))[0], 'connexion')
    answer(json(500, { detail: 'boom' }))
    await user.click(button(en.saveLanguage('Français')))
    await failed(() => region('Français'))

    await user.click(button(en.removeLanguage, region('Français')))
    await user.selectOptions(screen.getByRole('combobox', { name: en.addLanguage }), 'Français')
    expect(shown()).toBeNull()
  })

  it('removes the message of a section on "Discard"', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    answer(json(500, { detail: 'boom' }))
    await user.click(button(en.saveLanguage('Deutsch')))
    await failed(deSection)
    await user.click(button(en.discard, deSection()))
    expect(shown()).toBeNull()
  })

  it('removes the message of a saved language on "Remove language"', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    answer(json(500, { detail: 'boom' }))
    await user.click(button(en.saveLanguage('Deutsch')))
    await failed(deSection)
    await user.click(button(en.removeLanguage, deSection()))
    expect(shown()).toBeNull()
  })

  it('removes the message at "Save all" on "Discard all"', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    answer(json(500, { detail: 'boom' }))
    await user.click(button(en.saveAll))
    await screen.findByText(en.changeFailed('boom'))
    await user.click(button(en.discardAll))
    expect(shown()).toBeNull()
  })

  it('keeps the message of another section on "Discard"', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    await user.type(definition(enSection()), 'Step')
    answer(json(500, { detail: 'boom' }))
    await user.click(button(en.saveLanguage('Deutsch')))
    await failed(deSection)
    await user.click(button(en.discard, enSection()))
    within(deSection()).getByText(en.changeFailed('boom'))
  })
})

describe('ConceptEntry way back', () => {
  it('asks first while something is unsaved and goes back only after confirming', async () => {
    const user = userEvent.setup()
    const { onBack } = renderEntry()
    await user.type(definition(deSection()), 'Vorgang')
    await user.click(button(`← ${docs.name}`))
    const dialog = await screen.findByRole('dialog')
    within(dialog).getByText(en.leaveUnsavedConfirm)
    expect(onBack).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: en.dialogCancel }))
    expect(onBack).not.toHaveBeenCalled()
    expect(definition(deSection()).value).toBe('Vorgang')

    await user.click(button(`← ${docs.name}`))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.leaveUnsaved }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('reports unsaved changes as they come and go, and none once it is gone', async () => {
    const user = userEvent.setup()
    const { onUnsavedChange } = renderEntry()
    await user.type(definition(deSection()), 'V')
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true)
    await user.click(button(en.discard, deSection()))
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false)
    await user.type(definition(deSection()), 'V')
    cleanup()
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false)
  })
})

describe('ConceptEntry removal actions', () => {
  it('disables "Remove from this domain" while the concept is in no other domain', () => {
    renderEntry()
    expect(button(en.removeFromDomain).disabled).toBe(true)
  })

  it('disables "Remove from this domain" while anything is unsaved', async () => {
    const user = userEvent.setup()
    renderEntry({ concept: conceptOf({ domain_ids: [2, 3] }) })
    expect(button(en.removeFromDomain).disabled).toBe(false)
    await user.type(definition(deSection()), 'Vorgang')
    expect(button(en.removeFromDomain).disabled).toBe(true)
  })

  it('removes the concept from this domain and reports it gone', async () => {
    const user = userEvent.setup()
    const { onGone } = renderEntry({ concept: conceptOf({ domain_ids: [2, 3] }) })
    answer(new Response(null, { status: 204 }))
    await user.click(button(en.removeFromDomain))
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1))
    expect(onGone).toHaveBeenCalledWith(false)
    expect(writes()).toEqual([{ method: 'DELETE', path: '/api/domains/2/concepts/7', body: undefined }])
  })

  it('asks before deleting the concept', async () => {
    const user = userEvent.setup()
    const { onGone } = renderEntry()
    await user.click(button(en.deleteConcept))
    const dialog = await screen.findByRole('dialog')
    expect(writes()).toEqual([])

    answer(new Response(null, { status: 204 }))
    await user.click(within(dialog).getByRole('button', { name: en.deleteConcept }))
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1))
    expect(onGone).toHaveBeenCalledWith(true)
    expect(writes()).toEqual([{ method: 'DELETE', path: '/api/concepts/7', body: undefined }])
  })

  it('does not delete when the question is cancelled', async () => {
    const user = userEvent.setup()
    const { onGone } = renderEntry()
    await user.click(button(en.deleteConcept))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.dialogCancel }))
    expect(writes()).toEqual([])
    expect(onGone).not.toHaveBeenCalled()
  })

  it('offers neither action for a new concept', () => {
    renderEntry({ concept: null })
    expect(screen.queryByRole('button', { name: en.removeFromDomain })).toBeNull()
    expect(screen.queryByRole('button', { name: en.deleteConcept })).toBeNull()
  })
})

describe('ConceptEntry read-only', () => {
  it('has no enabled field and no save, discard, add, remove or delete control', async () => {
    const user = userEvent.setup()
    renderEntry({ readOnly: true, concept: conceptOf({ domain_ids: [2, 3] }) })
    await user.click(button(en.termDetailsOf('Anmeldung'), deSection()))

    const fields = [
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('checkbox'),
    ] as HTMLInputElement[]
    expect(fields.length).toBeGreaterThan(0)
    expect(fields.filter((f) => !f.disabled)).toEqual([])
    for (const name of [
      en.saveLanguage('Deutsch'),
      en.discard,
      en.saveAll,
      en.discardAll,
      en.addTerm,
      en.removeTerm,
      en.removeTermNamed('Anmeldung'),
      en.removeLanguage,
      en.removeFromDomain,
      en.deleteConcept,
      en.removeDomainLink('Support'),
    ]) {
      expect(screen.queryByRole('button', { name }), name).toBeNull()
    }
    expect(screen.queryByRole('combobox', { name: en.addLanguage })).toBeNull()
    expect(screen.queryByRole('combobox', { name: en.addConceptDomain })).toBeNull()
    screen.getByText('Support')
  })
})

describe('ConceptEntry term details', () => {
  it('open and close, and an edit there marks the section unsaved', async () => {
    const user = userEvent.setup()
    renderEntry()
    const toggle = button(en.termDetailsOf('Login'), deSection())
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(deSection()).queryByRole('textbox', { name: en.contextLabel })).toBeNull()

    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await user.type(within(deSection()).getByRole('textbox', { name: en.contextLabel }), 'Nach dem Login')
    within(deSection()).getByText(`● ${en.unsavedChanges(1)}`)
    await user.click(within(deSection()).getByRole('checkbox', { name: en.matchCaseLabel }))
    within(deSection()).getByText(`● ${en.unsavedChanges(2)}`)

    await user.click(toggle)
    expect(within(deSection()).queryByRole('textbox', { name: en.contextLabel })).toBeNull()
  })

  it('adds and removes a term', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.click(button(en.addTerm, enSection()))
    expect(termTexts(enSection())).toHaveLength(2)
    within(enSection()).getByText(`✓ ${en.sectionSaved}`)
    await user.type(termTexts(enSection())[1], 'login')
    within(enSection()).getByText(`● ${en.unsavedChanges(1)}`)
    await user.click(button(en.removeTermNamed('sign-in'), enSection()))
    expect(termTexts(enSection()).map((i) => i.value)).toEqual(['login'])
  })

  it('names the term in the accessible names of its "Details" and remove buttons', async () => {
    const user = userEvent.setup()
    renderEntry()
    const details = button(en.termDetailsOf('sign-in'), enSection())
    expect(details.textContent).toContain(en.termDetails)
    button(en.removeTermNamed('sign-in'), enSection())

    await user.click(button(en.addTerm, enSection()))
    button(en.termDetails, enSection())
    button(en.removeTerm, enSection())
  })
})

describe('ConceptEntry heading', () => {
  it('shows the way back with the domain and the label in the chosen language', async () => {
    const user = userEvent.setup()
    const { onBack } = renderEntry({ newLanguage: 'en' })
    screen.getByRole('heading', { name: `← ${docs.name} / sign-in` })
    await user.click(screen.getByRole('button', { name: `← ${docs.name}` }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('ConceptEntry merge and move', () => {
  const BASIS: TransferOutcome['basis'] = {
    source: { concept_id: 7, revision: 3, sections: [{ id: 70, revision: 2 }, { id: 71, revision: 5 }] },
    target: { concept_id: 8, revision: 1, sections: [{ id: 80, revision: 1 }] },
  }
  const MERGED: TransferOutcome = {
    target: conceptOf({
      id: 8,
      uid: 'c8',
      revision: 2,
      sections: [section(80, 'de', [...CANDIDATE.sections[0].terms, ...DE.terms], { revision: 2 }), EN],
    }),
    source: null,
    moved: [],
    dropped_terms: [],
    dropped_definitions: [],
    removed_languages: [],
    dropped_domains: [],
    added_domains: [],
    basis: BASIS,
  }
  const MOVED: TransferOutcome = {
    ...MERGED,
    target: conceptOf({ id: 8, uid: 'c8', sections: [section(80, 'de', [CANDIDATE.sections[0].terms[0], DE.terms[1]])] }),
    source: conceptOf({ sections: [section(70, 'de', [DE.terms[0]], { revision: 3 }), EN], revision: 4 }),
  }

  const mergeButton = () => screen.queryByRole('button', { name: en.mergeInto }) as HTMLButtonElement | null
  const moveButton = () => screen.queryByRole('button', { name: en.termMove }) as HTMLButtonElement | null
  const runs = () => writes().filter((w) => w.body?.preview !== true)

  function serve(outcome: TransferOutcome) {
    fetchMock.mockImplementation(async () => json(200, outcome))
  }

  async function confirmWith(user: ReturnType<typeof userEvent.setup>, confirmName: string) {
    const dialog = screen.getByRole('dialog')
    await user.click(await within(dialog).findByRole('option', { name: /^Konto/ }))
    const confirm = within(dialog).getByRole('button', { name: confirmName }) as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false))
    await user.click(confirm)
  }

  it('offers neither for a new concept', async () => {
    const user = userEvent.setup()
    renderEntry({ concept: null })
    await user.type(termTexts(deSection())[0], 'Anmeldung')
    await user.click(button(en.termDetailsOf('Anmeldung'), deSection()))
    within(deSection()).getByRole('textbox', { name: en.contextLabel })
    expect(mergeButton()).toBeNull()
    expect(moveButton()).toBeNull()
  })

  it('offers neither for a read-only concept', async () => {
    const user = userEvent.setup()
    renderEntry({ readOnly: true })
    await user.click(button(en.termDetailsOf('Login'), deSection()))
    within(deSection()).getByRole('textbox', { name: en.contextLabel })
    expect(mergeButton()).toBeNull()
    expect(moveButton()).toBeNull()
  })

  it('puts "Merge into…" before "Remove from this domain" and "Move…" into the term details', async () => {
    const user = userEvent.setup()
    renderEntry()
    const header = document.querySelector('.entry-header') as HTMLElement
    expect(within(header).getAllByRole('button').map((b) => b.textContent)).toEqual([
      `← ${docs.name}`,
      en.mergeInto,
      en.removeFromDomain,
      en.deleteConcept,
    ])
    expect(moveButton()).toBeNull()
    await user.click(button(en.termDetailsOf('Login'), deSection()))
    const details = deSection().querySelector('.term-details') as HTMLElement
    within(details).getByRole('button', { name: en.termMove })
  })

  it('disables both while something is unsaved', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.click(button(en.termDetailsOf('Login'), deSection()))
    expect(mergeButton()!.disabled).toBe(false)
    expect(moveButton()!.disabled).toBe(false)

    await user.type(definition(enSection()), 'Step')
    expect(mergeButton()!.disabled).toBe(true)
    expect(moveButton()!.disabled).toBe(true)

    await user.click(button(en.discard, enSection()))
    expect(mergeButton()!.disabled).toBe(false)
    expect(moveButton()!.disabled).toBe(false)
  })

  it('disables both while a request of the entry runs', async () => {
    const user = userEvent.setup()
    renderEntry({ concept: conceptOf({ domain_ids: [2, 3] }) })
    await user.click(button(en.termDetailsOf('Login'), deSection()))
    const resolve = pending()
    await user.click(button(en.removeFromDomain))
    expect(mergeButton()!.disabled).toBe(true)
    expect(moveButton()!.disabled).toBe(true)
    resolve(new Response(null, { status: 204 }))
    await waitFor(() => expect(mergeButton()!.disabled).toBe(false))
  })

  it('disables "Merge into…" without candidates', () => {
    renderEntry({ candidates: [] })
    expect(button(en.mergeInto).disabled).toBe(true)
  })

  it('offers no "Move…" for a term without an id', async () => {
    const user = userEvent.setup()
    renderEntry()
    await user.click(button(en.addTerm, enSection()))
    await user.type(termTexts(enSection())[1], 'login')
    await user.click(button(en.termDetailsOf('login'), enSection()))
    within(enSection()).getByRole('textbox', { name: en.contextLabel })
    expect(within(enSection()).queryByRole('button', { name: en.termMove })).toBeNull()

    await user.click(button(en.termDetailsOf('sign-in'), enSection()))
    expect(within(enSection()).getAllByRole('textbox', { name: en.contextLabel })).toHaveLength(2)
    expect(within(enSection()).getAllByRole('button', { name: en.termMove })).toHaveLength(1)
  })

  it('opens and closes both dialogs', async () => {
    const user = userEvent.setup()
    const { onTransferred } = renderEntry()
    await user.click(button(en.mergeInto))
    await screen.findByRole('heading', { name: en.mergeTitle('Anmeldung') })
    await user.click(button(en.dialogCancel, screen.getByRole('dialog')))
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(button(en.termDetailsOf('Login'), deSection()))
    await user.click(button(en.termMove))
    await screen.findByRole('heading', { name: en.moveTitle('Login') })
    await user.click(button(en.dialogCancel, screen.getByRole('dialog')))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onTransferred).not.toHaveBeenCalled()
  })

  it('keeps "Merge into…" enabled with only a reason typed and sends the reason with the merge', async () => {
    const user = userEvent.setup()
    serve(MERGED)
    const { onTransferred } = renderEntry()
    await user.type(reason(), 'Same thing')
    expect(button(en.mergeInto).disabled).toBe(false)
    await user.click(button(en.mergeInto))
    await confirmWith(user, en.mergeConfirm('Anmeldung'))

    await waitFor(() => expect(onTransferred).toHaveBeenCalledWith(MERGED, 'merge'))
    expect(runs()).toEqual([
      { method: 'POST', path: '/api/concepts/7/merge', body: { target_id: 8, basis: BASIS, comment: 'Same thing' } },
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps "Move…" enabled with only a reason typed and sends the reason with the move', async () => {
    const user = userEvent.setup()
    serve(MOVED)
    const { onTransferred } = renderEntry()
    await user.type(reason(), 'Belongs there')
    await user.click(button(en.termDetailsOf('Login'), deSection()))
    expect(button(en.termMove).disabled).toBe(false)
    await user.click(button(en.termMove))
    await screen.findByRole('heading', { name: en.moveTitle('Login') })
    await confirmWith(user, en.moveConfirm)

    await waitFor(() => expect(onTransferred).toHaveBeenCalledWith(MOVED, 'move'))
    expect(runs()).toEqual([
      { method: 'POST', path: '/api/terms/702/move', body: { target_id: 8, basis: BASIS, comment: 'Belongs there' } },
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
