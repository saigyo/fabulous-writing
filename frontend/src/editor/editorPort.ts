import type { DocumentPort } from '../checking/documentPort'
import { setDocumentPort } from '../checking/documentPort'
import { applyRewrite, applySuggestion, getEditorView, selectFinding } from './editorRef'
import { findingsField, mergeFindingsEffect, setFindingsEffect } from './findings'

function item(id: string) {
  const view = getEditorView()
  return view?.state.field(findingsField).items.find((it) => it.finding.id === id) ?? null
}

const cmPort: DocumentPort = {
  hasDocument: () => getEditorView() !== null,
  getText: () => getEditorView()?.state.doc.toString() ?? '',
  setDocument(text, findings) {
    // The hydration path's editor writes, moved behind the port: replace
    // the whole doc and set the findings in one place. Semantics unchanged
    // from documents/hydration.ts's previous direct dispatch.
    const view = getEditorView()
    if (!view) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: setFindingsEffect.of(findings),
    })
  },
  currentFinding: item,
  // Unconverted, matching the app's existing (latently astral-buggy)
  // behavior — the fix is tracked, out of scope here.
  serverSpan(id) {
    const it = item(id)
    return it ? { start: it.from, end: it.to } : null
  },
  mergeFindings(replaceSources, findings) {
    getEditorView()?.dispatch({
      effects: mergeFindingsEffect.of({ replaceSources, findings }),
    })
  },
  selectFinding,
  applySuggestion(id, suggestion) {
    if (!item(id)) return Promise.resolve('not-found')
    applySuggestion(id, suggestion)
    return Promise.resolve('ok')
  },
  applyRewrite: (id, original, replacement) =>
    Promise.resolve(applyRewrite(id, original, replacement) ? 'ok' : 'not-found'),
}
setDocumentPort(cmPort)
