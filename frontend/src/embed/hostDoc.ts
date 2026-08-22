// Host document shim (spec: B43, "Bridge protocol" / C1 embed surface).
//
// Implements DocumentPort against postMessage-driven host state instead of
// a CodeMirror EditorView. The host owns the text; the shim never edits it
// directly. Every incoming text snapshot (a textChanged message, or a
// replaceResult echo) is diffed against the shim's buffer with a single
// derived splice, and the tracked findings are mapped through that splice —
// porting editor/findings.ts's ChangeSet-mapping semantics to a
// single-splice-per-update world (there is exactly one diff to reason
// about here, not an arbitrary ChangeSet).
import type { ApplyResult, DocumentPort } from '../checking/documentPort'
import type { TrackedFinding } from '../editor/findings'
import { findEquivalent } from '../findings/equivalence'
import { codePoints, wordCount } from '../scoring/score'
import { useStore } from '../state/store'
import type { Finding, Source } from '../types'
import { convertFindingOffsets, toCodePointSpan } from './offsets'
import type { HostCapabilities, MarkingSpan } from './protocol'

const REPLACE_TIMEOUT_MS = 2000

export interface HostDocOutbound {
  sendApplyReplacement(msg: {
    requestId: string
    fieldId: string
    from: number
    to: number
    insert: string
    expectedText: string
  }): void
  sendSelectFinding(fieldId: string, id: string | null): void
  sendFindings(fieldId: string, findings: MarkingSpan[]): void
  onInput(): void // scheduler hook, wired by the embed app
}

export interface HostDoc extends DocumentPort {
  fieldConnected(fieldId: string, text: string, capabilities: HostCapabilities): void
  fieldDisconnected(fieldId: string): void
  textChanged(fieldId: string, text: string): void
  replaceResult(requestId: string, ok: boolean, text: string): void
  connected(): boolean
  capabilities(): HostCapabilities | null
}

interface Splice {
  from: number
  to: number
  insert: string
}

/**
 * Derive the single splice that turns `oldText` into `newText`: longest
 * common prefix `p`, then the longest common suffix `s` bounded by
 * `s <= min(oldLen, newLen) - p` (INCLUSIVE). The strict form is off by
 * one: a pure insertion/deletion has `p + s === min(oldLen, newLen)`
 * exactly, and clamping `s` one short widens the splice by one character,
 * wrongly dropping an adjacent finding that CodeMirror's insertion mapping
 * keeps (see hostDoc.test.ts, the "the cat" -> "theX cat" vector).
 */
