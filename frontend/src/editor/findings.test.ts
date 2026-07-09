import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { Finding } from '../types'
import {
  findingIdAt,
  findingsField,
  mergeFindingsEffect,
  rewriteChange,
  selectFindingEffect,
  setFindingsEffect,
  suggestionChange,
} from './findings'

function makeFinding(id: string, start: number, end: number, text: string): Finding {
  return {
    id,
    category: 'style',
    severity: 'warning',
    source: 'rule',
    rule_id: 'style.test',
    message: 'test finding',
    span: { start, end, text },
    suggestions: ['better'],
    advice: [],
  }
}

function stateWithFindings(doc: string, findings: Finding[]): EditorState {
  const state = EditorState.create({ doc, extensions: [findingsField] })
  return state.update({ effects: setFindingsEffect.of(findings) }).state
}

describe('findingsField', () => {
  it('tracks findings at their span positions', () => {
    const doc = 'This is very good.'
    const state = stateWithFindings(doc, [makeFinding('f1', 8, 12, 'very')])
    const items = state.field(findingsField).items
    expect(items).toHaveLength(1)
    expect(items[0].from).toBe(8)
    expect(items[0].to).toBe(12)
  })

  it('shifts positions when text is inserted before the span', () => {
    const state = stateWithFindings('This is very good.', [
      makeFinding('f1', 8, 12, 'very'),
    ])
    const next = state.update({ changes: { from: 0, insert: 'Hey! ' } }).state
    const items = next.field(findingsField).items
    expect(items[0].from).toBe(13)
    expect(items[0].to).toBe(17)
  })

  it('drops a finding when the user edits inside its span', () => {
    const state = stateWithFindings('This is very good.', [
      makeFinding('f1', 8, 12, 'very'),
    ])
    const next = state.update({ changes: { from: 9, to: 10, insert: 'x' } }).state
    expect(next.field(findingsField).items).toHaveLength(0)
  })

  it('drops findings whose spans do not fit the document', () => {
    const state = stateWithFindings('short', [makeFinding('f1', 100, 110, 'nothing')])
    expect(state.field(findingsField).items).toHaveLength(0)
  })

  it('records the selected finding id', () => {
    const state = stateWithFindings('This is very good.', [
      makeFinding('f1', 8, 12, 'very'),
    ])
    const next = state.update({ effects: selectFindingEffect.of('f1') }).state
    expect(next.field(findingsField).selectedId).toBe('f1')
  })
})

describe('findingIdAt', () => {
  const doc = 'Malgré que l’outil soit encore jeune, il est assez complet.'
  const sentence = makeFinding('sentence', 0, doc.length, doc)
  const inner = makeFinding('inner', 0, 10, 'Malgré que')
  const other = makeFinding('other', 45, 50, 'assez')

  it('returns null when no finding covers the position', () => {
    const state = stateWithFindings(doc, [inner])
    expect(findingIdAt(state.field(findingsField), 30)).toBeNull()
  })

  it('picks the smallest finding under the position, not the sentence', () => {
    const state = stateWithFindings(doc, [sentence, inner, other])
    expect(findingIdAt(state.field(findingsField), 5)).toBe('inner')
  })

  it('cycles outward through stacked findings on repeated clicks', () => {
    let state = stateWithFindings(doc, [sentence, inner])
    expect(findingIdAt(state.field(findingsField), 5)).toBe('inner')
    state = state.update({ effects: selectFindingEffect.of('inner') }).state
    expect(findingIdAt(state.field(findingsField), 5)).toBe('sentence')
    state = state.update({ effects: selectFindingEffect.of('sentence') }).state
    expect(findingIdAt(state.field(findingsField), 5)).toBe('inner')
  })

  it('ignores a selected finding elsewhere and picks the smallest hit', () => {
    const state = stateWithFindings(doc, [sentence, inner, other])
    const selected = state.update({ effects: selectFindingEffect.of('other') }).state
    expect(findingIdAt(selected.field(findingsField), 5)).toBe('inner')
  })
})

describe('mergeFindingsEffect', () => {
  it('replaces findings of the given sources and keeps the rest', () => {
    const ruleFinding = makeFinding('rule-old', 0, 4, 'This')
    const llmFinding: Finding = {
      ...makeFinding('llm-1', 8, 12, 'very'),
      source: 'llm',
    }
    const state = stateWithFindings('This is very good.', [ruleFinding, llmFinding])
    const replacement = makeFinding('rule-new', 5, 7, 'is')
    const next = state.update({
      effects: mergeFindingsEffect.of({
        replaceSources: ['rule', 'terminology'],
        findings: [replacement],
      }),
    }).state
    const ids = next.field(findingsField).items.map((it) => it.finding.id)
    expect(ids.sort()).toEqual(['llm-1', 'rule-new'])
  })
})

