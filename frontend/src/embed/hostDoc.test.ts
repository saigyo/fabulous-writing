import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../state/store'
import type { Finding, Source } from '../types'
import { createHostDoc, type HostDoc, type HostDocOutbound } from './hostDoc'
import type { MarkingSpan } from './protocol'

const CAPS = { mark: 'overlay' as const, replace: 'reliable' as const }

function finding(
  id: string, start: number, end: number, text: string, source: Source = 'rule',
): Finding {
  return {
    id, category: 'style', severity: 'warning', source, rule_id: 'style.test',
    message: 'test finding', span: { start, end, text }, suggestions: ['better'], advice: [],
  }
}

interface FakeOutbound extends HostDocOutbound {
  applyReplacements: { requestId: string; fieldId: string; from: number; to: number; insert: string; expectedText: string }[]
  selectCalls: { fieldId: string; id: string | null }[]
  findingsCalls: { fieldId: string; findings: MarkingSpan[] }[]
  inputCalls: number
}

function fakeOutbound(): FakeOutbound {
  const applyReplacements: FakeOutbound['applyReplacements'] = []
  const selectCalls: FakeOutbound['selectCalls'] = []
  const findingsCalls: FakeOutbound['findingsCalls'] = []
  return {
    applyReplacements,
    selectCalls,
    findingsCalls,
    inputCalls: 0,
    sendApplyReplacement(msg) {
      applyReplacements.push(msg)
    },
    sendSelectFinding(fieldId, id) {
      selectCalls.push({ fieldId, id })
    },
    sendFindings(fieldId, findings) {
      findingsCalls.push({ fieldId, findings })
    },
    onInput() {
      this.inputCalls += 1
    },
  }
}

function connected(text: string, findings: Finding[] = [], source: Source = 'rule') {
  const outbound = fakeOutbound()
  const doc = createHostDoc(outbound)
  doc.fieldConnected('f1', text, CAPS)
  if (findings.length > 0) doc.mergeFindings([source], findings)
  return { doc, outbound }
}

beforeEach(() => {
  useStore.setState({ tracked: [], selectedId: null, scorecard: null, scorecardStale: false })
})

describe('splice derivation via textChanged', () => {
  it('typing in the middle shifts a finding that starts after the insertion', () => {
    const { doc } = connected('abcdefghij', [finding('f1', 6, 9, 'ghi')])
    doc.textChanged('f1', 'abcZdefghij')
    const item = doc.currentFinding('f1')
    expect(item).not.toBeNull()
    expect(item!.from).toBe(7)
    expect(item!.to).toBe(10)
  })

  it('typing at the start shifts every finding', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.textChanged('f1', 'Hey! This is very good.')
    const item = doc.currentFinding('f1')
    expect(item!.from).toBe(13)
    expect(item!.to).toBe(17)
  })

  it('typing at the end leaves earlier findings untouched', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.textChanged('f1', 'This is very good. Indeed.')
    const item = doc.currentFinding('f1')
    expect(item!.from).toBe(8)
    expect(item!.to).toBe(12)
  })

  it('deletion shifts trailing findings back', () => {
    const { doc } = connected('Hey! This is very good.', [finding('f1', 13, 17, 'very')])
    doc.textChanged('f1', 'This is very good.')
    const item = doc.currentFinding('f1')
    expect(item!.from).toBe(8)
    expect(item!.to).toBe(12)
  })

  it('paste-replacing-everything drops all findings', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.textChanged('f1', 'Completely different text here.')
    expect(doc.currentFinding('f1')).toBeNull()
  })

  it('no-op text leaves findings untouched', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.textChanged('f1', 'This is very good.')
    const item = doc.currentFinding('f1')
    expect(item!.from).toBe(8)
    expect(item!.to).toBe(12)
  })

  it('handles the degenerate vector "aa" -> "a"', () => {
    const { doc } = connected('aa')
    expect(() => doc.textChanged('f1', 'a')).not.toThrow()
    expect(doc.getText()).toBe('a')
  })

  it('handles the degenerate vector "a" -> "aa"', () => {
    const { doc } = connected('a')
    expect(() => doc.textChanged('f1', 'aa')).not.toThrow()
    expect(doc.getText()).toBe('aa')
  })

  it('handles the degenerate vector "" -> "x"', () => {
    const { doc } = connected('')
    expect(() => doc.textChanged('f1', 'x')).not.toThrow()
    expect(doc.getText()).toBe('x')
  })

  it('handles the degenerate vector "x" -> ""', () => {
    const { doc } = connected('x')
    expect(() => doc.textChanged('f1', '')).not.toThrow()
    expect(doc.getText()).toBe('')
  })

  // The suffix-bound guard vector: an off-by-one clamp on `s` widens the
  // splice by one character and would wrongly drop this finding.
  it('suffix-bound guard: "the cat" -> "theX cat" keeps the pure insertion at 3 and shifts the finding', () => {
    const { doc } = connected('the cat', [finding('f1', 4, 7, 'cat')])
    doc.textChanged('f1', 'theX cat')
    const item = doc.currentFinding('f1')
    expect(item).not.toBeNull()
    expect(item!.from).toBe(5)
    expect(item!.to).toBe(8)
  })
})

