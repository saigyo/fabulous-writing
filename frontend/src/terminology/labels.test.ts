import { describe, expect, it } from 'vitest'
import type { Concept, ConceptTerm, Language, LanguageSection, ProcessStatus, UsageStatus } from '../types'
import { conceptLabel, conceptLanguages, matchesQuery, otherWordings, sortByLabel } from './labels'

const ORDER: Language[] = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh']

let nextId = 1
function term(
  text: string,
  usage: UsageStatus = 'admitted',
  process: ProcessStatus = 'active',
): ConceptTerm {
  return {
    id: nextId++,
    uid: `t${nextId}`,
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

describe('conceptLabel', () => {
  it('prefers the active preferred term', () => {
    const c = concept(section('en', [term('apple'), term('pomme', 'preferred'), term('zebra', 'forbidden')]))
    expect(conceptLabel(c, 'en', ORDER)).toEqual({ text: 'pomme', language: 'en', fallback: false })
  })

  it('skips a candidate preferred term in favour of an active admitted term', () => {
    const c = concept(section('en', [term('alpha', 'preferred', 'candidate'), term('beta', 'admitted')]))
    expect(conceptLabel(c, 'en', ORDER).text).toBe('beta')
  })

  it('takes the first admitted term alphabetically, ignoring case and accents of base letters', () => {
    const c = concept(section('en', [term('Zeta'), term('beta'), term('Alpha')]))
    expect(conceptLabel(c, 'en', ORDER).text).toBe('Alpha')
  })

  it('takes the first term alphabetically when there are only forbidden terms', () => {
    const c = concept(section('en', [term('yyy', 'forbidden'), term('bbb', 'forbidden')]))
    expect(conceptLabel(c, 'en', ORDER)).toEqual({ text: 'bbb', language: 'en', fallback: false })
  })

  it('falls back to the first other language in the given order and marks it', () => {
    const c = concept(section('zh', [term('苹果')]), section('fr', [term('pomme')]))
    expect(conceptLabel(c, 'en', ORDER)).toEqual({ text: 'pomme', language: 'fr', fallback: true })
  })

  it('puts languages missing from the order after the listed ones', () => {
    const c = concept(section('ja', [term('りんご')]), section('de', [term('Apfel')]))
    expect(conceptLabel(c, 'en', ['de'])).toEqual({ text: 'Apfel', language: 'de', fallback: true })
    expect(conceptLabel(c, 'en', [])).toEqual({ text: 'りんご', language: 'ja', fallback: true })
  })
})

describe('otherWordings', () => {
  it('leaves out exactly the label term and orders by status then text', () => {
    const label = term('main', 'preferred')
    const c = concept(
      section('en', [term('zz', 'forbidden'), term('b', 'admitted'), label, term('a', 'admitted'), term('d', 'deprecated')]),
    )
    expect(otherWordings(c, 'en').map((t) => t.text)).toEqual(['a', 'b', 'd', 'zz'])
  })

  it('is empty for a fallback label', () => {
    const c = concept(section('fr', [term('pomme'), term('fruit')]))
    expect(otherWordings(c, 'en')).toEqual([])
  })
})

describe('conceptLanguages', () => {
  it('lists languages with terms in the given order', () => {
    const c = concept(section('zh', [term('a')]), section('de', [term('b')]), section('fr', []))
    expect(conceptLanguages(c, ORDER)).toEqual(['de', 'zh'])
  })
})

describe('matchesQuery', () => {
  const c = concept(section('en', [term('Apple')]), section('de', [term('Apfel')]))

  it('finds a wording of another language', () => {
    expect(matchesQuery(c, 'apf')).toBe(true)
  })
  it('ignores case', () => {
    expect(matchesQuery(c, 'APPLE')).toBe(true)
  })
  it('accepts a blank query', () => {
    expect(matchesQuery(c, '   ')).toBe(true)
  })
  it('rejects text that is in no wording', () => {
    expect(matchesQuery(c, 'banana')).toBe(false)
  })
})

describe('sortByLabel', () => {
  it('sorts by label without mutating its input', () => {
    const b = concept(section('en', [term('banana')]))
    const a = concept(section('en', [term('apple')]))
    const input = [b, a]
    const sorted = sortByLabel(input, 'en', ORDER)
    expect(sorted).toEqual([a, b])
    expect(input).toEqual([b, a])
  })
})
