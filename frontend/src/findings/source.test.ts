import { describe, expect, it } from 'vitest'
import type { Finding, Source } from '../types'
import { countBySourceGroup, filterBySourceGroup, SOURCE_GROUPS, sourceGroupOf } from './source'

function finding(source: Source, id: string): Finding {
  return {
    id,
    category: 'style',
    severity: 'warning',
    source,
    rule_id: source === 'llm' ? null : 'style.test',
    message: 'm',
    span: { start: 0, end: 1, text: 'x' },
    suggestions: [],
    advice: [],
  }
}

const FINDINGS = [
  finding('rule', 'a'),
  finding('terminology', 'b'),
  finding('llm', 'c'),
  finding('llm', 'd'),
]

describe('sourceGroupOf', () => {
  it('groups terminology findings with rule findings', () => {
    expect(sourceGroupOf('rule')).toBe('rule')
    expect(sourceGroupOf('terminology')).toBe('rule')
    expect(sourceGroupOf('llm')).toBe('llm')
  })
})

describe('countBySourceGroup', () => {
  it('counts each group, including zeroes', () => {
    expect(countBySourceGroup(FINDINGS)).toEqual({ rule: 2, llm: 2 })
    expect(countBySourceGroup([])).toEqual({ rule: 0, llm: 0 })
  })
})

describe('filterBySourceGroup', () => {
  it('returns everything without a filter', () => {
    expect(filterBySourceGroup(FINDINGS, null)).toEqual(FINDINGS)
  })

  it('keeps rule and terminology findings for the rule group', () => {
    expect(filterBySourceGroup(FINDINGS, 'rule').map((f) => f.id)).toEqual(['a', 'b'])
  })

  it('keeps only LLM findings for the llm group', () => {
    expect(filterBySourceGroup(FINDINGS, 'llm').map((f) => f.id)).toEqual(['c', 'd'])
  })
})

describe('SOURCE_GROUPS', () => {
  it('lists groups in display order', () => {
    expect(SOURCE_GROUPS).toEqual(['rule', 'llm'])
  })
})