describe('rewriteChange', () => {
  const doc = 'First part. This is very good. Last part.'
  const sentence = 'This is very good.'

  function stateWithVeryFinding(text = doc) {
    const start = text.indexOf('very')
    return stateWithFindings(text, [makeFinding('f1', start, start + 4, 'very')])
  }

  it('replaces the sentence containing the finding', () => {
    const state = stateWithVeryFinding()
    const change = rewriteChange(state, 'f1', sentence, 'This shines.')
    expect(change).not.toBeNull()
    const next = state.update({ changes: change! }).state
    expect(next.doc.toString()).toBe('First part. This shines. Last part.')
    expect(next.field(findingsField).items).toHaveLength(0)
  })

  it('picks the occurrence overlapping the finding among duplicates', () => {
    const dupDoc = `${sentence} Middle. ${sentence}`
    const start = dupDoc.lastIndexOf('very')
    const state = stateWithFindings(dupDoc, [makeFinding('f1', start, start + 4, 'very')])
    const change = rewriteChange(state, 'f1', sentence, 'Rewritten.')
    const next = state.update({ changes: change! }).state
    expect(next.doc.toString()).toBe(`${sentence} Middle. Rewritten.`)
  })

  it('still finds the sentence after unrelated earlier edits', () => {
    const state = stateWithVeryFinding()
    const edited = state.update({ changes: { from: 0, insert: 'Intro! ' } }).state
    const change = rewriteChange(edited, 'f1', sentence, 'This shines.')
    const next = edited.update({ changes: change! }).state
    expect(next.doc.toString()).toBe('Intro! First part. This shines. Last part.')
  })

  it('returns null when the sentence was edited away', () => {
    const state = stateWithVeryFinding('First part. This is so very good. Last part.')
    expect(rewriteChange(state, 'f1', sentence, 'x')).toBeNull()
  })

  it('returns null for unknown findings', () => {
    const state = stateWithVeryFinding()
    expect(rewriteChange(state, 'missing', sentence, 'x')).toBeNull()
  })
})

describe('suggestionChange', () => {
  it('replaces the tracked span and removes the finding', () => {
    const state = stateWithFindings('This is very good.', [
      makeFinding('f1', 8, 12, 'very'),
    ])
    const change = suggestionChange(state, 'f1', 'extremely')
    expect(change).not.toBeNull()
    const next = state.update({ changes: change! }).state
    expect(next.doc.toString()).toBe('This is extremely good.')
    expect(next.field(findingsField).items).toHaveLength(0)
  })

  it('uses the current (mapped) position after earlier edits', () => {
    const state = stateWithFindings('This is very good.', [
      makeFinding('f1', 8, 12, 'very'),
    ])
    const edited = state.update({ changes: { from: 0, insert: 'Hey! ' } }).state
    const change = suggestionChange(edited, 'f1', 'so')
    const next = edited.update({ changes: change! }).state
    expect(next.doc.toString()).toBe('Hey! This is so good.')
  })

  it('returns null for unknown findings', () => {
    const state = stateWithFindings('text', [])
    expect(suggestionChange(state, 'missing', 'x')).toBeNull()
  })
})

describe('selection survival across checks', () => {
  const doc = 'This is very good.'
  const selected = () => {
    const state = stateWithFindings(doc, [makeFinding('f1', 8, 12, 'very')])
    return state.update({ effects: selectFindingEffect.of('f1') }).state
  }

  it('re-selects the equivalent finding when a check returns new ids', () => {
    const next = selected().update({
      effects: setFindingsEffect.of([makeFinding('f2', 8, 12, 'very')]),
    }).state
    expect(next.field(findingsField).selectedId).toBe('f2')
  })

  it('re-selects through mergeFindingsEffect as well', () => {
    const next = selected().update({
      effects: mergeFindingsEffect.of({
        replaceSources: ['rule', 'terminology'],
        findings: [makeFinding('f3', 8, 12, 'very')],
      }),
    }).state
    expect(next.field(findingsField).selectedId).toBe('f3')
  })

  it('clears the selection when no equivalent finding comes back', () => {
    const different: Finding = {
      ...makeFinding('f2', 8, 12, 'very'),
      rule_id: 'style.other',
    }
    const next = selected().update({
      effects: setFindingsEffect.of([different]),
    }).state
    expect(next.field(findingsField).selectedId).toBeNull()
  })

  it('picks the nearest candidate among duplicates', () => {
    const dupDoc = 'very good and very good.'
    const state = stateWithFindings(dupDoc, [
      makeFinding('a1', 0, 4, 'very'),
      makeFinding('a2', 14, 18, 'very'),
    ])
    const chosen = state.update({ effects: selectFindingEffect.of('a2') }).state
    const next = chosen.update({
      effects: setFindingsEffect.of([
        makeFinding('b1', 0, 4, 'very'),
        makeFinding('b2', 14, 18, 'very'),
      ]),
    }).state
    expect(next.field(findingsField).selectedId).toBe('b2')
  })
})
