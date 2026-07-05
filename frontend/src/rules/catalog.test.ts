import { en } from '../i18n/en'
import { describe, expect, it } from 'vitest'
import type { RuleInfo } from '../types'
import { groupRulesByCategory, ruleDetailSummary } from './catalog'

function rule(overrides: Partial<RuleInfo>): RuleInfo {
  return {
    rule_id: 'style.example',
    language: 'en',
    category: 'style',
    level: 'warning',
    extends: 'existence',
    message: 'msg',
    requires_nlp: false,
    file: 'en/style/example.yml',
    detail: {},
    ...overrides,
  }
}

describe('ruleDetailSummary', () => {
  it('lists existence tokens and raw patterns', () => {
    expect(
      ruleDetailSummary(rule({ detail: { tokens: ['very', 'fairly'], raw: ['!{2,}'], ignorecase: true } }), en),
    ).toBe('Flags: very, fairly, /!{2,}/')
  })

  it('truncates long token lists', () => {
    const tokens = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(ruleDetailSummary(rule({ detail: { tokens, raw: [] } }), en)).toBe(
      'Flags: a, b, c, d, e, f … (8 total)',
    )
  })

  it('shows substitution swaps as arrows', () => {
    expect(
      ruleDetailSummary(rule({ extends: 'substitution', detail: { swap: { utilize: 'use' } } }), en),
    ).toBe('utilize → use')
  })

  it('describes match-count occurrence rules', () => {
    expect(
      ruleDetailSummary(rule({
          extends: 'occurrence',
          detail: { count: 'matches', token: ',', max: 3, min: null, scope: 'sentence' },
        }), en),
    ).toBe('More than 3 matches of /,/ per sentence')
  })

  it('describes token-count occurrence rules', () => {
    expect(
      ruleDetailSummary(rule({
          extends: 'occurrence',
          detail: { count: 'tokens', token: null, max: 50, min: null, scope: 'sentence' },
        }), en),
    ).toBe('More than 50 tokens per sentence')
  })

  it('describes repetition and pattern rules', () => {
    expect(ruleDetailSummary(rule({ extends: 'repetition' }), en)).toBe(
      'Adjacent repeated words',
    )
    expect(
      ruleDetailSummary(rule({ extends: 'token_pattern', detail: { pattern: [{}, {}], suggestions: [] } }), en),
    ).toBe('spaCy token pattern (2 tokens)')
    expect(
      ruleDetailSummary(rule({ extends: 'dependency', detail: { pattern: [{}, {}], suggestions: [] } }), en),
    ).toBe('spaCy dependency pattern (2 nodes)')
  })
})

describe('groupRulesByCategory', () => {
  it('groups in canonical category order', () => {
    const rules = [
      rule({ rule_id: 'clarity.a', category: 'clarity' }),
      rule({ rule_id: 'style.b', category: 'style' }),
      rule({ rule_id: 'style.a', category: 'style' }),
    ]
    const groups = groupRulesByCategory(rules)
    expect(groups.map((g) => g.category)).toEqual(['style', 'clarity'])
    expect(groups[0].rules.map((r) => r.rule_id)).toEqual(['style.a', 'style.b'])
  })
})
