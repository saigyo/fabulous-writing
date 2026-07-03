import { describe, expect, it } from 'vitest'
import type { Finding } from '../types'
import { groupByCategory } from './group'

function finding(id: string, category: Finding['category'], start = 0): Finding {
  return {
    id,
    category,
    severity: 'warning',
    source: 'rule',
    rule_id: null,
    message: 'm',
    span: { start, end: start + 1, text: 'x' },
    suggestions: [],
  }
}

describe('groupByCategory', () => {
  it('groups findings and orders categories canonically', () => {
    const groups = groupByCategory([
      finding('a', 'style', 5),
      finding('b', 'grammar', 2),
      finding('c', 'style', 1),
    ])
    expect(groups.map((g) => g.category)).toEqual(['grammar', 'style'])
    expect(groups[1].findings.map((f) => f.id)).toEqual(['c', 'a'])
  })

  it('sorts findings within a category by position', () => {
    const groups = groupByCategory([finding('late', 'style', 9), finding('early', 'style', 3)])
    expect(groups[0].findings.map((f) => f.id)).toEqual(['early', 'late'])
  })

  it('returns empty list for no findings', () => {
    expect(groupByCategory([])).toEqual([])
  })
})