describe('mapping through the splice', () => {
  it('leaves a finding entirely before the edit unchanged', () => {
    const { doc } = connected('aaa bbb ccc', [finding('f1', 0, 3, 'aaa')])
    doc.textChanged('f1', 'aaa bbb ccc ddd')
    const item = doc.currentFinding('f1')
    expect(item!.from).toBe(0)
    expect(item!.to).toBe(3)
  })

  it('shifts a finding entirely after the edit', () => {
    const { doc } = connected('aaa bbb ccc', [finding('f1', 8, 11, 'ccc')])
    doc.textChanged('f1', 'aaa XXX bbb ccc')
    const item = doc.currentFinding('f1')
    expect(item!.from).toBe(12)
    expect(item!.to).toBe(15)
  })

  it('drops a finding the edit overlaps', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.textChanged('f1', 'This is xxry good.')
    expect(doc.currentFinding('f1')).toBeNull()
  })

  it('drops a finding adjacent to an insertion at its start boundary — the mutation-verification target for the adjacency-drop predicate', () => {
    const { doc } = connected('the cat', [finding('f1', 4, 7, 'cat')])
    doc.textChanged('f1', 'the Qcat')
    expect(doc.currentFinding('f1')).toBeNull()
  })

  it('drops a finding adjacent to a deletion at its start boundary', () => {
    const { doc } = connected('the cat', [finding('f1', 4, 7, 'cat')])
    doc.textChanged('f1', 'thecat')
    expect(doc.currentFinding('f1')).toBeNull()
  })

  it('documented divergence: a finding in a duplicated region can survive an edit CodeMirror would drop', () => {
    // 'xzxz' -> 'xz': the diff recovers the RIGHTMOST occurrence as the
    // deleted one (splice [2,4)), even though a real user backspacing the
    // FIRST 'xz' would produce {from:0,to:2} in CodeMirror and drop a
    // finding on the leading 'x'. Our single-splice diff can't distinguish
    // the two equivalent edits, so the finding survives here — expected,
    // not a bug (span text still matches by construction).
    const { doc } = connected('xzxz', [finding('f1', 0, 1, 'x')])
    doc.textChanged('f1', 'xz')
    const item = doc.currentFinding('f1')
    expect(item).not.toBeNull()
    expect(item!.from).toBe(0)
    expect(item!.to).toBe(1)
  })
})

describe('mergeFindings', () => {
  it('replaces findings of the given sources and keeps the rest', () => {
    const { doc } = connected('This is very good.', [
      finding('rule-old', 0, 4, 'This', 'rule'),
      finding('llm-1', 8, 12, 'very', 'llm'),
    ], 'rule')
    doc.mergeFindings(['rule', 'terminology'], [finding('rule-new', 5, 7, 'is', 'rule')])
    const ids = ['rule-new', 'llm-1'].map((id) => doc.currentFinding(id)?.finding.id)
    expect(ids).toEqual(['rule-new', 'llm-1'])
    expect(doc.currentFinding('rule-old')).toBeNull()
  })

  it('keeps the selection alive across an equivalent replacement', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.selectFinding('f1')
    doc.mergeFindings(['rule'], [finding('f2', 8, 12, 'very')])
    expect(useStore.getState().selectedId).toBe('f2')
  })

  it('clears the selection when no equivalent finding comes back', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.selectFinding('f1')
    doc.mergeFindings(['rule'], [{ ...finding('f2', 0, 4, 'This'), rule_id: 'style.other' }])
    expect(useStore.getState().selectedId).toBeNull()
  })

  it('converts astral server code-point spans to UTF-16 tracked spans end to end', () => {
    const text = '𝔸 bad'
    const { doc } = connected(text, [finding('f1', 2, 5, 'bad')])
    const item = doc.currentFinding('f1')
    expect(item!.from).toBe(3)
    expect(item!.to).toBe(6)
    expect(text.slice(item!.from, item!.to)).toBe('bad')
  })

  it('drops spans that exceed the buffer length or are empty after conversion', () => {
    const { doc } = connected('short', [finding('f1', 100, 110, 'nothing')])
    expect(doc.currentFinding('f1')).toBeNull()
  })
})

describe('serverSpan', () => {
  it('is identity for BMP-only text', () => {
    const { doc } = connected('hello world', [finding('f1', 6, 11, 'world')])
    expect(doc.serverSpan('f1')).toEqual({ start: 6, end: 11 })
  })

  it('round-trips astral text against a [...buffer] slice (Python semantics)', () => {
    const text = '𝔸 bad'
    const { doc } = connected(text, [finding('f1', 2, 5, 'bad')])
    const span = doc.serverSpan('f1')
    expect(span).not.toBeNull()
    const codePoints = [...text]
    expect(codePoints.slice(span!.start, span!.end).join('')).toBe('bad')
  })

  it('is null for an unknown id', () => {
    const { doc } = connected('hello')
    expect(doc.serverSpan('missing')).toBeNull()
  })
})

