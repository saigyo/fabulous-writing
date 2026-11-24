import { describe, expect, it } from 'vitest'
import type { Concept, ConceptTerm, Language, LanguageSection } from '../types'
import {
  addLanguage,
  applySaved,
  createBody,
  discardAll,
  discardSection,
  entryFromConcept,
  hasUnsaved,
  linksUnsaved,
  newEntry,
  newTerm,
  reloadPart,
  saveAllBody,
  sectionChanges,
  sectionProblems,
  toSectionInput,
  unsavedLanguages,
  type EntryState,
  type SectionState,
  type TermDraft,
} from './conceptDraft'

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

const EN = section(10, 'en', [term(100, 'apple', { usage_status: 'preferred' }), term(101, 'apples', { usage_status: 'forbidden' })], {
  definition: 'A fruit',
  revision: 2,
})
const DE = section(20, 'de', [term(200, 'Apfel', { usage_status: 'preferred' })])

function concept(sections: LanguageSection[] = [EN, DE], over: Partial<Concept> = {}): Concept {
  return {
    id: 7,
    uid: 'c7',
    domain_ids: [1],
    is_global: false,
    sections,
    revision: 3,
    created_at: null,
    created_by: null,
    modified_at: null,
    modified_by: null,
    ...over,
  }
}

function sectionOf(state: EntryState, language: Language): SectionState {
  const found = state.sections.find((s) => s.language === language)
  if (!found) throw new Error(`no section ${language}`)
  return found
}

function editSection(state: EntryState, language: Language, edit: (s: SectionState) => SectionState): EntryState {
  return { ...state, sections: state.sections.map((s) => (s.language === language ? edit(s) : s)) }
}

function editTerm(s: SectionState, index: number, patch: Partial<TermDraft>): SectionState {
  return { ...s, terms: s.terms.map((t, i) => (i === index ? { ...t, ...patch } : t)) }
}

function rename(state: EntryState, language: Language, text: string): EntryState {
  return editSection(state, language, (s) => editTerm(s, 0, { text }))
}

describe('the state that is read', () => {
  it('holds the saved state of every section, drafts equal to it and the links that were read', () => {
    const state = entryFromConcept(concept())
    expect(state.conceptId).toBe(7)
    expect(state.isGlobal).toBe(false)
    expect(sectionOf(state, 'en').saved).toEqual(EN)
    expect(sectionOf(state, 'en').definition).toBe('A fruit')
    expect(sectionOf(state, 'en').terms.map((t) => t.text)).toEqual(['apple', 'apples'])
    expect(state.savedDomainIds).toEqual([1])
    expect(state.savedRevision).toBe(3)
    expect(state.domainIds).toEqual([1])
    expect(hasUnsaved(state)).toBe(false)
  })

  it('gives a new entry one section with one empty, preferred, active term and nothing saved', () => {
    const state = newEntry(4, true, 'fr')
    expect(state).toMatchObject({ conceptId: null, isGlobal: true, savedDomainIds: [4], savedRevision: null, domainIds: [4] })
    expect(state.sections).toHaveLength(1)
    const [s] = state.sections
    expect(s).toMatchObject({ language: 'fr', saved: null, definition: '', removed: false })
    expect(s.terms).toHaveLength(1)
    expect(s.terms[0]).toMatchObject({ text: '', usage_status: 'preferred', process_status: 'active' })
  })

  it('adds a language with the same shape', () => {
    const state = addLanguage(entryFromConcept(concept()), 'fr')
    const fr = sectionOf(state, 'fr')
    expect(fr).toMatchObject({ saved: null, definition: '', removed: false })
    expect(fr.terms).toHaveLength(1)
    expect(fr.terms[0]).toMatchObject({ text: '', usage_status: 'preferred', process_status: 'active' })
  })

  it('gives every term a key that is unique and stays the same for the same saved term', () => {
    const state = addLanguage(addLanguage(entryFromConcept(concept()), 'fr'), 'it')
    const keys = [...state.sections.flatMap((s) => s.terms.map((t) => t.key)), newTerm().key, newTerm().key]
    expect(new Set(keys).size).toBe(keys.length)
    expect(entryFromConcept(concept()).sections[0].terms.map((t) => t.key)).toEqual(
      state.sections[0].terms.map((t) => t.key),
    )
    const discarded = discardSection(rename(state, 'en', 'pear'), 'en')
    expect(sectionOf(discarded, 'en').terms.map((t) => t.key)).toEqual(sectionOf(state, 'en').terms.map((t) => t.key))
  })
})

