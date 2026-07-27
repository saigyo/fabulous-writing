import { describe, expect, it } from 'vitest'
import {
  codePoints,
  craftScore,
  mechanicsScore,
  overallScore,
  scoreLevel,
  wordCount,
  type Scorecard,
  type ScoreSeverity,
} from './score'

function findings(errors: number, warnings: number, suggestions: number) {
  const make = (severity: ScoreSeverity, n: number) =>
    Array.from({ length: n }, () => ({ severity }))
  return [
    ...make('error', errors),
    ...make('warning', warnings),
    ...make('suggestion', suggestions),
  ]
}

function scorecard(scores: [number, number, number, number, number, number]): Scorecard {
  const [consistency, flow, clarity, vividness, tone, structure] = scores
  const dim = (score: number) => ({ score, note: '' })
  return {
    consistency: dim(consistency),
    flow: dim(flow),
    clarity: dim(clarity),
    vividness: dim(vividness),
    tone: dim(tone),
    structure: dim(structure),
  }
}

// Golden tests: the worked examples from docs/scoring.md, asserted verbatim.
describe('docs/scoring.md worked examples', () => {
  it('A: 200 words, 1 error + 4 warnings → 65', () => {
    expect(mechanicsScore(findings(1, 4, 0), 200)).toBe(65)
  })
  it('B: 200 words, 1 suggestion → 98', () => {
    expect(mechanicsScore(findings(0, 0, 1), 200)).toBe(98)
  })
  it('C: craft of [4,3,4,2,5,3] → 63 (half-up)', () => {
    expect(craftScore(scorecard([4, 3, 4, 2, 5, 3]))).toBe(63)
  })
  it('D: overall of mechanics 65 + craft 63 → 64', () => {
    expect(overallScore(65, 63)).toBe(64)
  })
  it('E: word counting', () => {
    expect(wordCount('Hello, world! 你好世界')).toBe(4)
    expect(wordCount("don't stop")).toBe(3)
  })
  it('F: under 40 words there is no score', () => {
    expect(mechanicsScore([], 39)).toBeNull()
    expect(mechanicsScore(findings(3, 0, 0), 39.5)).toBeNull()
  })
})

describe('wordCount', () => {
  it('counts letter/digit runs', () => {
    expect(wordCount('one two three')).toBe(3)
    expect(wordCount('state-of-the-art')).toBe(4)
    expect(wordCount('version 2 shipped')).toBe(3)
  })
  it('counts CJK characters as half words', () => {
    expect(wordCount('你好世界')).toBe(2)
    expect(wordCount('これはテストです')).toBe(4)
  })
  it('is 0 for empty and whitespace-only text', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('  \n\t ')).toBe(0)
  })
})

describe('codePoints', () => {
  it('counts astral characters (e.g. emoji) as one code point, not two UTF-16 units', () => {
    expect(codePoints('😀😀')).toBe(2)
  })
})

describe('mechanicsScore', () => {
  it('is 100 for a clean text', () => {
    expect(mechanicsScore([], 200)).toBe(100)
  })
  it('approaches but never goes below 0 under many errors', () => {
    const score = mechanicsScore(findings(100, 0, 0), 40)
    expect(score).toBe(0) // e^(-1250/15) rounds to 0
  })
  it('scores exactly 40 words (boundary is inclusive)', () => {
    expect(mechanicsScore([], 40)).toBe(100)
  })
})

describe('craftScore', () => {
  it('maps all 1s to 0, all 3s to 50, all 5s to 100', () => {
    expect(craftScore(scorecard([1, 1, 1, 1, 1, 1]))).toBe(0)
    expect(craftScore(scorecard([3, 3, 3, 3, 3, 3]))).toBe(50)
    expect(craftScore(scorecard([5, 5, 5, 5, 5, 5]))).toBe(100)
  })
})

describe('overallScore', () => {
  it('returns mechanics unchanged when craft is null', () => {
    expect(overallScore(87, null)).toBe(87)
  })
})

describe('scoreLevel', () => {
  it('maps the documented thresholds', () => {
    expect(scoreLevel(0)).toBe('low')
    expect(scoreLevel(49)).toBe('low')
    expect(scoreLevel(50)).toBe('mid')
    expect(scoreLevel(79)).toBe('mid')
    expect(scoreLevel(80)).toBe('high')
    expect(scoreLevel(100)).toBe('high')
  })
})
