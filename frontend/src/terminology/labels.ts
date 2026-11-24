import type { Concept, ConceptTerm, Language, LanguageSection, UsageStatus } from '../types'

export interface ConceptLabel {
  text: string
  language: Language
  fallback: boolean
}

const USAGE_RANK: Record<UsageStatus, number> = {
  preferred: 0,
  admitted: 1,
  deprecated: 2,
  forbidden: 3,
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)
}

function first(terms: ConceptTerm[]): ConceptTerm | undefined {
  return terms.reduce<ConceptTerm | undefined>(
    (best, t) => (best === undefined || compareText(t.text, best.text) < 0 ? t : best),
    undefined,
  )
}

function labelTerm(section: LanguageSection): ConceptTerm | undefined {
  const active = section.terms.filter((t) => t.process_status === 'active')
  return (
    first(active.filter((t) => t.usage_status === 'preferred')) ??
    first(active.filter((t) => t.usage_status === 'admitted')) ??
    first(section.terms)
  )
}

function orderRank(language: Language, order: Language[]): number {
  const i = order.indexOf(language)
  return i === -1 ? order.length : i
}

export function conceptLanguages(concept: Concept, order: Language[]): Language[] {
  return concept.sections
    .filter((s) => s.terms.length > 0)
    .map((s) => s.language)
    .map((language, index) => ({ language, index }))
    .sort((a, b) => orderRank(a.language, order) - orderRank(b.language, order) || a.index - b.index)
    .map((x) => x.language)
}

function resolve(
  concept: Concept,
  language: Language,
  order: Language[],
): { term: ConceptTerm; language: Language; fallback: boolean } | undefined {
  const own = concept.sections.find((s) => s.language === language)
  const ownTerm = own && labelTerm(own)
  if (ownTerm) return { term: ownTerm, language, fallback: false }
  for (const other of conceptLanguages(concept, order)) {
    if (other === language) continue
    const section = concept.sections.find((s) => s.language === other)
    const term = section && labelTerm(section)
    if (term) return { term, language: other, fallback: true }
  }
  return undefined
}

export function conceptLabel(concept: Concept, language: Language, order: Language[]): ConceptLabel {
  const found = resolve(concept, language, order)
  if (!found) return { text: '', language, fallback: false }
  return { text: found.term.text, language: found.language, fallback: found.fallback }
}

export function otherWordings(concept: Concept, language: Language): ConceptTerm[] {
  const section = concept.sections.find((s) => s.language === language)
  if (!section) return []
  const label = labelTerm(section)
  if (!label) return []
  return section.terms
    .filter((t) => t !== label)
    .sort((a, b) => USAGE_RANK[a.usage_status] - USAGE_RANK[b.usage_status] || compareText(a.text, b.text))
}

export function matchesQuery(concept: Concept, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return concept.sections.some((s) => s.terms.some((t) => t.text.toLowerCase().includes(q)))
}

export function sortByLabel(concepts: Concept[], language: Language, order: Language[]): Concept[] {
  const labels = new Map(concepts.map((c) => [c, conceptLabel(c, language, order).text]))
  return [...concepts].sort((a, b) => compareText(labels.get(a)!, labels.get(b)!))
}