describe('sectionChanges', () => {
  const en = () => sectionOf(entryFromConcept(concept()), 'en')

  it('is 0 for an untouched section', () => {
    expect(sectionChanges(en())).toBe(0)
  })
  it('counts each changed field of a term', () => {
    expect(sectionChanges(editTerm(en(), 0, { text: 'Apple', context: 'fruit' }))).toBe(2)
  })
  it('counts an added term as 1', () => {
    const s = en()
    expect(sectionChanges({ ...s, terms: [...s.terms, { ...newTerm(), text: 'pome' }] })).toBe(1)
  })
  it('counts a removed term as 1', () => {
    const s = en()
    expect(sectionChanges({ ...s, terms: s.terms.slice(1) })).toBe(1)
  })
  it('counts the definition as 1', () => {
    expect(sectionChanges({ ...en(), definition: 'A round fruit' })).toBe(1)
  })
  it('is 0 for a field changed and changed back', () => {
    const changed = editTerm(en(), 0, { text: 'Apple' })
    expect(sectionChanges(editTerm(changed, 0, { text: 'apple' }))).toBe(0)
  })
  it('does not count a new order of the terms', () => {
    const s = en()
    expect(sectionChanges({ ...s, terms: [...s.terms].reverse() })).toBe(0)
  })
  it('counts a removed section as 1', () => {
    expect(sectionChanges({ ...en(), removed: true })).toBe(1)
  })
  it('counts the definition and every term of a new language', () => {
    const fr = sectionOf(addLanguage(entryFromConcept(concept()), 'fr'), 'fr')
    const terms = [{ ...fr.terms[0], text: 'pomme' }, { ...newTerm(), text: 'fruit' }]
    expect(sectionChanges({ ...fr, definition: 'Un fruit', terms })).toBe(3)
  })
  it('does not count an added term whose text is blank, whatever its other fields', () => {
    const s = en()
    const blank = { ...newTerm(), text: '  ', context: 'later', usage_status: 'deprecated' as const }
    expect(sectionChanges({ ...s, terms: [...s.terms, blank] })).toBe(0)
  })
  it('counts 1 for a real added term next to a blank one, which is still a problem', () => {
    const s = en()
    const added = { ...s, terms: [...s.terms, { ...newTerm(), text: 'pome' }, newTerm()] }
    expect(sectionChanges(added)).toBe(1)
    expect(sectionProblems(added)).toEqual(['empty_text'])
  })
})

describe('a blank added term', () => {
  it('leaves an untouched new entry with nothing unsaved', () => {
    const state = newEntry(1, false, 'en')
    expect(sectionChanges(state.sections[0])).toBe(0)
    expect(hasUnsaved(state)).toBe(false)
  })
  it('becomes an unsaved change of 1 once a text is typed', () => {
    const state = rename(newEntry(1, false, 'en'), 'en', 'apple')
    expect(sectionChanges(state.sections[0])).toBe(1)
    expect(hasUnsaved(state)).toBe(true)
  })
  it('leaves a blank added language out of what is unsaved and of "Save all"', () => {
    const state = addLanguage(entryFromConcept(concept()), 'fr')
    expect(unsavedLanguages(state)).toEqual([])
    expect(saveAllBody(state, '').sections).toEqual([])
  })
  it('leaves a blank added language out of the first save', () => {
    const state = addLanguage(rename(newEntry(1, false, 'en'), 'en', 'apple'), 'de')
    expect(createBody(state, '').sections.map((s) => s.language)).toEqual(['en'])
  })
})

