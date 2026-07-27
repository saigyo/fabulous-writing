import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { runCheck } from '../checking/controller'
import { createCheckScheduler } from '../checking/scheduler'
import { flush, noteChange } from '../documents/autosave'
import { codePoints, wordCount } from '../scoring/score'
import { useStore } from '../state/store'
import { findingIdAt, findingsField, selectFindingEffect } from './findings'
import { setEditorView } from './editorRef'

export function Editor() {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scheduler = createCheckScheduler({
      fastDelayMs: 1000,
      llmDelayMs: 5000,
      onFast: () => void runCheck(false),
      onFull: () => void runCheck(true),
      llmEnabled: () => useStore.getState().llmAuto,
    })

    const view = new EditorView({
      doc: '',
      parent: container.current!,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        findingsField,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            noteChange()
            scheduler.onInput()
            const store = useStore.getState()
            const text = update.state.doc.toString()
            store.setDocWords(wordCount(text))
            store.setDocChars(codePoints(text))
            store.markScorecardStale()
          }
          const field = update.state.field(findingsField)
          const previous = update.startState.field(findingsField)
          if (field !== previous) {
            useStore.getState().setTracked(field.items, field.selectedId)
          }
        }),
        EditorView.domEventHandlers({
          click(event, view) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (pos === null) return false
            const id = findingIdAt(view.state.field(findingsField), pos)
            view.dispatch({ effects: selectFindingEffect.of(id) })
            return false
          },
        }),
      ],
    })
    setEditorView(view)
    const initialText = view.state.doc.toString()
    useStore.getState().setDocWords(wordCount(initialText))
    useStore.getState().setDocChars(codePoints(initialText))

    const onBeforeUnload = () => void flush()
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      scheduler.dispose()
      setEditorView(null)
      view.destroy()
    }
  }, [])

  return <div className="editor" ref={container} />
}
