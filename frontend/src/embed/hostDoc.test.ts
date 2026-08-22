import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Scorecard } from '../scoring/score'
import { useStore } from '../state/store'
import type { Finding, Source } from '../types'
import { createHostDoc, type HostDoc, type HostDocOutbound } from './hostDoc'
import type { MarkingSpan } from './protocol'

const FAKE_SCORECARD: Scorecard = {
  consistency: { score: 4, note: '' },
  flow: { score: 4, note: '' },
  clarity: { score: 4, note: '' },
  vividness: { score: 4, note: '' },
  tone: { score: 4, note: '' },
  structure: { score: 4, note: '' },
}

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
  useStore.setState({
    tracked: [], selectedId: null, scorecard: null, scorecardStale: false, connectedField: null,
  })
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
    doc.replaceResult(outbound.applyReplacements[0].requestId, true, 'This is extremely good.', 'f1')
    await expect(promise).resolves.toBe('ok')
  })

  it('resolves refused on a refused echo', async () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    doc.replaceResult(outbound.applyReplacements[0].requestId, false, 'This is very good.', 'f1')
    await expect(promise).resolves.toBe('refused')
  })

  // A refused echo re-sends the UNCHANGED text (no real splice) — it must
  // not arm the check scheduler (the 1s/5s debounce) or touch metrics/the
  // scorecard, since nothing actually changed on the page.
  it('a refused echo with unchanged text does not call onInput', async () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const before = outbound.inputCalls
    const promise = doc.applySuggestion('f1', 'extremely')
    doc.replaceResult(outbound.applyReplacements[0].requestId, false, 'This is very good.', 'f1')
    await promise
    expect(outbound.inputCalls).toBe(before)
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
    doc.replaceResult(outbound.applyReplacements[0].requestId, true, 'This is extremely good.', 'f1')
    await promise
    expect(doc.getText()).toBe('This is extremely good.')
    // The suggestion self-invalidates the finding, exactly as in the editor.
    expect(doc.currentFinding('f1')).toBeNull()
  })

  // F2 (final review): the bridge forwards payload.fieldId, and the shim
  // must ignore any echo that doesn't match the currently connected field —
  // a stale echo from a field the host already disconnected must not
  // resync the buffer for whatever field is connected now.
  it('ignores a replaceResult echo for a different field: buffer unchanged, pending still times out', async () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    doc.replaceResult(outbound.applyReplacements[0].requestId, true, 'IGNORED TEXT', 'other-field')
    expect(doc.getText()).toBe('This is very good.')
    expect(doc.currentFinding('f1')).not.toBeNull() // untouched, not re-synced
    vi.advanceTimersByTime(2000)
    await expect(promise).resolves.toBe('refused')
  })

  // F2: fieldConnected/fieldDisconnected settle-and-clear the pending map
  // rather than leaving a stale promise to resolve only via its timeout.
  it('connect-during-pending settles the outstanding replace as refused immediately', async () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    doc.fieldConnected('f1', 'a whole new document', CAPS)
    await expect(promise).resolves.toBe('refused')
  })

  it('disconnect-during-pending settles the outstanding replace as refused immediately', async () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    doc.fieldDisconnected('f1')
    await expect(promise).resolves.toBe('refused')
  })
})

