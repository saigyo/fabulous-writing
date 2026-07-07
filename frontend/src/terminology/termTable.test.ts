import { describe, expect, test } from 'vitest'
import type { Term } from '../types'
import {
  draftToTermPayload,
  filterTerms,
  parseVariants,
  sortTerms,
  termToDraft,
  toggleSort,
  type SortCriterion,
  type TermDraft,
} from './termTable'

function term(overrides: Partial<Term> & { id: number }): Term {
  return {
    domain_id: 1,
    language: 'en',
    preferred: 'sign in',
    forbidden_variants: ['login'],
    definition: '',
    case_sensitive: false,
    ...overrides,
  }
}

const terms: Term[] = [
  term({ id: 1, language: 'de', preferred: 'Anwendung', forbidden_variants: ['App'] }),
  term({ id: 2, language: 'en', preferred: 'sign in', forbidden_variants: ['login', 'log-in'] }),
  term({ id: 3, language: 'en', preferred: 'email', forbidden_variants: ['e-mail'], definition: 'electronic mail' }),
  term({ id: 4, language: 'fr', preferred: 'courriel', forbidden_variants: ['mél'] }),
]

describe('toggleSort', () => {
  test('adds an ascending criterion for a new key', () => {
    expect(toggleSort([], 'language')).toEqual([{ key: 'language', direction: 'asc' }])
  })

  test('flips ascending to descending in place', () => {
    const criteria: SortCriterion[] = [
      { key: 'language', direction: 'asc' },
      { key: 'preferred', direction: 'asc' },
    ]
    expect(toggleSort(criteria, 'language')).toEqual([
      { key: 'language', direction: 'desc' },
      { key: 'preferred', direction: 'asc' },
    ])
  })

  test('removes a descending criterion', () => {
    const criteria: SortCriterion[] = [
      { key: 'language', direction: 'desc' },
      { key: 'preferred', direction: 'asc' },
    ]
    expect(toggleSort(criteria, 'language')).toEqual([
      { key: 'preferred', direction: 'asc' },
    ])
  })

  test('appends secondary criteria after existing ones', () => {
    expect(toggleSort([{ key: 'language', direction: 'asc' }], 'preferred')).toEqual([
      { key: 'language', direction: 'asc' },
      { key: 'preferred', direction: 'asc' },
    ])
  })
})

describe('sortTerms', () => {
  test('no criteria keeps the original order', () => {
    expect(sortTerms(terms, []).map((t) => t.id)).toEqual([1, 2, 3, 4])
  })

  test('sorts ascending by preferred, case-insensitively', () => {
    expect(sortTerms(terms, [{ key: 'preferred', direction: 'asc' }]).map((t) => t.id)).toEqual([
      1, 4, 3, 2,
    ])
  })

  test('sorts descending by language', () => {
    expect(sortTerms(terms, [{ key: 'language', direction: 'desc' }]).map((t) => t.id)).toEqual([
      4, 2, 3, 1,
    ])
  })

  test('sorts by forbidden variants (joined)', () => {
    expect(sortTerms(terms, [{ key: 'forbidden', direction: 'asc' }]).map((t) => t.id)).toEqual([
      1, 3, 2, 4,
    ])
  })

  test('applies criteria in order: language asc, then preferred desc', () => {
    const criteria: SortCriterion[] = [
      { key: 'language', direction: 'asc' },
      { key: 'preferred', direction: 'desc' },
    ]
    expect(sortTerms(terms, criteria).map((t) => t.id)).toEqual([1, 2, 3, 4])
  })

  test('does not mutate the input', () => {
    const input = [...terms]
    sortTerms(input, [{ key: 'preferred', direction: 'asc' }])
    expect(input.map((t) => t.id)).toEqual([1, 2, 3, 4])
  })
})

describe('filterTerms', () => {
  test('filters by language', () => {
    expect(filterTerms(terms, 'en', '').map((t) => t.id)).toEqual([2, 3])
  })

  test('null language keeps all terms', () => {
    expect(filterTerms(terms, null, '')).toHaveLength(4)
  })

  test('search matches the preferred term, case-insensitively', () => {
    expect(filterTerms(terms, null, 'SIGN').map((t) => t.id)).toEqual([2])
  })

  test('search matches forbidden variants and definitions', () => {
    expect(filterTerms(terms, null, 'log-in').map((t) => t.id)).toEqual([2])
    expect(filterTerms(terms, null, 'electronic').map((t) => t.id)).toEqual([3])
  })

  test('search and language filter combine', () => {
    expect(filterTerms(terms, 'de', 'app').map((t) => t.id)).toEqual([1])
    expect(filterTerms(terms, 'fr', 'app')).toHaveLength(0)
  })

  test('whitespace-only query keeps all terms', () => {
    expect(filterTerms(terms, null, '   ')).toHaveLength(4)
  })
})

describe('parseVariants', () => {
  test('splits on commas and trims', () => {
    expect(parseVariants(' login,  log-in ,sign-on')).toEqual(['login', 'log-in', 'sign-on'])
  })

  test('drops empty entries', () => {
    expect(parseVariants('login,, ,')).toEqual(['login'])
    expect(parseVariants('')).toEqual([])
  })
})

describe('termToDraft', () => {
  test('joins variants with a comma and space', () => {
    const draft = termToDraft(
      term({
        id: 7,
        language: 'de',
        preferred: 'Anwendung',
        forbidden_variants: ['App', 'Applikation'],
        definition: 'Software',
        case_sensitive: true,
      }),
    )
    expect(draft).toEqual({
      language: 'de',
      preferred: 'Anwendung',
      variants: 'App, Applikation',
      definition: 'Software',
      caseSensitive: true,
    })
  })
})

describe('draftToTermPayload', () => {
  const draft: TermDraft = {
    language: 'en',
    preferred: '  sign in ',
    variants: 'login, log-in',
    definition: ' authenticate ',
    caseSensitive: false,
  }

  test('trims fields and parses variants', () => {
    expect(draftToTermPayload(draft)).toEqual({
      language: 'en',
      preferred: 'sign in',
      forbidden_variants: ['login', 'log-in'],
      definition: 'authenticate',
      case_sensitive: false,
    })
  })

  test('returns null when preferred is empty', () => {
    expect(draftToTermPayload({ ...draft, preferred: '   ' })).toBeNull()
  })

  test('round-trips a term through draft and payload', () => {
    const original = term({ id: 9, preferred: 'email', forbidden_variants: ['e-mail', 'E-Mail'] })
    expect(draftToTermPayload(termToDraft(original))).toEqual({
      language: original.language,
      preferred: original.preferred,
      forbidden_variants: original.forbidden_variants,
      definition: original.definition,
      case_sensitive: original.case_sensitive,
    })
  })
})