function deriveSplice(oldText: string, newText: string): Splice {
  const oldLen = oldText.length
  const newLen = newText.length
  const maxCommon = Math.min(oldLen, newLen)
  let p = 0
  while (p < maxCommon && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++
  const bound = maxCommon - p
  let s = 0
  while (
    s < bound &&
    oldText.charCodeAt(oldLen - 1 - s) === newText.charCodeAt(newLen - 1 - s)
  ) {
    s++
  }
  return { from: p, to: oldLen - s, insert: newText.slice(p, newLen - s) }
}

/** Same predicate `touchesRange` uses: overlap OR boundary adjacency. */
function touchesSplice(item: TrackedFinding, splice: Splice): boolean {
  return item.from <= splice.to && splice.from <= item.to
}

/**
 * Map tracked findings through a splice, porting findingsField's
 * docChanged branch: findings entirely before the splice are untouched,
 * findings entirely after shift by the length delta, and anything
 * overlapping OR adjacent to the splice is dropped — but only when the
 * splice is a real change (a no-op textChanged, e.g. a redundant host
 * echo, derives an empty splice and must not touch anything).
 */
function mapThroughSplice(items: TrackedFinding[], splice: Splice): TrackedFinding[] {
  const isRealChange = splice.from < splice.to || splice.insert.length > 0
  const delta = splice.insert.length - (splice.to - splice.from)
  const mapped: TrackedFinding[] = []
  for (const item of items) {
    if (isRealChange && touchesSplice(item, splice)) continue // dropped
    if (item.to < splice.from) {
      mapped.push(item)
    } else if (item.from > splice.to) {
      mapped.push({ ...item, from: item.from + delta, to: item.to + delta })
    } else {
      mapped.push(item) // touches a boundary, but not a real change
    }
  }
  return mapped.filter((item) => item.from < item.to)
}

function toTracked(findings: Finding[], bufferLength: number): TrackedFinding[] {
  return findings
    .filter((f) => f.span.start < f.span.end && f.span.end <= bufferLength)
    .map((f) => ({ finding: f, from: f.span.start, to: f.span.end }))
}

interface PendingReplace {
  resolve: (result: ApplyResult) => void
  timer: ReturnType<typeof setTimeout>
}

export function createHostDoc(outbound: HostDocOutbound): HostDoc {
  let fieldId: string | null = null
  let caps: HostCapabilities | null = null
  let buffer = ''
  let items: TrackedFinding[] = []
  let selectedId: string | null = null
  let requestSeq = 0
  const pending = new Map<string, PendingReplace>()

  function toMarkingSpans(): MarkingSpan[] {
    return items.map((item) => ({
      id: item.finding.id,
      from: item.from,
      to: item.to,
      severity: item.finding.severity,
      category: item.finding.category,
    }))
  }

  function publishFindings() {
    useStore.getState().setTracked(items, selectedId)
    if (fieldId) outbound.sendFindings(fieldId, toMarkingSpans())
  }

  function currentFinding(id: string): TrackedFinding | null {
    return items.find((item) => item.finding.id === id) ?? null
  }

  function settlePending(requestId: string, result: ApplyResult) {
    const p = pending.get(requestId)
    if (!p) return
    pending.delete(requestId)
    clearTimeout(p.timer)
    p.resolve(result)
  }

  /** Apply a fresh host-truth text snapshot: derive the splice, map
   * findings through it, resync the buffer, and republish — used by both
   * textChanged and a replaceResult echo (the host's echoed text is a
   * fresh textChanged in every way that matters here). */
  function syncBuffer(text: string) {
    const splice = deriveSplice(buffer, text)
    items = mapThroughSplice(items, splice)
    buffer = text
    outbound.onInput()
    const store = useStore.getState()
    store.setDocWords(wordCount(text))
    store.setDocChars(codePoints(text))
    store.markScorecardStale()
    publishFindings()
  }

  function sendReplace(from: number, to: number, insert: string): Promise<ApplyResult> {
    requestSeq += 1
    const requestId = `r${requestSeq}`
    const expectedText = buffer.slice(from, to)
    const currentFieldId = fieldId ?? ''
    const promise = new Promise<ApplyResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve('refused')
      }, REPLACE_TIMEOUT_MS)
      pending.set(requestId, { resolve, timer })
    })
    outbound.sendApplyReplacement({
      requestId, fieldId: currentFieldId, from, to, insert, expectedText,
    })
    return promise
  }

  return {
    hasDocument: () => fieldId !== null,
    connected: () => fieldId !== null,
    capabilities: () => caps,
    getText: () => buffer,
    setDocument: () => {}, // document manager never runs in the embed
    currentFinding,
    serverSpan(id) {
      const item = currentFinding(id)
      return item ? toCodePointSpan(buffer, item.from, item.to) : null
    },
    mergeFindings(replaceSources: Source[], findings: Finding[]) {
      const converted = convertFindingOffsets(buffer, findings)
      const tracked = toTracked(converted, buffer.length)
      const previous = items.find((item) => item.finding.id === selectedId)
      items = items
        .filter((item) => !replaceSources.includes(item.finding.source))
        .concat(tracked)
      if (!items.some((item) => item.finding.id === selectedId)) {
        selectedId = findEquivalent(items, previous)?.finding.id ?? null
      }
      publishFindings()
    },
    selectFinding(id) {
      selectedId = id
      useStore.getState().setTracked(items, selectedId)
      if (fieldId) outbound.sendSelectFinding(fieldId, id)
    },
    applySuggestion(id, suggestion) {
      const item = currentFinding(id)
      if (!item) return Promise.resolve('not-found')
      return sendReplace(item.from, item.to, suggestion)
    },
    applyRewrite(id, original, replacement) {
      const item = currentFinding(id)
      if (!item) return Promise.resolve('not-found')
      for (
        let index = buffer.indexOf(original);
        index !== -1;
        index = buffer.indexOf(original, index + 1)
      ) {
        const end = index + original.length
        if (index < item.to && item.from < end) {
          return sendReplace(index, end, replacement)
        }
      }
      return Promise.resolve('not-found')
    },
    fieldConnected(fid, text, capabilities) {
      fieldId = fid
      caps = capabilities
      buffer = text
      items = []
      selectedId = null
      publishFindings()
    },
    fieldDisconnected(fid) {
      if (fieldId !== fid) return
      fieldId = null
      caps = null
      buffer = ''
      items = []
      selectedId = null
    },
    textChanged(fid, text) {
      if (fieldId !== fid) return
      syncBuffer(text)
    },
    replaceResult(requestId, ok, text) {
      settlePending(requestId, ok ? 'ok' : 'refused')
      if (fieldId) syncBuffer(text)
    },
  }
}
