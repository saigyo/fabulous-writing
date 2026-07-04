import { describe, expect, it } from 'vitest'
import { noReliableSuggestionMessage } from './vetMessage'

describe('noReliableSuggestionMessage', () => {
  it('is null when suggestions exist or nothing was rejected', () => {
    expect(noReliableSuggestionMessage(['fix'], 2)).toBeNull()
    expect(noReliableSuggestionMessage([], 0)).toBeNull()
  })

  it('explains rejected candidates, with singular and plural', () => {
    expect(noReliableSuggestionMessage([], 1)).toBe(
      'No reliable suggestion — 1 candidate failed local checks.',
    )
    expect(noReliableSuggestionMessage([], 3)).toBe(
      'No reliable suggestion — 3 candidates failed local checks.',
    )
  })
})