describe('replacement round-trip', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves ok on an ok echo and expectedText matches the finding span — the mutation-verification target for the expectedText slice', async () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    expect(outbound.applyReplacements).toHaveLength(1)
    expect(outbound.applyReplacements[0].expectedText).toBe('very')
    expect(outbound.applyReplacements[0].from).toBe(8)
    expect(outbound.applyReplacements[0].to).toBe(12)
    doc.replaceResult(outbound.applyReplacements[0].requestId, true, 'This is extremely good.')
    await expect(promise).resolves.toBe('ok')
  })

  it('resolves refused on a refused echo', async () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    doc.replaceResult(outbound.applyReplacements[0].requestId, false, 'This is very good.')
    await expect(promise).resolves.toBe('refused')
  })

  it('resolves refused after a 2000ms timeout with no echo', async () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    vi.advanceTimersByTime(2000)
    await expect(promise).resolves.toBe('refused')
  })

  it('resolves not-found when the finding is gone', async () => {
    const { doc } = connected('This is very good.')
    await expect(doc.applySuggestion('missing', 'x')).resolves.toBe('not-found')
  })

  it('the echoed text re-syncs the buffer and getText() reflects the newest echo', async () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    doc.replaceResult(outbound.applyReplacements[0].requestId, true, 'This is extremely good.')
    await promise
    expect(doc.getText()).toBe('This is extremely good.')
    // The suggestion self-invalidates the finding, exactly as in the editor.
    expect(doc.currentFinding('f1')).toBeNull()
  })
})

describe('applyRewrite', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('replaces the overlapping occurrence among duplicates', async () => {
    const sentence = 'This is very good.'
    const dupDoc = `${sentence} Middle. ${sentence}`
    const start = dupDoc.lastIndexOf('very')
    const { doc, outbound } = connected(dupDoc, [finding('f1', start, start + 4, 'very')])
    const promise = doc.applyRewrite('f1', sentence, 'Rewritten.')
    expect(outbound.applyReplacements).toHaveLength(1)
    const call = outbound.applyReplacements[0]
    expect(dupDoc.slice(call.from, call.to)).toBe(sentence)
    expect(call.from).toBeGreaterThan(sentence.length) // the second occurrence
    doc.replaceResult(call.requestId, true, `${sentence} Middle. Rewritten.`)
    await expect(promise).resolves.toBe('ok')
  })

  it('resolves not-found when the sentence was edited away', async () => {
    const { doc } = connected('First part. This is so very good. Last part.', [
      finding('f1', 22, 26, 'very'),
    ])
    await expect(doc.applyRewrite('f1', 'This is very good.', 'x')).resolves.toBe('not-found')
  })

  it('resolves not-found for an unknown finding id', async () => {
    const { doc } = connected('This is very good.')
    await expect(doc.applyRewrite('missing', 'This is very good.', 'x')).resolves.toBe('not-found')
  })
})

describe('selectFinding', () => {
  it('updates the store and sends sendSelectFinding without re-sending findings', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const before = outbound.findingsCalls.length
    doc.selectFinding('f1')
    expect(useStore.getState().selectedId).toBe('f1')
    expect(outbound.selectCalls).toEqual([{ fieldId: 'f1', id: 'f1' }])
    expect(outbound.findingsCalls.length).toBe(before)
  })
})

describe('fieldConnected / fieldDisconnected / connected / capabilities', () => {
  it('is not connected before fieldConnected and reports capabilities after', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    expect(doc.connected()).toBe(false)
    expect(doc.hasDocument()).toBe(false)
    expect(doc.capabilities()).toBeNull()
    doc.fieldConnected('f1', 'hello', CAPS)
    expect(doc.connected()).toBe(true)
    expect(doc.hasDocument()).toBe(true)
    expect(doc.capabilities()).toEqual(CAPS)
    expect(doc.getText()).toBe('hello')
  })

  it('fieldConnected clears tracked findings in the store and sends empty findings to the host', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.fieldConnected('f1', 'fresh text', CAPS)
    expect(useStore.getState().tracked).toEqual([])
    const last = outbound.findingsCalls.at(-1)
    expect(last).toEqual({ fieldId: 'f1', findings: [] })
  })

  it('fieldDisconnected clears connection state for the matching field', () => {
    const { doc } = connected('This is very good.')
    doc.fieldDisconnected('f1')
    expect(doc.connected()).toBe(false)
    expect(doc.hasDocument()).toBe(false)
    expect(doc.getText()).toBe('')
  })

  it('fieldDisconnected ignores a mismatched fieldId', () => {
    const { doc } = connected('This is very good.')
    doc.fieldDisconnected('other-field')
    expect(doc.connected()).toBe(true)
  })

  it('textChanged ignores a mismatched fieldId', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.textChanged('other-field', 'ignored')
    expect(doc.getText()).toBe('This is very good.')
  })
})

describe('setDocument', () => {
  it('is a documented no-op', () => {
    const { doc } = connected('This is very good.')
    expect(() => doc.setDocument('replaced', [])).not.toThrow()
    expect(doc.getText()).toBe('This is very good.')
  })
})
