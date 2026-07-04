import { postSuggestions } from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { findingsField } from '../editor/findings'
import { useStore } from '../state/store'
import { effectiveModel } from './model'
import { noReliableSuggestionMessage } from './vetMessage'

/**
 * Ask the LLM for drop-in replacements for one finding's current span.
 * Results are cached in the store; they die with the finding.
 */
export async function fetchSuggestions(findingId: string): Promise<void> {
  const state = useStore.getState()
  if (llmActionPending()) return
  state.setSuggestError(findingId, null)
  state.setSuggestPending(findingId)
  try {
    const result = await requestForFinding(findingId, 'span')
    if (result) {
      const vetoed = noReliableSuggestionMessage(result.suggestions, result.rejected)
      if (vetoed) useStore.getState().setSuggestError(findingId, vetoed)
      else useStore.getState().setExtraSuggestions(findingId, result.suggestions)
    }
  } catch (error) {
    useStore.getState().setSuggestError(findingId, String(error))
  } finally {
    useStore.getState().setSuggestPending(null)
  }
}

/**
 * Ask the LLM to rewrite the whole sentence around a finding. The response's
 * `original` records exactly which text the rewrites replace.
 */
export async function fetchRewrite(findingId: string): Promise<void> {
  const state = useStore.getState()
  if (llmActionPending()) return
  state.setRewriteError(findingId, null)
  state.setRewritePending(findingId)
  try {
    const result = await requestForFinding(findingId, 'sentence')
    if (result) {
      const vetoed = noReliableSuggestionMessage(result.suggestions, result.rejected)
      if (vetoed) {
        useStore.getState().setRewriteError(findingId, vetoed)
      } else {
        useStore.getState().setRewrite(findingId, {
          original: result.original,
          options: result.suggestions,
        })
      }
    }
  } catch (error) {
    useStore.getState().setRewriteError(findingId, String(error))
  } finally {
    useStore.getState().setRewritePending(null)
  }
}

export function llmActionPending(): boolean {
  const state = useStore.getState()
  return state.suggestPendingId !== null || state.rewritePendingId !== null
}

async function requestForFinding(findingId: string, scope: 'span' | 'sentence') {
  const view = getEditorView()
  if (!view) return null
  const item = view.state
    .field(findingsField)
    .items.find((it) => it.finding.id === findingId)
  if (!item) return null
  const state = useStore.getState()
  return postSuggestions({
    text: view.state.doc.toString(),
    span: { start: item.from, end: item.to },
    message: item.finding.message,
    language: state.language,
    scope,
    rule_id: item.finding.rule_id,
    llm_provider: state.provider,
    llm_model: effectiveModel(state.model, state.provider, state.providers),
  })
}
