import { describe, expect, it } from 'vitest'
import type { Finding } from '../types'
import { effectiveSuggestions } from './suggestions'

function finding(id: string, suggestions: string[]): Finding {
  return {
    id,
    category: 'style',
    severity: 'warning',
    source: 'rule',
    rule_id: null,
    message: 'm',
    span: { start: 0, end: 1, text: 'x' },
    suggestions,
    advice: [],
  }
}

describe('effectiveSuggestions', () => {
  it('prefers native suggestions', () => {
    expect(
      effectiveSuggestions(finding('a', ['native']), { a: ['fetched'] }),
    ).toEqual(['native'])
  })

  it('falls back to fetched extras', () => {
    expect(effectiveSuggestions(finding('a', []), { a: ['fetched'] })).toEqual([
      'fetched',
    ])
  })

  it('returns empty when neither exists', () => {
    expect(effectiveSuggestions(finding('a', []), {})).toEqual([])
  })
})