describe('what is unsaved', () => {
  it('compares the links as sets', () => {
    const state = entryFromConcept(concept([EN], { domain_ids: [1, 2] }))
    expect(linksUnsaved({ ...state, domainIds: [2, 1] })).toBe(false)
    expect(linksUnsaved({ ...state, domainIds: [1, 2, 3] })).toBe(true)
    expect(linksUnsaved({ ...state, domainIds: [1] })).toBe(true)
  })

  it('lists the languages with unsaved changes', () => {
    const state = rename(addLanguage(rename(entryFromConcept(concept()), 'de', 'Äpfel'), 'fr'), 'fr', 'pomme')
    expect(unsavedLanguages(state)).toEqual(['de', 'fr'])
  })

  it('is unsaved with an unsaved section or unsaved links', () => {
    const state = entryFromConcept(concept())
    expect(hasUnsaved(rename(state, 'de', 'Äpfel'))).toBe(true)
    expect(hasUnsaved({ ...state, domainIds: [1, 2] })).toBe(true)
  })
})

describe('toSectionInput', () => {
  it('carries the id and version number of the saved state', () => {
    expect(toSectionInput(sectionOf(entryFromConcept(concept()), 'en'))).toMatchObject({
      language: 'en',
      id: 10,
      revision: 2,
      definition: 'A fruit',
    })
  })
  it('carries neither for a new language', () => {
    const input = toSectionInput(sectionOf(addLanguage(entryFromConcept(concept()), 'fr'), 'fr'))
    expect(input).not.toHaveProperty('id')
    expect(input).not.toHaveProperty('revision')
  })
  it('sends a removed section with no terms', () => {
    const input = toSectionInput({ ...sectionOf(entryFromConcept(concept()), 'en'), removed: true })
    expect(input).toMatchObject({ id: 10, revision: 2, terms: [] })
  })
  it('sends every field of a term and no key', () => {
    const input = toSectionInput(sectionOf(entryFromConcept(concept()), 'de'))
    expect(input.terms).toEqual([
      {
        id: 200,
        text: 'Apfel',
        usage_status: 'preferred',
        process_status: 'active',
        status_reason: '',
        context: '',
        source: '',
        part_of_speech: null,
        case_sensitive: false,
      },
    ])
  })
})

describe('saveAllBody', () => {
  const read = () => entryFromConcept(concept([EN, DE], { domain_ids: [1, 2] }))

  it('contains only the unsaved sections', () => {
    const body = saveAllBody(rename(read(), 'de', 'Äpfel'), '')
    expect(body.sections.map((s) => s.language)).toEqual(['de'])
  })
  it('contains the links and the version number only when the links are unsaved', () => {
    expect(saveAllBody(rename(read(), 'de', 'Äpfel'), '')).not.toHaveProperty('domain_ids')
    expect(saveAllBody(rename(read(), 'de', 'Äpfel'), '')).not.toHaveProperty('revision')
    expect(saveAllBody({ ...read(), domainIds: [1, 2, 5] }, '')).toMatchObject({ domain_ids: [1, 2, 5], revision: 3 })
  })
  it('does not count a new order of the links as unsaved', () => {
    expect(saveAllBody({ ...read(), domainIds: [2, 1] }, '')).not.toHaveProperty('domain_ids')
  })
  it('leaves out an empty comment and sends a given one', () => {
    expect(saveAllBody(rename(read(), 'de', 'Äpfel'), '')).not.toHaveProperty('comment')
    expect(saveAllBody(rename(read(), 'de', 'Äpfel'), 'typo')).toMatchObject({ comment: 'typo' })
  })
})

describe('createBody', () => {
  it('sends every section that has terms and no links, also when the links were edited', () => {
    let state = newEntry(1, false, 'en')
    state = rename(state, 'en', 'apple')
    state = rename(addLanguage(state, 'de'), 'de', 'Apfel')
    state = editSection(addLanguage(state, 'fr'), 'fr', (s) => ({ ...s, terms: [] }))
    state = { ...state, domainIds: [1, 2] }
    const body = createBody(state, 'first')
    expect(body.sections.map((s) => s.language)).toEqual(['en', 'de'])
    expect(body).not.toHaveProperty('domain_ids')
    expect(body).not.toHaveProperty('revision')
    expect(body.comment).toBe('first')
    expect(createBody(state, '')).not.toHaveProperty('comment')
  })
})

