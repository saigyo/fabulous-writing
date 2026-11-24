import type {
  Concept,
  ConceptTerm,
  Language,
  LanguageSection,
  SectionInput,
  TermInput,
  UsageStatus,
} from '../types'

export interface TermDraft extends TermInput {
  key: string
}

export interface SectionState {
  language: Language
  saved: LanguageSection | null
  definition: string
  terms: TermDraft[]
  removed: boolean
}

export interface EntryState {
  conceptId: number | null
  isGlobal: boolean
  sections: SectionState[]
  savedDomainIds: number[]
  savedRevision: number | null
  domainIds: number[]
}

export type SectionProblem = 'empty_text' | 'duplicate_text' | 'second_preferred' | 'no_terms'

const TERM_FIELDS = [
  'text',
  'usage_status',
  'process_status',
  'status_reason',
  'context',
  'source',
  'part_of_speech',
  'case_sensitive',
] as const

const TEXT_FIELDS = ['text', 'status_reason', 'context', 'source'] as const

let nextKey = 1

export function newTerm(usageStatus: UsageStatus = 'admitted'): TermDraft {
  return {
    key: `n${nextKey++}`,
    id: null,
    text: '',
    usage_status: usageStatus,
    process_status: 'active',
    status_reason: '',
    context: '',
    source: '',
    part_of_speech: null,
    case_sensitive: false,
  }
}

function draftOf(term: ConceptTerm): TermDraft {
  return {
    key: `t${term.id}`,
    id: term.id,
    text: term.text,
    usage_status: term.usage_status,
    process_status: term.process_status,
    status_reason: term.status_reason,
    context: term.context,
    source: term.source,
    part_of_speech: term.part_of_speech,
    case_sensitive: term.case_sensitive,
  }
}

function sectionFromSaved(saved: LanguageSection): SectionState {
  return {
    language: saved.language,
    saved,
    definition: saved.definition,
    terms: saved.terms.map(draftOf),
    removed: false,
  }
}

function newSection(language: Language): SectionState {
  return { language, saved: null, definition: '', terms: [newTerm('preferred')], removed: false }
}

function linksFrom(concept: Concept) {
  return {
    savedDomainIds: [...concept.domain_ids],
    savedRevision: concept.revision,
    domainIds: [...concept.domain_ids],
  }
}

export function newEntry(domainId: number, isGlobal: boolean, language: Language): EntryState {
  return {
    conceptId: null,
    isGlobal,
    sections: [newSection(language)],
    savedDomainIds: [domainId],
    savedRevision: null,
    domainIds: [domainId],
  }
}

export function entryFromConcept(concept: Concept): EntryState {
  return {
    conceptId: concept.id,
    isGlobal: concept.is_global,
    sections: concept.sections.map(sectionFromSaved),
    ...linksFrom(concept),
  }
}

export function addLanguage(state: EntryState, language: Language): EntryState {
  return { ...state, sections: [...state.sections, newSection(language)] }
}

export function sectionChanges(section: SectionState): number {
  const { saved } = section
  if (section.removed) return saved ? 1 : 0
  const savedTerms = new Map((saved?.terms ?? []).map((t) => [t.id, t]))
  let count = section.definition === (saved?.definition ?? '') ? 0 : 1
  let matched = 0
  for (const draft of section.terms) {
    const before = draft.id == null ? undefined : savedTerms.get(draft.id)
    if (before) {
      matched += 1
      count += TERM_FIELDS.filter((field) => draft[field] !== before[field]).length
    } else if (TEXT_FIELDS.some((field) => (draft[field] ?? '').trim() !== '')) {
      count += 1
    }
  }
  return count + savedTerms.size - matched
}

