import { describe, expect, it } from 'vitest'
import type { Finding, Severity } from '../types'
import { countBySeverity, filterBySeverity, SEVERITIES } from './severity'

function finding(severity: Severity, id: string): Finding {
  return {
    id,
    category: 'style',
    severity,
    source: 'rule',
    rule_id: 'style.test',
    message: 'm',
    span: { start: 0, end: 1, text: 'x' },
    suggestions: [],
    advice: [],
  }
}

const FINDINGS = [
  finding('error', 'a'),
  finding('warning', 'b'),
  finding('warning', 'c'),
  finding('suggestion', 'd'),
]

describe('countBySeverity', () => {
  it('counts each severity, including zeroes', () => {
    expect(countBySeverity(FINDINGS)).toEqual({ error: 1, warning: 2, suggestion: 1 })
    expect(countBySeverity([])).toEqual({ error: 0, warning: 0, suggestion: 0 })
  })
})

describe('filterBySeverity', () => {
  it('returns everything without a filter', () => {
    expect(filterBySeverity(FINDINGS, null)).toEqual(FINDINGS)
  })

  it('keeps only the requested severity', () => {
    expect(filterBySeverity(FINDINGS, 'warning').map((f) => f.id)).toEqual(['b', 'c'])
  })
})

describe('SEVERITIES', () => {
  it('lists severities in display order', () => {
    expect(SEVERITIES).toEqual(['error', 'warning', 'suggestion'])
  })
})