describe('replace: none capability', () => {
  const MARK_ONLY_CAPS = { mark: 'overlay' as const, replace: 'none' as const }

  it('applySuggestion resolves refused immediately, without posting a wire message', async () => {
    const outbound = fakeOutbound()
    const doc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'This is very good.', MARK_ONLY_CAPS)
    doc.mergeFindings(['rule'], [finding('f1', 8, 12, 'very')])

    const result = await doc.applySuggestion('f1', 'extremely')

    expect(result).toBe('refused')
    expect(outbound.applyReplacements).toEqual([])
  })

  it('applyRewrite resolves refused immediately, without posting a wire message', async () => {
    const outbound = fakeOutbound()
    const doc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'This is very good.', MARK_ONLY_CAPS)
    doc.mergeFindings(['rule'], [finding('f1', 8, 12, 'very')])

    const result = await doc.applyRewrite('f1', 'very', 'extremely')

    expect(result).toBe('refused')
    expect(outbound.applyReplacements).toEqual([])
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
    doc.replaceResult(call.requestId, true, `${sentence} Middle. Rewritten.`, 'f1')
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

describe('markingClicked', () => {
  it('selects the finding when the fieldId matches the connected field', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.markingClicked('f1', 'f1')
    expect(useStore.getState().selectedId).toBe('f1')
    expect(outbound.selectCalls).toEqual([{ fieldId: 'f1', id: 'f1' }])
  })

  // A stale-field click can arrive as a postMessage that was already in
  // flight when the host disconnected field 'f1' and connected a different
  // one — it must not select a finding against whatever field is connected
  // now (or against no field at all).
  it('ignores a click for a fieldId that does not match the connected field', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.markingClicked('stale-field', 'f1')
    expect(useStore.getState().selectedId).toBeNull()
    expect(outbound.selectCalls).toEqual([])
  })

  // Copilot round 3: a click can arrive as a postMessage that was already
  // in flight when the tracked findings changed underneath it (a fresh
  // check, or an edit that dropped the finding). The fieldId still matches,
  // but the finding id it names is gone — selecting it anyway would store
  // and echo a selection for a finding that no longer exists.
  it('ignores a click naming a finding id that is no longer tracked, even when the fieldId matches', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.markingClicked('f1', 'stale-finding-id')
    expect(useStore.getState().selectedId).toBeNull()
    expect(outbound.selectCalls).toEqual([])
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

  // Copilot round 5: fieldConnected used to install the NEW fieldId before
  // calling resetConnectionState(), so switching fields sent the empty-
  // findings clear to the field about to connect instead of the one about
  // to disappear — the old field's adapter never got told to drop its
  // overlays. Distinct fieldIds (f1 -> f2) are essential here: the test
  // above reuses the same id for both connects and cannot tell them apart.
  it('switching fields sends the empty-findings clear to the OLD fieldId, not the new one', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.fieldConnected('f2', 'a completely different field', CAPS)
    const last = outbound.findingsCalls.at(-1)
    expect(last).toEqual({ fieldId: 'f1', findings: [] })
    expect(useStore.getState().connectedField).toEqual({ fieldId: 'f2', url: null })
  })

  it('fieldConnected sets doc metrics for pre-existing text and clears a stale scorecard — the mutation-verification target for clearScorecard', () => {
    useStore.setState({ scorecard: FAKE_SCORECARD, scorecardStale: false })
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'four short words', CAPS)
    expect(useStore.getState().docWords).toBe(3)
    expect(useStore.getState().docChars).toBe(16)
    expect(useStore.getState().scorecard).toBeNull()
  })

  it('fieldConnected does not call onInput (the embed app schedules its own check on connect)', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'hello', CAPS)
    expect(outbound.inputCalls).toBe(0)
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

  // F1 (final review): mirror image of "fieldConnected clears tracked
  // findings" above — fieldDisconnected must reset the store the same way,
  // not just its own private fieldId/buffer/items. Mutation-verify by
  // dropping resetConnectionState's setTracked call: this test then fails
  // because useStore.getState().tracked stays non-empty.
  it('fieldDisconnected clears tracked findings in the store and sends empty findings to the host', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.fieldDisconnected('f1')
    expect(useStore.getState().tracked).toEqual([])
    const last = outbound.findingsCalls.at(-1)
    expect(last).toEqual({ fieldId: 'f1', findings: [] })
  })

  it('fieldConnected publishes the connected field id and page URL from meta to the store (B43 C1)', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'hello', CAPS, { url: 'https://host.example/doc', fieldKind: 'textarea' })
    expect(useStore.getState().connectedField).toEqual({
      fieldId: 'f1',
      url: 'https://host.example/doc',
    })
  })

  it('fieldConnected without meta (older/stub callers) publishes a null url, not a crash', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'hello', CAPS)
    expect(useStore.getState().connectedField).toEqual({ fieldId: 'f1', url: null })
  })

  it('fieldDisconnected clears connectedField for the matching field', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'hello', CAPS, { url: 'https://host.example/doc', fieldKind: 'textarea' })
    doc.fieldDisconnected('f1')
    expect(useStore.getState().connectedField).toBeNull()
  })

  it('fieldDisconnected leaves connectedField untouched for a mismatched fieldId', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'hello', CAPS, { url: 'https://host.example/doc', fieldKind: 'textarea' })
    doc.fieldDisconnected('other-field')
    expect(useStore.getState().connectedField).toEqual({
      fieldId: 'f1',
      url: 'https://host.example/doc',
    })
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

