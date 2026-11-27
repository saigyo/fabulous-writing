import { describe, expect, it } from 'vitest'
import type {
  Concept,
  ConceptTerm,
  Language,
  LanguageSection,
  TransferOutcome,
  UsageStatus,
} from '../types'
import { highlight, notices, resultRows, sourceIsCurrent, suggest, suggestionRow } from './transfer'

const ORDER: Language[] = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh']

let nextId = 1000
function term(text: string, usage: UsageStatus = 'admitted', id: number = nextId++): ConceptTerm {
  return {
    id,
    uid: `t${id}`,
    text,
    usage_status: usage,
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
  }
}

function section(language: Language, terms: ConceptTerm[]): LanguageSection {
  return {
    id: nextId++,
    language,
    definition: '',
    revision: 1,
    created_at: null,
    created_by: null,
    modified_at: null,
    modified_by: null,
    terms,
  }
}

function concept(...sections: LanguageSection[]): Concept {
  return {
    id: nextId++,
    uid: `c${nextId}`,
    domain_ids: [1],
    is_global: false,
    sections,
    revision: 1,
    created_at: null,
    created_by: null,
    modified_at: null,
    modified_by: null,
  }
}

function en(text: string): Concept {
  return concept(section('en', [term(text, 'preferred')]))
}

function texts(concepts: Concept[]): string[] {
  return concepts.map((c) => c.sections[0].terms[0].text)
}

describe('suggest', () => {
  const pool = [en('Workspace'), en('Team work'), en('Workflow'), en('Homework'), en('Work item')]

  it('lists prefix matches before other matches, each group alphabetical', () => {
    expect(texts(suggest(pool, 'work', 'en', ORDER))).toEqual([
      'Work item',
      'Workflow',
      'Workspace',
      'Homework',
      'Team work',
    ])
  })

  it('finds a concept that matches only in another language', () => {
    const de = concept(section('en', [term('Board', 'preferred')]), section('de', [term('Tafel')]))
    expect(suggest([en('Other'), de], 'tafel', 'en', ORDER)).toEqual([de])
  })

  it('lists everything in label order for an empty query', () => {
    expect(texts(suggest(pool, '', 'en', ORDER))).toEqual([
      'Homework',
      'Team work',
      'Work item',
      'Workflow',
      'Workspace',
    ])
  })

  it('lets the fallback label decide the prefix group', () => {
    const onlyGerman = concept(section('de', [term('Arbeitsraum', 'preferred')]))
    const inner = en('Raum Arbeitsraum')
    expect(suggest([inner, onlyGerman], 'arbeits', 'en', ORDER)).toEqual([onlyGerman, inner])
  })

  it('ignores case and surrounding blanks of the query', () => {
    expect(texts(suggest(pool, '  WORKS ', 'en', ORDER))).toEqual(['Workspace'])
  })
})

describe('suggestionRow', () => {
  it('takes the other wordings from the language of the label', () => {
    const c = concept(
      section('de', [term('Arbeitsbereich', 'preferred'), term('Bereich')]),
      section('fr', [term('espace', 'preferred'), term('zone')]),
    )
    const row = suggestionRow(c, 'en', ['en', 'de', 'fr'])
    expect(row.label).toEqual({ text: 'Arbeitsbereich', language: 'de', fallback: true })
    expect(row.others.map((t) => t.text)).toEqual(['Bereich'])
    expect(row.languages).toEqual(['de', 'fr'])
  })
})

describe('highlight', () => {
  it('marks every occurrence, ignoring case and keeping the original casing', () => {
    expect(highlight('Workflow of work', 'WORK')).toEqual([
      { text: 'Work', match: true },
      { text: 'flow of ', match: false },
      { text: 'work', match: true },
    ])
  })

  it('returns one unmarked part when nothing matches', () => {
    expect(highlight('Workspace', 'xyz')).toEqual([{ text: 'Workspace', match: false }])
  })

  it('returns one unmarked part for an empty query', () => {
    expect(highlight('Workspace', '')).toEqual([{ text: 'Workspace', match: false }])
  })
})

