import { describe, expect, it } from 'vitest'
import type { MarkingSpan } from '../embed/protocol'
import { findingIdAt } from './clickHitTest'

function span(id: string, from: number, to: number): MarkingSpan {
  return { id, from, to, severity: 'warning', category: 'style' }
}

describe('findingIdAt', () => {
  const sentence = span('sentence', 0, 60)
  const inner = span('inner', 0, 10)
  const other = span('other', 45, 50)

  it('returns null when no finding covers the position', () => {
    expect(findingIdAt([inner], null, 30)).toBeNull()
  })

  // Copilot round 3: main.ts previously used Array.find over source-order
  // spans, so the outer (sentence) span shadowed the nested (inner) one at
  // any position they both cover — the nested span was never selectable.
  it('picks the smallest finding under the position, not the sentence', () => {
    expect(findingIdAt([sentence, inner, other], null, 5)).toBe('inner')
  })

  it('cycles outward through stacked findings on repeated clicks', () => {
    expect(findingIdAt([sentence, inner], null, 5)).toBe('inner')
    expect(findingIdAt([sentence, inner], 'inner', 5)).toBe('sentence')
    expect(findingIdAt([sentence, inner], 'sentence', 5)).toBe('inner')
  })

  it('ignores a selected finding elsewhere and picks the smallest hit', () => {
    expect(findingIdAt([sentence, inner, other], 'other', 5)).toBe('inner')
  })
})