describe('sectionProblems', () => {
  const de = () => sectionOf(entryFromConcept(concept()), 'de')
  const withTerm = (s: SectionState, patch: Partial<TermDraft>) => ({ ...s, terms: [...s.terms, { ...newTerm(), ...patch }] })

  it('finds none in a valid section', () => {
    expect(sectionProblems(de())).toEqual([])
  })
  it('finds an empty term text', () => {
    expect(sectionProblems(withTerm(de(), { text: '  ' }))).toEqual(['empty_text'])
  })
  it('finds the same text twice', () => {
    expect(sectionProblems(withTerm(de(), { text: 'Apfel', usage_status: 'admitted' }))).toEqual(['duplicate_text'])
  })
  it('finds a second active preferred term', () => {
    expect(sectionProblems(withTerm(de(), { text: 'Paradiesapfel', usage_status: 'preferred' }))).toEqual([
      'second_preferred',
    ])
  })
  it('does not count a candidate preferred term next to an active one', () => {
    const s = withTerm(de(), { text: 'Paradiesapfel', usage_status: 'preferred', process_status: 'candidate' })
    expect(sectionProblems(s)).toEqual([])
  })
  it('finds a section without terms unless it is removed', () => {
    expect(sectionProblems({ ...de(), terms: [] })).toEqual(['no_terms'])
    expect(sectionProblems({ ...de(), terms: [], removed: true })).toEqual([])
  })
})

describe('discarding', () => {
  it('returns a section to what was read', () => {
    const state = discardSection(rename(entryFromConcept(concept()), 'en', 'pear'), 'en')
    expect(sectionChanges(sectionOf(state, 'en'))).toBe(0)
    expect(sectionOf(state, 'en').terms[0].text).toBe('apple')
  })
  it('removes a section that is not saved yet', () => {
    const state = discardSection(addLanguage(entryFromConcept(concept()), 'fr'), 'fr')
    expect(state.sections.map((s) => s.language)).toEqual(['en', 'de'])
  })
  it('restores a removed section', () => {
    const removed = editSection(entryFromConcept(concept()), 'de', (s) => ({ ...s, removed: true }))
    const state = discardSection(removed, 'de')
    expect(sectionOf(state, 'de').removed).toBe(false)
    expect(hasUnsaved(state)).toBe(false)
  })
  it('discards every section and the links at once', () => {
    let state = addLanguage(rename(rename(entryFromConcept(concept()), 'en', 'pear'), 'de', 'Birne'), 'fr')
    state = discardAll({ ...state, domainIds: [1, 2] })
    expect(state.sections.map((s) => s.language)).toEqual(['en', 'de'])
    expect(hasUnsaved(state)).toBe(false)
    expect(state.domainIds).toEqual([1])
  })
  it('keeps what a language save has stored when the rest is discarded', () => {
    const edited = rename(rename(entryFromConcept(concept()), 'en', 'pear'), 'de', 'Birne')
    const storedEn = section(10, 'en', [term(100, 'pear', { usage_status: 'preferred' }), EN.terms[1]], {
      definition: 'A fruit',
      revision: 3,
    })
    const saved = applySaved(edited, concept([storedEn, DE]), { languages: ['en'], links: false })
    const state = discardAll(saved)
    expect(sectionOf(state, 'en').terms[0].text).toBe('pear')
    expect(sectionOf(state, 'en').saved?.revision).toBe(3)
    expect(sectionOf(state, 'de').terms[0].text).toBe('Apfel')
  })
})

