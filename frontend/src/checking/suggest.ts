import { postSuggestions } from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { findingsField } from '../editor/findings'
import { useStore } from '../state/store'
import { effectiveModel } from './model'

/**
 * Ask the LLM for drop-in replacements for one finding's current span.
 * Results are cached in the store; they die with the finding.
 */
export async function fetchSuggestions(findingId: string): Promise<void> {
  const view = getEditorView()
  if (!view) return
  const item = view.state
    .field(findingsField)
    .items.find((it) => it.finding.id === findingId)
  if (!item) return

  const state = useStore.getState()
  if (state.suggestPendingId) return
  state.setSuggestError(findingId, null)
  state.setSuggestPending(findingId)
  try {
    const result = await postSuggestions({
      text: view.state.doc.toString(),
      span: { start: item.from, end: item.to },
      message: item.finding.message,
      language: state.language,
      llm_provider: state.provider,
      llm_model: effectiveModel(state.model, state.provider, state.providers),
    })
    useStore.getState().setExtraSuggestions(findingId, result.suggestions)
  } catch (error) {
    useStore.getState().setSuggestError(findingId, String(error))
  } finally {
    useStore.getState().setSuggestPending(null)
  }
}