// Copilot round 8: resetSession() used to be an unconditional teardown
// (same as fieldDisconnected) — it nulled fieldId, which made the
// login-time republish() (fieldId === null) a no-op. The embed then waited
// forever while the host still believed it was connected. resetSession()
// now clears only session-scoped state (tracked findings, pending
// replacements, selection, doc metrics, the scorecard) and RETAINS the
// shim's own field identity/capabilities/meta/buffer, so republish()
// (wired to login()) can restore the connection.
describe('resetSession', () => {
  it('clears tracked findings/selection/metrics/scorecard in the store but keeps connected() true', () => {
    useStore.setState({ scorecard: FAKE_SCORECARD, scorecardStale: false })
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'hello', CAPS, { url: 'https://host.example/doc', fieldKind: 'textarea' })
    doc.mergeFindings(['rule'], [finding('f1', 0, 4, 'hell', 'rule')])
    doc.selectFinding('f1')

    doc.resetSession()

    expect(doc.connected()).toBe(true) // the shim still knows the field; only the store goes login-gated
    expect(doc.getText()).toBe('hello') // the buffer belongs to the host page, not the session
    expect(doc.currentFinding('f1')).toBeNull()
    expect(useStore.getState().tracked).toEqual([])
    expect(useStore.getState().selectedId).toBeNull()
    expect(useStore.getState().docWords).toBe(0)
    expect(useStore.getState().docChars).toBe(0)
    expect(useStore.getState().scorecard).toBeNull()
    const last = outbound.findingsCalls.at(-1)
    expect(last).toEqual({ fieldId: 'f1', findings: [] }) // sent to the still-current fieldId
  })

  it('settles a pending replacement as refused', async () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    const promise = doc.applySuggestion('f1', 'extremely')
    doc.resetSession()
    await expect(promise).resolves.toBe('refused')
    expect(outbound.applyReplacements).toHaveLength(1) // the request was sent; only its resolution changed
  })

  it('does not itself clear connectedField — that is auth/session.ts resetSessionState()\'s job, which always runs first', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'hello', CAPS, { url: 'https://host.example/doc', fieldKind: 'textarea' })
    doc.resetSession()
    // Unlike the old teardown()-based resetSession, this alone does not
    // null connectedField; in production resetSessionState() already did
    // (see session.ts's logout()/expireSession()) before this ever runs.
    expect(useStore.getState().connectedField).toEqual({
      fieldId: 'f1',
      url: 'https://host.example/doc',
    })
  })
})

