import { describe, expect, it } from 'vitest'
import type { Finding } from '../types'
import { convertFindingOffsets, toCodePointSpan } from './offsets'

function finding(start: number, end: number, text: string): Finding {
  return {
    id: 'x', category: 'spelling', severity: 'error', source: 'rule',
    rule_id: null, message: 'm', span: { start, end, text },
    suggestions: [], advice: [],
  }
}

describe('convertFindingOffsets', () => {
  it('is identity for BMP-only text', () => {
    const [f] = convertFindingOffsets('hello world', [finding(6, 11, 'world')])
    expect(f.span).toEqual({ start: 6, end: 11, text: 'world' })
  })

  it('shifts spans after astral characters', () => {
    // '𝔸' is one code point but two UTF-16 units. Code points: 𝔸=0, space=1, bad=2..5
    const text = '𝔸 bad'
    const [f] = convertFindingOffsets(text, [finding(2, 5, 'bad')])
    expect(f.span.start).toBe(3)
    expect(f.span.end).toBe(6)
    expect(text.slice(f.span.start, f.span.end)).toBe('bad')
  })

  it('drops findings whose converted span text does not match', () => {
    expect(convertFindingOffsets('abc', [finding(0, 2, 'zz')])).toEqual([])
  })
})

describe('toCodePointSpan', () => {
  it('is identity for BMP-only text', () => {
    expect(toCodePointSpan('hello', 1, 3)).toEqual({ start: 1, end: 3 })
  })

  it('inverts convertFindingOffsets across astral text', () => {
    const text = '𝔸 bad'
    // UTF-16 [3,6) is 'bad'; code points [2,5)
    expect(toCodePointSpan(text, 3, 6)).toEqual({ start: 2, end: 5 })
  })
})