describe('applySaved', () => {
  const EN3 = section(10, 'en', [term(100, 'pear', { usage_status: 'preferred' }), EN.terms[1]], {
    definition: 'A fruit',
    revision: 3,
  })
  const DE2 = section(20, 'de', [term(200, 'Apfel', { usage_status: 'preferred' }), term(201, 'Paradiesapfel')], {
    revision: 2,
  })
  const FR = section(30, 'fr', [term(300, 'pomme', { usage_status: 'preferred' })])

  it('lets a sent section take the server state and become saved', () => {
    const state = applySaved(rename(entryFromConcept(concept()), 'en', 'pear'), concept([EN3, DE]), {
      languages: ['en'],
      links: false,
    })
    expect(sectionOf(state, 'en').saved).toEqual(EN3)
    expect(sectionChanges(sectionOf(state, 'en'))).toBe(0)
  })

  it('lets an untouched section take a change someone else made', () => {
    const state = applySaved(rename(entryFromConcept(concept()), 'en', 'pear'), concept([EN3, DE2]), {
      languages: ['en'],
      links: false,
    })
    expect(sectionOf(state, 'de').saved).toEqual(DE2)
    expect(sectionOf(state, 'de').terms.map((t) => t.text)).toEqual(['Apfel', 'Paradiesapfel'])
  })

  it('keeps the saved version number and the draft of an unsaved section that was not sent', () => {
    const edited = rename(rename(entryFromConcept(concept()), 'en', 'pear'), 'de', 'Birne')
    const state = applySaved(edited, concept([EN3, DE2]), { languages: ['en'], links: false })
    expect(sectionOf(state, 'de').saved?.revision).toBe(1)
    expect(sectionOf(state, 'de').terms.map((t) => t.text)).toEqual(['Birne'])
    expect(sectionChanges(sectionOf(state, 'de'))).toBe(1)
  })

  it('shows a language someone else added', () => {
    const state = applySaved(rename(entryFromConcept(concept()), 'en', 'pear'), concept([EN3, DE, FR]), {
      languages: ['en'],
      links: false,
    })
    expect(state.sections.map((s) => s.language)).toEqual(['en', 'de', 'fr'])
    expect(sectionOf(state, 'fr').saved).toEqual(FR)
  })

  it('drops an untouched language someone else removed', () => {
    const state = applySaved(rename(entryFromConcept(concept()), 'en', 'pear'), concept([EN3]), {
      languages: ['en'],
      links: false,
    })
    expect(state.sections.map((s) => s.language)).toEqual(['en'])
  })

  it('keeps an unsaved language someone else removed', () => {
    const edited = rename(rename(entryFromConcept(concept()), 'en', 'pear'), 'de', 'Birne')
    const state = applySaved(edited, concept([EN3]), { languages: ['en'], links: false })
    expect(sectionOf(state, 'de').saved).toEqual(DE)
    expect(sectionOf(state, 'de').terms[0].text).toBe('Birne')
  })

  it('drops a sent section the server no longer has', () => {
    const removed = editSection(entryFromConcept(concept()), 'de', (s) => ({ ...s, removed: true }))
    const state = applySaved(removed, concept([EN], { revision: 4 }), { languages: ['de'], links: false })
    expect(state.sections.map((s) => s.language)).toEqual(['en'])
  })

  it('takes the server links and version number after a save that sent the links', () => {
    const edited = { ...entryFromConcept(concept()), domainIds: [1, 2] }
    const state = applySaved(edited, concept([EN, DE], { domain_ids: [1, 2], revision: 4 }), {
      languages: [],
      links: true,
    })
    expect(state.savedDomainIds).toEqual([1, 2])
    expect(state.savedRevision).toBe(4)
    expect(linksUnsaved(state)).toBe(false)
  })

  it('takes over the version number and keeps the edited list when unsent unsaved links are unchanged on the server', () => {
    const read = entryFromConcept(concept([EN, DE], { domain_ids: [1, 2] }))
    const edited = { ...rename(read, 'en', 'pear'), domainIds: [1, 2, 3] }
    const state = applySaved(edited, concept([EN3, DE], { domain_ids: [2, 1], revision: 4 }), {
      languages: ['en'],
      links: false,
    })
    expect(state.savedRevision).toBe(4)
    expect([...state.savedDomainIds].sort()).toEqual([1, 2])
    expect(state.domainIds).toEqual([1, 2, 3])
  })

  it('keeps the read links and version number when unsent unsaved links differ on the server', () => {
    const edited = { ...rename(entryFromConcept(concept()), 'en', 'pear'), domainIds: [1, 2] }
    const state = applySaved(edited, concept([EN3, DE], { domain_ids: [1, 5], revision: 4 }), {
      languages: ['en'],
      links: false,
    })
    expect(state.savedRevision).toBe(3)
    expect(state.savedDomainIds).toEqual([1])
    expect(state.domainIds).toEqual([1, 2])
  })

  it('takes over everything about links that are not unsaved', () => {
    const state = applySaved(rename(entryFromConcept(concept()), 'en', 'pear'), concept([EN3, DE], { domain_ids: [1, 5], revision: 4 }), {
      languages: ['en'],
      links: false,
    })
    expect(state.savedDomainIds).toEqual([1, 5])
    expect(state.savedRevision).toBe(4)
    expect(state.domainIds).toEqual([1, 5])
  })

  it('gives a new concept its id and leaves links edited before the first save unsaved', () => {
    let state = rename(newEntry(1, false, 'en'), 'en', 'apple')
    state = { ...state, domainIds: [1, 2] }
    const created = concept([section(40, 'en', [term(400, 'apple', { usage_status: 'preferred' })])], {
      id: 9,
      revision: 1,
    })
    const after = applySaved(state, created, { languages: ['en'], links: false })
    expect(after.conceptId).toBe(9)
    expect(after.savedRevision).toBe(1)
    expect(linksUnsaved(after)).toBe(true)
    expect(saveAllBody(after, '')).toEqual({ sections: [], domain_ids: [1, 2], revision: 1 })
  })
})

