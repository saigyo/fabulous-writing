import { EditorView } from '@codemirror/view'
import {
  findingsField,
  selectFindingEffect,
  suggestionChange,
} from './findings'

let view: EditorView | null = null

export function setEditorView(v: EditorView | null): void {
  view = v
}

export function getEditorView(): EditorView | null {
  return view
}

/** Select a finding: highlight it in the editor and scroll it into view. */
export function selectFinding(id: string | null): void {
  if (!view) return
  const effects = [selectFindingEffect.of(id)]
  if (id) {
    const item = view.state
      .field(findingsField)
      .items.find((it) => it.finding.id === id)
    if (item) {
      effects.push(EditorView.scrollIntoView(item.from, { y: 'center' }) as never)
    }
  }
  view.dispatch({ effects })
}

/** Replace a finding's span with the chosen suggestion. */
export function applySuggestion(id: string, suggestion: string): void {
  if (!view) return
  const change = suggestionChange(view.state, id, suggestion)
  if (!change) return
  view.dispatch({ changes: change })
  view.focus()
}
