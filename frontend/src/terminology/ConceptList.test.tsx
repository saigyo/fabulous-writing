// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { de } from '../i18n/de'
import { en } from '../i18n/en'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type { Concept, ConceptTerm, Domain, Language, ProcessStatus, UsageStatus } from '../types'
import { ConceptList } from './ConceptList'

const domain: Domain = { id: 2, name: 'Private', description: '', is_global: false }
const other: Domain = { id: 3, name: 'Legal', description: '', is_global: false }
const domains = [domain, other]

function term(
  id: number,
  text: string,
  usage: UsageStatus = 'preferred',
  process: ProcessStatus = 'active',
): ConceptTerm {
  return {
    id,
    uid: `t${id}`,
    text,
    usage_status: usage,
    process_status: process,
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
  }
}

function concept(id: number, sections: Partial<Record<Language, ConceptTerm[]>>, domainIds = [2]): Concept {
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
    sections: Object.entries(sections).map(([language, terms], i) => ({
      id: id * 10 + i,
      language: language as Language,
      definition: '',
      revision: 1,
      created_at: null,
      created_by: null,
      modified_at: null,
      modified_by: null,
      terms: terms as ConceptTerm[],
    })),
  }
}

const widget = concept(
  1,
  {
    en: [
      term(1, 'widget'),
      term(2, 'gadget', 'admitted'),
      term(3, 'thingamajig', 'forbidden'),
      term(4, 'gizmo', 'admitted', 'candidate'),
    ],
    de: [term(5, 'Bauteil')],
  },
  [2, 3],
)
const onlyGerman = concept(2, { de: [term(6, 'Schraube')] })

function renderList(
  concepts: Concept[],
  props: Partial<React.ComponentProps<typeof ConceptList>> = {},
) {
  const onOpen = vi.fn()
  const onCreate = vi.fn()
  render(
    <ConceptList
      domain={domain}
      concepts={concepts}
      domains={domains}
      readOnly={false}
      canCreate
      onOpen={onOpen}
      onCreate={onCreate}
      {...props}
    />,
  )
  return { onOpen, onCreate }
}

function row(label: string): HTMLElement {
  return screen.getByRole('button', { name: label }).closest('tr') as HTMLElement
}

beforeEach(() => {
  useStore.setState({ uiLocale: 'en', languages: FALLBACK_LANGUAGES })
})

afterEach(() => {
  cleanup()
})

describe('ConceptList', () => {
  it('labels a row with the preferred term of the chosen language', () => {
    renderList([widget])
    expect(within(row('widget')).queryByText(en.noTermIn('English'))).toBeNull()
  })

  it('shows the fallback term with its language marker and the "no term" text', () => {
    renderList([onlyGerman])
    const r = row('Schraube')
    within(r.querySelector('.concept-label') as HTMLElement).getByText('DE')
    within(r).getByText(en.noTermIn('English'))
  })

  it('shows other wordings as chips whose accessible name contains the status', () => {
    renderList([widget])
    const r = row('widget')
    within(r).getByRole('img', { name: `gadget, ${en.statusName('admitted')}` })
    within(r).getByRole('img', { name: `thingamajig, ${en.statusName('forbidden')}` })
  })

  it('adds "candidate" to the accessible name and title of a candidate chip', () => {
    renderList([widget])
    const chip = within(row('widget')).getByRole('img', {
      name: `gizmo, ${en.statusName('admitted')}, ${en.statusCandidate}`,
    })
    expect(chip.getAttribute('title')).toBe(
      `gizmo, ${en.statusName('admitted')}, ${en.statusCandidate}`,
    )
    expect(chip.className).toContain('candidate')
  })

  it('lists the languages with terms and the other domains, with a dash when there are none', () => {
    renderList([widget, onlyGerman])
    const r = row('widget')
    within(r).getByTitle('English')
    within(r).getByTitle('Deutsch')
    within(r).getByText('Legal')
    expect(within(row('Schraube')).getAllByText('—').length).toBe(1)
  })

  it('names the four statuses and the candidate in the legend', () => {
    renderList([widget])
    const legend = screen.getByRole('list', { name: en.statusLegend })
    for (const status of ['preferred', 'admitted', 'deprecated', 'forbidden'] as const) {
      within(legend).getByText(en.statusName(status))
    }
    within(legend).getByText(en.statusCandidate)
  })

  it('starts on the interface language and changes the labels with the selector', async () => {
    useStore.setState({ uiLocale: 'de' })
    renderList([widget])
    const select = screen.getByRole('combobox', { name: de.conceptLanguageTitle }) as HTMLSelectElement
    expect(select.value).toBe('de')
    row('Bauteil')

    await userEvent.selectOptions(select, 'en')
    row('widget')
  })

  it('finds a concept by a wording of another language', async () => {
    renderList([widget, onlyGerman])
    await userEvent.type(screen.getByRole('searchbox'), 'bauteil')
    row('widget')
    expect(screen.queryByRole('button', { name: 'Schraube' })).toBeNull()
  })

  it('says that no concepts match when the filter empties a non-empty list', async () => {
    renderList([widget])
    expect(screen.queryByText(en.noConceptsMatch)).toBeNull()
    await userEvent.type(screen.getByRole('searchbox'), 'zzz')
    screen.getByText(en.noConceptsMatch)
  })

  it('does not say that no concepts match for an empty list', () => {
    renderList([])
    expect(screen.queryByText(en.noConceptsMatch)).toBeNull()
  })

  it('opens a concept from its row with the chosen language', async () => {
    const { onOpen } = renderList([widget])
    await userEvent.click(screen.getByRole('button', { name: 'widget' }))
    expect(onOpen).toHaveBeenLastCalledWith(1, 'en')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: en.conceptLanguageTitle }), 'de')
    await userEvent.click(screen.getByRole('button', { name: 'Bauteil' }))
    expect(onOpen).toHaveBeenLastCalledWith(1, 'de')
  })

  it('creates a concept in the chosen language', async () => {
    const { onCreate } = renderList([widget])
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: en.conceptLanguageTitle }),
      'fr',
    )
    await userEvent.click(screen.getByRole('button', { name: en.newConcept }))
    expect(onCreate).toHaveBeenCalledWith('fr')
  })

  it('has no "+ Concept" without the feature', () => {
    renderList([widget], { canCreate: false })
    expect(screen.queryByRole('button', { name: en.newConcept })).toBeNull()
  })

  it('has no "+ Concept" for a read-only domain', () => {
    renderList([widget], { readOnly: true })
    expect(screen.queryByRole('button', { name: en.newConcept })).toBeNull()
  })
})