function outcome(over: Partial<TransferOutcome> = {}): TransferOutcome {
  return {
    target: concept(),
    source: concept(),
    moved: [],
    dropped_terms: [],
    dropped_definitions: [],
    removed_languages: [],
    dropped_domains: [],
    added_domains: [],
    basis: { source: { concept_id: 1, revision: 1, sections: [] }, target: null },
    ...over,
  }
}

describe('resultRows', () => {
  it('lists languages in order, chips by usage then id, and flags incoming terms', () => {
    const target = concept(
      section('de', [term('Arbeitsraum', 'preferred', 40)]),
      section('en', [
        term('zeta', 'forbidden', 5),
        term('beta', 'admitted', 9),
        term('alpha', 'admitted', 7),
        term('gamma', 'preferred', 20),
        term('delta', 'deprecated', 3),
      ]),
    )
    const rows = resultRows(
      outcome({
        target,
        moved: [{ id: 9, text: 'beta', language: 'en', usage_before: 'admitted', usage_after: 'admitted' }],
      }),
      ORDER,
    )
    expect(rows.map((r) => r.language)).toEqual(['en', 'de'])
    expect(rows[0].terms.map((t) => [t.term.text, t.incoming])).toEqual([
      ['gamma', false],
      ['alpha', false],
      ['beta', true],
      ['delta', false],
      ['zeta', false],
    ])
    expect(rows[0].demoted).toEqual([])
  })

  it('names the wordings whose usage fell from preferred to admitted', () => {
    const target = concept(
      section('en', [term('sign in', 'preferred', 1), term('log in', 'admitted', 2), term('login', 'forbidden', 3)]),
    )
    const rows = resultRows(
      outcome({
        target,
        moved: [
          { id: 2, text: 'log in', language: 'en', usage_before: 'preferred', usage_after: 'admitted' },
          { id: 3, text: 'login', language: 'en', usage_before: 'forbidden', usage_after: 'forbidden' },
        ],
      }),
      ORDER,
    )
    expect(rows[0].demoted).toEqual(['log in'])
  })

  it('shows a language that exists only through incoming terms', () => {
    const target = concept(section('en', [term('a', 'preferred', 1)]), section('de', [term('b', 'preferred', 2)]))
    const rows = resultRows(
      outcome({
        target,
        moved: [{ id: 2, text: 'b', language: 'de', usage_before: 'preferred', usage_after: 'preferred' }],
      }),
      ORDER,
    )
    expect(rows.map((r) => [r.language, r.terms.map((t) => t.incoming)])).toEqual([
      ['en', [false]],
      ['de', [true]],
    ])
  })

  it('leaves out a section without terms', () => {
    const target = concept(section('en', [term('a', 'preferred', 1)]), section('de', []))
    expect(resultRows(outcome({ target }), ORDER).map((r) => r.language)).toEqual(['en'])
  })
})