function sameSet(a: number[], b: number[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((id) => right.has(id))
}

export function linksUnsaved(state: EntryState): boolean {
  return !sameSet(state.domainIds, state.savedDomainIds)
}

function isUnsaved(section: SectionState): boolean {
  return sectionChanges(section) > 0
}

export function unsavedLanguages(state: EntryState): Language[] {
  return state.sections.filter(isUnsaved).map((s) => s.language)
}

export function hasUnsaved(state: EntryState): boolean {
  return linksUnsaved(state) || state.sections.some(isUnsaved)
}

export function sectionProblems(section: SectionState): SectionProblem[] {
  if (section.removed) return []
  const problems: SectionProblem[] = []
  const texts = section.terms.map((t) => t.text)
  const filled = texts.filter((text) => text.trim() !== '')
  if (filled.length < texts.length) problems.push('empty_text')
  if (new Set(filled).size < filled.length) problems.push('duplicate_text')
  const activePreferred = section.terms.filter(
    (t) => t.usage_status === 'preferred' && t.process_status === 'active',
  )
  if (activePreferred.length > 1) problems.push('second_preferred')
  if (section.terms.length === 0) problems.push('no_terms')
  return problems
}

function termInput(draft: TermDraft): TermInput {
  return {
    id: draft.id,
    text: draft.text,
    usage_status: draft.usage_status,
    process_status: draft.process_status,
    status_reason: draft.status_reason,
    context: draft.context,
    source: draft.source,
    part_of_speech: draft.part_of_speech,
    case_sensitive: draft.case_sensitive,
  }
}

export function toSectionInput(section: SectionState): SectionInput {
  return {
    language: section.language,
    ...(section.saved ? { id: section.saved.id, revision: section.saved.revision } : {}),
    definition: section.definition,
    terms: section.removed ? [] : section.terms.map(termInput),
  }
}

export function withComment(comment: string): { comment?: string } {
  return comment.trim() ? { comment } : {}
}

export function saveAllBody(
  state: EntryState,
  comment: string,
): { sections: SectionInput[]; domain_ids?: number[]; revision?: number; comment?: string } {
  return {
    sections: state.sections.filter(isUnsaved).map(toSectionInput),
    ...(linksUnsaved(state)
      ? { domain_ids: [...state.domainIds], revision: state.savedRevision ?? undefined }
      : {}),
    ...withComment(comment),
  }
}

export function createBody(state: EntryState, comment: string): { sections: SectionInput[]; comment?: string } {
  return {
    sections: state.sections.filter(isUnsaved).map(toSectionInput),
    ...withComment(comment),
  }
}

function discarded(section: SectionState): SectionState[] {
  return section.saved ? [sectionFromSaved(section.saved)] : []
}

export function discardSection(state: EntryState, language: Language): EntryState {
  return {
    ...state,
    sections: state.sections.flatMap((s) => (s.language === language ? discarded(s) : [s])),
  }
}

export function discardAll(state: EntryState): EntryState {
  return {
    ...state,
    sections: state.sections.flatMap(discarded),
    domainIds: [...state.savedDomainIds],
  }
}

function linksAfter(state: EntryState, concept: Concept, sent: boolean) {
  if (sent || !linksUnsaved(state)) return linksFrom(concept)
  if (sameSet(concept.domain_ids, state.savedDomainIds)) {
    return { savedDomainIds: [...concept.domain_ids], savedRevision: concept.revision, domainIds: state.domainIds }
  }
  return { savedDomainIds: state.savedDomainIds, savedRevision: state.savedRevision, domainIds: state.domainIds }
}

function serverSection(concept: Concept, language: Language): SectionState[] {
  const found = concept.sections.find((s) => s.language === language)
  return found ? [sectionFromSaved(found)] : []
}

function withServerLanguages(sections: SectionState[], concept: Concept): SectionState[] {
  const known = new Set(sections.map((s) => s.language))
  return [...sections, ...concept.sections.filter((s) => !known.has(s.language)).map(sectionFromSaved)]
}

export function applySaved(
  state: EntryState,
  concept: Concept,
  sent: { languages: Language[]; links: boolean },
): EntryState {
  const kept = state.sections.flatMap((s) => {
    if (!sent.languages.includes(s.language) && isUnsaved(s)) return [s]
    const fresh = serverSection(concept, s.language)
    return fresh.length > 0 || s.saved ? fresh : [s]
  })
  return {
    ...state,
    conceptId: concept.id,
    isGlobal: concept.is_global,
    sections: withServerLanguages(kept, concept),
    ...linksAfter(state, concept, sent.links),
  }
}

export function reloadPart(state: EntryState, concept: Concept, part: Language | 'links'): EntryState {
  if (part === 'links') return { ...state, ...linksFrom(concept) }
  return applySaved(state, concept, { languages: [part], links: false })
}