// Copilot round 4: a field can connect while the login form is still
// showing (the bridge attaches regardless of auth status). login()'s
// resetSessionState() (on a cross-user login) clears store.connectedField/
// tracked/docWords/docChars even though this shim is still connected —
// republish() restores the store's view of it without tearing down the
// shim's own private fieldId/buffer/items.
describe('republish', () => {
  it('is a no-op while unconnected', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    expect(() => doc.republish()).not.toThrow()
    expect(useStore.getState().connectedField).toBeNull()
  })

  it('restores connectedField, doc metrics, and tracked findings after a login reset — and textChanged still tracks the field', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.selectFinding('f1')
    // Simulate the store half of login()'s reset: resetSessionState() wipes
    // these fields; the shim's own fieldId/buffer/items/selectedId are
    // untouched (they live outside the store).
    useStore.setState({
      connectedField: null, tracked: [], selectedId: null, docWords: 0, docChars: 0,
    })

    doc.republish()

    expect(useStore.getState().connectedField).toEqual({ fieldId: 'f1', url: null })
    expect(useStore.getState().docWords).toBe(4)
    expect(useStore.getState().docChars).toBe('This is very good.'.length)
    expect(useStore.getState().tracked).toHaveLength(1)
    expect(useStore.getState().selectedId).toBe('f1')

    doc.textChanged('f1', 'This is very good. Indeed.')
    expect(doc.getText()).toBe('This is very good. Indeed.')
  })

  it('restores the page URL published at fieldConnected time', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    doc.fieldConnected('f1', 'hello', CAPS, { url: 'https://host.example/doc', fieldKind: 'textarea' })
    useStore.setState({ connectedField: null })

    doc.republish()

    expect(useStore.getState().connectedField).toEqual({
      fieldId: 'f1',
      url: 'https://host.example/doc',
    })
  })

  // Copilot round 8: the fix that makes resetSession() retain fieldId/
  // buffer means logout -> login -> republish() is now a real reconnect,
  // not a no-op — this is the scenario the whole round-8 fix exists for.
  it('logout -> login -> republish restores connectedField from a retained buffer with empty tracked state', () => {
    const { doc } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.resetSession() // "logout": store cleared, but the shim keeps its field
    useStore.setState({ connectedField: null }) // resetSessionState()'s half of logout, simulated directly

    doc.republish() // "login": auth/session.ts's activateEmbed()

    // A fresh, non-null connectedField object is exactly what EmbedApp.tsx's
    // connect effect is keyed on (object identity, not fieldId alone) — in
    // the real app this is what re-fires cancelCheck()+runCheck().
    expect(useStore.getState().connectedField).toEqual({ fieldId: 'f1', url: null })
    expect(useStore.getState().docWords).toBe(4)
    expect(useStore.getState().docChars).toBe('This is very good.'.length)
    expect(useStore.getState().tracked).toEqual([]) // resetSession() dropped the pre-logout finding; it does not come back
  })

  // The other half of the round-8 fix: a host textChanged that arrives
  // DURING the logged-out window (after resetSession(), before the next
  // republish()) must not publish tracked findings or doc metrics into a
  // store the login-gated UI shouldn't be showing.
  it('a textChanged during the logged-out window does not publish to the store, but is not lost either', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.resetSession()
    const findingsCallsBefore = outbound.findingsCalls.length
    const inputCallsBefore = outbound.inputCalls

    doc.textChanged('f1', 'This is very good. Indeed.') // the host page keeps running while logged out

    expect(useStore.getState().docWords).toBe(0) // unchanged: still the resetSession()-cleared value
    expect(useStore.getState().docChars).toBe(0)
    expect(useStore.getState().tracked).toEqual([])
    expect(outbound.findingsCalls.length).toBe(findingsCallsBefore) // no new wire message either
    expect(outbound.inputCalls).toBe(inputCallsBefore) // the check scheduler must not arm

    // But the buffer itself kept tracking the host's true text, so
    // republish() (login) picks up the edit that happened while logged out.
    expect(doc.getText()).toBe('This is very good. Indeed.')
    doc.republish()
    expect(useStore.getState().docWords).toBe(5)
    expect(useStore.getState().docChars).toBe('This is very good. Indeed.'.length)
  })
})

// Copilot round 10: a direct user-A -> user-B login() (no logout() in
// between) only resets the Zustand store — resetSession() runs solely on
// logout/expiry (embed/disconnectSlot.ts), so this shim's own private
// items/selectedId survive untouched. Calling republish() alone from the
// login-activation path would then restore user A's tracked findings and
// selection into user B's session. activateSession() (wired to login() via
// embed/main.tsx in place of a bare republish()) clears that session-scoped
// state FIRST, so the republish it performs starts from empty.
describe('activateSession', () => {
  it('clears a still-connected field\'s tracked findings/selection before republishing, on a login with no logout in between', () => {
    const { doc, outbound } = connected('This is very good.', [finding('f1', 8, 12, 'very')])
    doc.selectFinding('f1')
    // A cross-user login only resets the store (auth/session.ts's
    // resetSessionState()) — simulated directly here, same as the
    // republish() describe block above. The shim's own items/selectedId
    // are untouched by this.
    useStore.setState({
      connectedField: null, tracked: [], selectedId: null, docWords: 0, docChars: 0,
    })

    doc.activateSession()

    // The host-side empty findings message (resetSession()'s clear) went
    // out before the republish restored connectedField/metrics.
    expect(outbound.findingsCalls.at(-1)).toEqual({ fieldId: 'f1', findings: [] })
    expect(useStore.getState().connectedField).toEqual({ fieldId: 'f1', url: null })
    expect(useStore.getState().docWords).toBe(4)
    expect(useStore.getState().docChars).toBe('This is very good.'.length)
    // User A's finding does NOT survive into the new session.
    expect(useStore.getState().tracked).toEqual([])
    expect(useStore.getState().selectedId).toBeNull()
    expect(doc.currentFinding('f1')).toBeNull()
  })

  it('is a no-op while unconnected', () => {
    const outbound = fakeOutbound()
    const doc: HostDoc = createHostDoc(outbound)
    expect(() => doc.activateSession()).not.toThrow()
    expect(useStore.getState().connectedField).toBeNull()
  })
})
