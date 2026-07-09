import { describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import { heldBackReason, noReliableSuggestionMessage } from './vetMessage'

describe('noReliableSuggestionMessage', () => {
  it('is null when suggestions exist or nothing was rejected', () => {
    expect(noReliableSuggestionMessage(['fix'], 2, en)).toBeNull()
    expect(noReliableSuggestionMessage([], 0, en)).toBeNull()
  })

  it('explains rejected candidates, with singular and plural', () => {
    expect(noReliableSuggestionMessage([], 1, en)).toBe(
      'No reliable suggestion — 1 candidate failed local checks.',
    )
    expect(noReliableSuggestionMessage([], 3, en)).toBe(
      'No reliable suggestion — 3 candidates failed local checks.',
    )
  })
})

describe('heldBackReason', () => {
  it('formats a rules reason from rule ids', () => {
    expect(
      heldBackReason(
        { text: 'x', reason_kind: 'rules', rule_ids: ['a.b', 'c.d'], words: [] },
        en,
      ),
    ).toBe(en.heldBackRules('a.b, c.d'))
  })

  it('formats a spelling reason from words', () => {
    expect(
      heldBackReason(
        { text: 'x', reason_kind: 'spelling', rule_ids: [], words: ['empföhle'] },
        en,
      ),
    ).toBe(en.heldBackSpelling('empföhle'))
  })
})
