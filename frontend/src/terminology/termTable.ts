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
