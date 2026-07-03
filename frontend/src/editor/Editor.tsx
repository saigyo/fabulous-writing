import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { runCheck } from '../checking/controller'
import { createCheckScheduler } from '../checking/scheduler'
import { useStore } from '../state/store'
import { findingsField, selectFindingEffect } from './findings'
import { setEditorView } from './editorRef'

const TEXT_STORAGE_KEY = 'fabulous-writing-text'

const DEFAULT_TEXT = `# Welcome to Fabulous Writing

Start typing, and your text is checked continuously. This sentence is very good
and utilizes many words in order to demonstrate a a few issues.

Delete this text and write something fabulous.
`

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
      doc: localStorage.getItem(TEXT_STORAGE_KEY) ?? DEFAULT_TEXT,
      parent: container.current!,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        findingsField,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            localStorage.setItem(TEXT_STORAGE_KEY, update.state.doc.toString())
            scheduler.onInput()
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
            const hit = view.state
              .field(findingsField)
              .items.find((item) => item.from <= pos && pos <= item.to)
            view.dispatch({
              effects: selectFindingEffect.of(hit ? hit.finding.id : null),
            })
            return false
          },
        }),
      ],
    })
    setEditorView(view)
    void runCheck(false)

    return () => {
      scheduler.dispose()
      setEditorView(null)
      view.destroy()
    }
  }, [])

  return <div className="editor" ref={container} />
}
