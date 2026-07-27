/**
 * Fabulous Writing quality score — reference implementation of scoring v1.
 *
 * NORMATIVE SPEC: docs/scoring.md. The golden tests in score.test.ts assert
 * that document's worked examples verbatim; change formula and doc together
 * (and bump SCORING_VERSION).
 *
 * This module is deliberately framework-free (no React/zustand/CodeMirror/app
 * imports) so any TypeScript client can reuse it unchanged.
 */

export const SCORING_VERSION = 1

export type ScoreSeverity = 'error' | 'warning' | 'suggestion'

export interface ScoreDimension {
  score: number
  note: string
}

export const DIMENSIONS = [
  'consistency',
  'flow',
  'clarity',
  'vividness',
  'tone',
  'structure',
] as const

export type Dimension = (typeof DIMENSIONS)[number]

export type Scorecard = Record<Dimension, ScoreDimension>

export const SEVERITY_POINTS: Record<ScoreSeverity, number> = {
  error: 5,
  warning: 2,
  suggestion: 0.5,
}
export const DENSITY_SCALE = 15
export const MIN_WORDS = 40
export const MECHANICS_WEIGHT = 0.5

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu
const WORD_RUN = /[\p{L}\p{N}]+/gu

/** Language-aware word count: letter/digit runs, CJK chars as half words. */
export function wordCount(text: string): number {
  const cjkChars = (text.match(CJK) ?? []).length
  const runs = text.replace(CJK, ' ').match(WORD_RUN) ?? []
  return runs.length + cjkChars * 0.5
}

/**
 * Unicode code point count, matching the backend's Python len() (spec
 * consistency for the UI char count): astral characters (e.g. emoji) are one
 * code point here despite being two UTF-16 code units, unlike text.length.
 * Iterates rather than spreading into an array to avoid allocating one for
 * long documents.
 */
export function codePoints(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/**
 * Mechanics component from the current findings; null below the minimum
 * text length (no score exists at all, see docs/scoring.md).
 */
export function mechanicsScore(
  findings: readonly { severity: ScoreSeverity }[],
  words: number,
): number | null {
  if (words < MIN_WORDS) return null
  const points = findings.reduce((sum, f) => sum + SEVERITY_POINTS[f.severity], 0)
  const density = (points / words) * 100
  return Math.round(100 * Math.exp(-density / DENSITY_SCALE))
}

/** Craft component from a (valid) scorecard. */
export function craftScore(scorecard: Scorecard): number {
  const total = DIMENSIONS.reduce((sum, d) => sum + scorecard[d].score, 0)
  const mean = total / DIMENSIONS.length
  return Math.round(((mean - 1) / 4) * 100)
}

/** Composite; craft === null means "no scorecard" (overall = mechanics). */
export function overallScore(mechanics: number, craft: number | null): number {
  if (craft === null) return mechanics
  return Math.round(MECHANICS_WEIGHT * mechanics + (1 - MECHANICS_WEIGHT) * craft)
}

/** Display bucket for color coding: <50 low, <80 mid, ≥80 high. */
export function scoreLevel(score: number): 'low' | 'mid' | 'high' {
  if (score < 50) return 'low'
  if (score < 80) return 'mid'
  return 'high'
}