describe('notices', () => {
  it('reports nothing when nothing was lost', () => {
    expect(notices(outcome(), 'merge')).toEqual([])
    expect(notices(outcome(), 'move')).toEqual([])
  })

  it('orders a merge: dropped terms, definitions, domains', () => {
    const o = outcome({
      source: null,
      dropped_domains: [{ id: 2, name: 'Sales' }],
      dropped_definitions: [{ language: 'de', definition: 'Ein Ort.' }],
      dropped_terms: [{ text: 'desk', language: 'en', usage_status: 'admitted' }],
      added_domains: [{ id: 3, name: 'Marketing' }],
      moved: [{ id: 1, text: 'x', language: 'en', usage_before: 'preferred', usage_after: 'admitted' }],
      removed_languages: ['de'],
    })
    expect(notices(o, 'merge')).toEqual([
      { kind: 'droppedTerm', text: 'desk', language: 'en', usageStatus: 'admitted' },
      { kind: 'droppedDefinition', language: 'de', definition: 'Ein Ort.' },
      { kind: 'droppedDomain', name: 'Sales' },
    ])
  })

  it('orders a move: demoted, lost language, definition, domains, source deleted', () => {
    const o = outcome({
      source: null,
      moved: [{ id: 1, text: 'log in', language: 'en', usage_before: 'preferred', usage_after: 'admitted' }],
      removed_languages: [],
      dropped_definitions: [{ language: 'fr', definition: 'Un lieu.' }],
      dropped_domains: [{ id: 2, name: 'Sales' }],
      added_domains: [{ id: 3, name: 'Marketing' }],
    })
    expect(notices(o, 'move')).toEqual([
      { kind: 'demoted', text: 'log in' },
      { kind: 'droppedDefinition', language: 'fr', definition: 'Un lieu.' },
      { kind: 'droppedDomain', name: 'Sales' },
      { kind: 'addedDomain', name: 'Marketing' },
      { kind: 'sourceDeleted' },
    ])
  })

  it('puts the dropped definition of a lost language into its notice, null without one', () => {
    const o = outcome({
      removed_languages: ['de', 'fr'],
      dropped_definitions: [{ language: 'de', definition: 'Ein Ort.' }],
    })
    expect(notices(o, 'move')).toEqual([
      { kind: 'lostLanguage', language: 'de', definition: 'Ein Ort.' },
      { kind: 'lostLanguage', language: 'fr', definition: null },
    ])
  })

  it('reports the dropped definition of a deleted source in a move', () => {
    const o = outcome({
      source: null,
      dropped_definitions: [{ language: 'de', definition: 'Ein Ort.' }],
    })
    expect(notices(o, 'move')).toEqual([
      { kind: 'droppedDefinition', language: 'de', definition: 'Ein Ort.' },
      { kind: 'sourceDeleted' },
    ])
  })
})

describe('sourceIsCurrent', () => {
  const held = concept(section('en', [term('a')]), section('de', [term('b')]))
  const [first, second] = held.sections
  const basedOn = (over: Partial<TransferOutcome['basis']['source']> = {}) =>
    outcome({
      basis: {
        source: {
          concept_id: held.id,
          revision: held.revision,
          sections: [
            { id: first.id, revision: first.revision },
            { id: second.id, revision: second.revision },
          ],
          ...over,
        },
        target: null,
      },
    })

  it('is true when concept, revision and sections match, in any order', () => {
    expect(sourceIsCurrent(held, basedOn())).toBe(true)
    expect(
      sourceIsCurrent(
        held,
        basedOn({
          sections: [
            { id: second.id, revision: second.revision },
            { id: first.id, revision: first.revision },
          ],
        }),
      ),
    ).toBe(true)
  })

  it('is false for another concept', () => {
    expect(sourceIsCurrent(held, basedOn({ concept_id: held.id + 1 }))).toBe(false)
  })

  it('is false for another concept revision', () => {
    expect(sourceIsCurrent(held, basedOn({ revision: held.revision + 1 }))).toBe(false)
  })

  it('is false when a section has another revision', () => {
    expect(
      sourceIsCurrent(
        held,
        basedOn({
          sections: [
            { id: first.id, revision: first.revision },
            { id: second.id, revision: second.revision + 1 },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('is false for an extra or a missing section', () => {
    const one = { id: first.id, revision: first.revision }
    const two = { id: second.id, revision: second.revision }
    expect(sourceIsCurrent(held, basedOn({ sections: [one, two, { id: 99999, revision: 1 }] }))).toBe(false)
    expect(sourceIsCurrent(held, basedOn({ sections: [one] }))).toBe(false)
    expect(sourceIsCurrent(held, basedOn({ sections: [one, { id: 99999, revision: 1 }] }))).toBe(false)
  })
})
