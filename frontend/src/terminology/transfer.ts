import type { HttpError } from '../api/client'
import type { Messages } from '../i18n'
import type {
  Concept,
  ConceptTerm,
  Language,
  MovedTerm,
  TransferOutcome,
  UsageStatus,
} from '../types'
import {
  USAGE_RANK,
  conceptLabel,
  conceptLanguages,
  matchesQuery,
  otherWordings,
  sortByLabel,
  type ConceptLabel,
} from './labels'

export function suggest(
  candidates: Concept[],
  query: string,
  language: Language,
  order: Language[],
): Concept[] {
  const sorted = sortByLabel(candidates, language, order)
  const q = query.trim().toLowerCase()
  if (q === '') return sorted
  const matching = sorted.filter((c) => matchesQuery(c, q))
  const starts = (c: Concept) => conceptLabel(c, language, order).text.toLowerCase().startsWith(q)
  return [...matching.filter(starts), ...matching.filter((c) => !starts(c))]
}

export function suggestionRow(
  concept: Concept,
  language: Language,
  order: Language[],
): { label: ConceptLabel; others: ConceptTerm[]; languages: Language[] } {
  const label = conceptLabel(concept, language, order)
  return {
    label,
    others: otherWordings(concept, label.language),
    languages: conceptLanguages(concept, order),
  }
}

export function highlight(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [{ text, match: false }]
  const lower = text.toLowerCase()
  const parts: { text: string; match: boolean }[] = []
  let from = 0
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false })
    parts.push({ text: text.slice(at, at + q.length), match: true })
    from = at + q.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false })
  return parts.length > 0 ? parts : [{ text, match: false }]
}

export interface ResultRow {
  language: Language
  terms: { term: ConceptTerm; incoming: boolean }[]
  demoted: string[]
}

function isDemotion(m: MovedTerm): boolean {
  return m.usage_before === 'preferred' && m.usage_after === 'admitted'
}

export function resultRows(outcome: TransferOutcome, order: Language[]): ResultRow[] {
  const incoming = new Set(outcome.moved.map((m) => m.id))
  return conceptLanguages(outcome.target, order).map((language) => {
    const section = outcome.target.sections.find((s) => s.language === language)!
    return {
      language,
      terms: [...section.terms]
        .sort((a, b) => USAGE_RANK[a.usage_status] - USAGE_RANK[b.usage_status] || a.id - b.id)
        .map((term) => ({ term, incoming: incoming.has(term.id) })),
      demoted: outcome.moved.filter((m) => m.language === language && isDemotion(m)).map((m) => m.text),
    }
  })
}

/** A preview is only usable when the server computed it from the source as the entry holds it. */
export function sourceIsCurrent(source: Concept, outcome: TransferOutcome): boolean {
  const basis = outcome.basis.source
  if (basis.concept_id !== source.id || basis.revision !== source.revision) return false
  if (basis.sections.length !== source.sections.length) return false
  const held = new Map(source.sections.map((s) => [s.id, s.revision]))
  return basis.sections.every((s) => held.get(s.id) === s.revision)
}

export type Notice =
  | { kind: 'droppedTerm'; text: string; language: Language; usageStatus: UsageStatus }
  | { kind: 'droppedDefinition'; language: Language; definition: string }
  | { kind: 'droppedDomain'; name: string }
  | { kind: 'addedDomain'; name: string }
  | { kind: 'demoted'; text: string }
  | { kind: 'lostLanguage'; language: Language; definition: string | null }
  | { kind: 'sourceDeleted' }

export function notices(outcome: TransferOutcome, kind: 'merge' | 'move'): Notice[] {
  const droppedDefinitions = (skip: Set<Language>): Notice[] =>
    outcome.dropped_definitions
      .filter((d) => !skip.has(d.language))
      .map((d) => ({ kind: 'droppedDefinition', language: d.language, definition: d.definition }))
  const droppedDomains: Notice[] = outcome.dropped_domains.map((d) => ({
    kind: 'droppedDomain',
    name: d.name,
  }))

  if (kind === 'merge') {
    const droppedTerms: Notice[] = outcome.dropped_terms.map((t) => ({
      kind: 'droppedTerm',
      text: t.text,
      language: t.language,
      usageStatus: t.usage_status,
    }))
    return [...droppedTerms, ...droppedDefinitions(new Set()), ...droppedDomains]
  }

  const lost = new Set(outcome.removed_languages)
  const demoted: Notice[] = outcome.moved
    .filter(isDemotion)
    .map((m) => ({ kind: 'demoted', text: m.text }))
  const lostLanguages: Notice[] = outcome.removed_languages.map((language) => ({
    kind: 'lostLanguage',
    language,
    definition: outcome.dropped_definitions.find((d) => d.language === language)?.definition ?? null,
  }))
  const addedDomains: Notice[] = outcome.added_domains.map((d) => ({
    kind: 'addedDomain',
    name: d.name,
  }))
  const sourceDeleted: Notice[] = outcome.source === null ? [{ kind: 'sourceDeleted' }] : []
  return [
    ...demoted,
    ...lostLanguages,
    ...droppedDefinitions(lost),
    ...droppedDomains,
    ...addedDomains,
    ...sourceDeleted,
  ]
}

/** The server's own sentence of a refusal (`detailMessage`), else the generic one, inside the translated frame. */
export const messageOf = (error: HttpError, m: Pick<Messages, 'changeFailed'>) =>
  m.changeFailed(error.detailMessage ?? error.message)
