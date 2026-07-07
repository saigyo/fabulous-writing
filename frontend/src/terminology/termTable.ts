import type { Language, Term } from '../types'

export type SortKey = 'language' | 'preferred' | 'forbidden'
export type SortDirection = 'asc' | 'desc'

export interface SortCriterion {
  key: SortKey
  direction: SortDirection
}

// Click cycle per header: off → ascending → descending → off. Clicking a new
// header appends a criterion, so click order defines sort priority.
export function toggleSort(criteria: SortCriterion[], key: SortKey): SortCriterion[] {
  const existing = criteria.find((c) => c.key === key)
  if (!existing) return [...criteria, { key, direction: 'asc' }]
  if (existing.direction === 'asc') {
    return criteria.map((c) => (c.key === key ? { key, direction: 'desc' } : c))
  }
  return criteria.filter((c) => c.key !== key)
}

const sortValue: Record<SortKey, (term: Term) => string> = {
  language: (term) => term.language,
  preferred: (term) => term.preferred,
  forbidden: (term) => term.forbidden_variants.join(', '),
}

export function sortTerms(terms: Term[], criteria: SortCriterion[]): Term[] {
  if (criteria.length === 0) return terms
  return [...terms].sort((a, b) => {
    for (const { key, direction } of criteria) {
      const delta = sortValue[key](a).localeCompare(sortValue[key](b), undefined, {
        sensitivity: 'base',
      })
      if (delta !== 0) return direction === 'asc' ? delta : -delta
    }
    return 0
  })
}

// Draft of a term as authored in the table's input widgets: forbidden
// variants are one comma-separated string, exactly like the add-term row.
export interface TermDraft {
  language: Language
  preferred: string
  variants: string
  definition: string
  caseSensitive: boolean
}

export function parseVariants(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

export function termToDraft(term: Term): TermDraft {
  return {
    language: term.language,
    preferred: term.preferred,
    variants: term.forbidden_variants.join(', '),
    definition: term.definition,
    caseSensitive: term.case_sensitive,
  }
}

/** Trimmed create/update payload, or null when the preferred term is empty. */
export function draftToTermPayload(
  draft: TermDraft,
): Omit<Term, 'id' | 'domain_id'> | null {
  const preferred = draft.preferred.trim()
  if (!preferred) return null
  return {
    language: draft.language,
    preferred,
    forbidden_variants: parseVariants(draft.variants),
    definition: draft.definition.trim(),
    case_sensitive: draft.caseSensitive,
  }
}

export function filterTerms(
  terms: Term[],
  language: Language | null,
  query: string,
): Term[] {
  const needle = query.trim().toLowerCase()
  return terms.filter((term) => {
    if (language !== null && term.language !== language) return false
    if (needle === '') return true
    const haystack = [
      term.language,
      term.preferred,
      ...term.forbidden_variants,
      term.definition,
    ]
    return haystack.some((field) => field.toLowerCase().includes(needle))
  })
}
