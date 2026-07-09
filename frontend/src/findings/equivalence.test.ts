import { describe, expect, it } from 'vitest'
import type { TrackedFinding } from '../editor/findings'
import type { Finding } from '../types'
import { findEquivalent, mapEquivalentIds } from './equivalence'

function tracked(
  id: string,
  from: number,
  to: number,
  text: string,
  rule_id = 'style.test',
): TrackedFinding {
  const finding: Finding = {
    id,
    category: 'style',
    severity: 'warning',
    source: 'rule',
    rule_id,
    message: 'm',
    span: { start: from, end: to, text },
    suggestions: [],
    advice: [],
  }
  return { finding, from, to }
}

describe('findEquivalent', () => {
  it('matches same category, rule, text, and overlapping span', () => {
    const previous = tracked('old', 8, 12, 'very')
    const match = findEquivalent([tracked('new', 8, 12, 'very')], previous)
    expect(match?.finding.id).toBe('new')
  })

  it('rejects different rule or text or disjoint spans', () => {
    const previous = tracked('old', 8, 12, 'very')
    expect(findEquivalent([tracked('a', 8, 12, 'very', 'style.other')], previous)).toBeNull()
    expect(findEquivalent([tracked('b', 8, 12, 'much')], previous)).toBeNull()
    expect(findEquivalent([tracked('c', 20, 24, 'very')], previous)).toBeNull()
  })

  it('prefers the nearest candidate', () => {
    const previous = tracked('old', 10, 14, 'very')
    const match = findEquivalent(
      [tracked('far', 5, 15, 'very'), tracked('near', 10, 14, 'very')],
      previous,
    )
    expect(match?.finding.id).toBe('near')
  })
})

describe('mapEquivalentIds', () => {
  it('maps every old finding to its replacement and skips unmatched ones', () => {
    const old = [tracked('o1', 0, 4, 'very'), tracked('o2', 10, 14, 'good')]
    const next = [tracked('n1', 0, 4, 'very')]
    expect(mapEquivalentIds(old, next)).toEqual({ o1: 'n1' })
  })

  it('does not map two old findings onto the same new one', () => {
    const old = [tracked('o1', 0, 4, 'very'), tracked('o2', 2, 6, 'very')]
    const next = [tracked('n1', 0, 4, 'very')]
    const map = mapEquivalentIds(old, next)
    expect(Object.values(map)).toEqual(['n1'])
  })

  it('keeps unchanged ids as identity', () => {
    const same = tracked('keep', 0, 4, 'very')
    expect(mapEquivalentIds([same], [same])).toEqual({ keep: 'keep' })
  })
})
