import type { ChangeSpec, EditorState } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { findEquivalent } from '../findings/equivalence'
import type { Finding, Source } from '../types'

export interface TrackedFinding {
  finding: Finding
  from: number
  to: number
}

export interface FindingsState {
  items: TrackedFinding[]
  selectedId: string | null
}

export const setFindingsEffect = StateEffect.define<Finding[]>()
export const selectFindingEffect = StateEffect.define<string | null>()

export interface MergeFindings {
  replaceSources: Source[]
  findings: Finding[]
}

export const mergeFindingsEffect = StateEffect.define<MergeFindings>()

function toTracked(findings: Finding[], docLength: number): TrackedFinding[] {
  return findings
    .filter((f) => f.span.start < f.span.end && f.span.end <= docLength)
    .map((f) => ({ finding: f, from: f.span.start, to: f.span.end }))
}

export const findingsField = StateField.define<FindingsState>({
  create: () => ({ items: [], selectedId: null }),
  update(value, tr) {
    let { items, selectedId } = value
    if (tr.docChanged) {
      items = items
        .filter((item) => !tr.changes.touchesRange(item.from, item.to))
        .map((item) => ({
          ...item,
          from: tr.changes.mapPos(item.from, 1),
          to: tr.changes.mapPos(item.to, -1),
        }))
        .filter((item) => item.from < item.to)
    }
    for (const effect of tr.effects) {
      if (effect.is(setFindingsEffect)) {
        const previous = items.find((item) => item.finding.id === selectedId)
        items = toTracked(effect.value, tr.newDoc.length)
        if (!items.some((item) => item.finding.id === selectedId)) {
          selectedId = equivalentId(items, previous)
        }
      } else if (effect.is(mergeFindingsEffect)) {
        const { replaceSources, findings } = effect.value
        const previous = items.find((item) => item.finding.id === selectedId)
        items = items
          .filter((item) => !replaceSources.includes(item.finding.source))
          .concat(toTracked(findings, tr.newDoc.length))
        if (!items.some((item) => item.finding.id === selectedId)) {
          selectedId = equivalentId(items, previous)
        }
      } else if (effect.is(selectFindingEffect)) {
        selectedId = effect.value
      }
    }
    return items === value.items && selectedId === value.selectedId
      ? value
      : { items, selectedId }
  },
  provide: (field) =>
    EditorView.decorations.from(field, (state) => buildDecorations(state)),
})

/**
 * Findings get fresh ids on every check; keep the open card open by
 * re-selecting the finding that says the same thing about the same text.
 */
function equivalentId(
  items: TrackedFinding[],
  previous: TrackedFinding | undefined,
): string | null {
  return findEquivalent(items, previous)?.finding.id ?? null
}

/**
 * The finding a click at `pos` should select. The smallest finding under
 * the position wins — a whole-sentence finding (e.g. a sentence-length
 * warning) must not shadow the point findings inside it. When the
 * currently selected finding is part of the stack, the next-larger one is
 * chosen instead, so repeated clicks cycle outward through all of them.
 */
export function findingIdAt(state: FindingsState, pos: number): string | null {
  const hits = state.items
    .filter((item) => item.from <= pos && pos <= item.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from))
  if (hits.length === 0) return null
  const current = hits.findIndex((item) => item.finding.id === state.selectedId)
  return hits[(current + 1) % hits.length].finding.id
}

function buildDecorations(state: FindingsState): DecorationSet {
  const ranges = [...state.items]
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((item) => {
      const selected = item.finding.id === state.selectedId ? ' fw-selected' : ''
      return Decoration.mark({
        class: `fw-finding fw-${item.finding.category}${selected}`,
      }).range(item.from, item.to)
    })
  return Decoration.set(ranges, true)
}

/**
 * Change spec replacing the sentence a finding sits in. The sentence is
 * located by its fetch-time text in the current document (never by stale
 * offsets), picking the occurrence that overlaps the finding's tracked
 * span. Returns null if the finding is gone or the sentence was edited.
 */
export function rewriteChange(
  state: EditorState,
  findingId: string,
  original: string,
  replacement: string,
): ChangeSpec | null {
  const item = state
    .field(findingsField)
    .items.find((it) => it.finding.id === findingId)
  if (!item) return null
  const doc = state.doc.toString()
  for (
    let index = doc.indexOf(original);
    index !== -1;
    index = doc.indexOf(original, index + 1)
  ) {
    const end = index + original.length
    if (index < item.to && item.from < end) {
      return { from: index, to: end, insert: replacement }
    }
  }
  return null
}

/** Change spec that applies a suggestion to a finding's current span. */
export function suggestionChange(
  state: EditorState,
  findingId: string,
  suggestion: string,
): ChangeSpec | null {
  const item = state
    .field(findingsField)
    .items.find((it) => it.finding.id === findingId)
  if (!item) return null
  return { from: item.from, to: item.to, insert: suggestion }
}