describe('reloadPart', () => {
  const EN3 = section(10, 'en', [term(100, 'pear', { usage_status: 'preferred' })], { revision: 3 })
  const DE2 = section(20, 'de', [term(200, 'Birne', { usage_status: 'preferred' })], { revision: 2 })

  it('replaces exactly the named language and leaves an unsaved other section as it is', () => {
    const edited = rename(rename(entryFromConcept(concept()), 'en', 'plum'), 'de', 'Pflaume')
    const state = reloadPart(edited, concept([EN3, DE2], { revision: 3 }), 'en')
    expect(sectionOf(state, 'en').saved).toEqual(EN3)
    expect(sectionChanges(sectionOf(state, 'en'))).toBe(0)
    expect(sectionOf(state, 'de')).toBe(sectionOf(edited, 'de'))
  })

  it('drops the named language when the server no longer has it', () => {
    const edited = rename(entryFromConcept(concept()), 'de', 'Pflaume')
    const state = reloadPart(edited, concept([EN], { revision: 4 }), 'de')
    expect(state.sections.map((s) => s.language)).toEqual(['en'])
  })

  it('takes over the version number and keeps edited links when a language is loaded and the server links are unchanged', () => {
    const edited = { ...rename(entryFromConcept(concept()), 'en', 'plum'), domainIds: [1, 2] }
    const state = reloadPart(edited, concept([EN3, DE], { revision: 4 }), 'en')
    expect(state.savedRevision).toBe(4)
    expect(state.savedDomainIds).toEqual([1])
    expect(state.domainIds).toEqual([1, 2])
  })

  it('keeps the read links and version number when a language is loaded and the server links differ', () => {
    const edited = { ...rename(entryFromConcept(concept()), 'en', 'plum'), domainIds: [1, 2] }
    const state = reloadPart(edited, concept([EN3, DE], { domain_ids: [1, 5], revision: 4 }), 'en')
    expect(state.savedRevision).toBe(3)
    expect(state.savedDomainIds).toEqual([1])
    expect(state.domainIds).toEqual([1, 2])
  })

  it('replaces the links, saved and edited, and no section', () => {
    const edited = { ...rename(entryFromConcept(concept()), 'en', 'plum'), domainIds: [1, 2] }
    const state = reloadPart(edited, concept([EN3, DE2], { domain_ids: [1, 5], revision: 4 }), 'links')
    expect(state.savedDomainIds).toEqual([1, 5])
    expect(state.savedRevision).toBe(4)
    expect(state.domainIds).toEqual([1, 5])
    expect(state.sections).toBe(edited.sections)
  })
})

describe('purity', () => {
  it('changes none of its inputs', () => {
    const state = { ...addLanguage(rename(entryFromConcept(concept()), 'en', 'pear'), 'fr'), domainIds: [1, 2] }
    const server = concept([EN, DE], { domain_ids: [1, 3], revision: 4 })
    const before = structuredClone({ state, server })
    addLanguage(state, 'it')
    saveAllBody(state, 'x')
    createBody(state, 'x')
    discardSection(state, 'en')
    discardSection(state, 'fr')
    discardAll(state)
    applySaved(state, server, { languages: ['en'], links: true })
    reloadPart(state, server, 'en')
    reloadPart(state, server, 'links')
    expect({ state, server }).toEqual(before)
  })
})
