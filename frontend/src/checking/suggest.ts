import { postSuggestions } from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { findingsField } from '../editor/findings'
import { currentMessages } from '../i18n'
import { activeProfile } from '../profiles/profile'
import { useStore } from '../state/store'
import { resolveModel } from './routing'
import { noReliableSuggestionMessage } from './vetMessage'

/**
 * Ask the LLM for drop-in replacements for one finding's current span.
 * Results are cached in the store; they die with the finding.
 */
export async function fetchSuggestions(findingId: string): Promise<void> {
  const state = useStore.getState()
  if (llmActionPending()) return
  state.setSuggestError(findingId, null)
  state.setSuggestHeldBack(findingId, null)
  state.setSuggestAdvice(findingId, null)
  state.setSuggestPending(findingId)
  try {
    const result = await requestForFinding(findingId, 'span')
    if (result) {
      const vetoed = noReliableSuggestionMessage(
        result.suggestions,
        result.rejected,
        currentMessages(),
      )
      const store = useStore.getState()
      store.setSuggestAdvice(
        findingId,
        result.advice.length > 0 ? result.advice : null,
      )
      if (vetoed) {
        store.setSuggestError(findingId, vetoed)
        store.setSuggestHeldBack(
          findingId,
          result.held_back.length > 0 ? result.held_back : null,
        )
      } else {
        store.setExtraSuggestions(findingId, result.suggestions)
        store.setSuggestHeldBack(findingId, null)
      }
    }
  } catch (error) {
    useStore.getState().setSuggestError(findingId, error instanceof Error ? error.message : String(error))
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
  state.setRewriteHeldBack(findingId, null)
  state.setRewriteAdvice(findingId, null)
  state.setRewritePending(findingId)
  try {
    const result = await requestForFinding(findingId, 'sentence')
    if (result) {
      const vetoed = noReliableSuggestionMessage(
        result.suggestions,
        result.rejected,
        currentMessages(),
      )
      const store = useStore.getState()
      store.setRewriteAdvice(
        findingId,
        result.advice.length > 0 ? result.advice : null,
      )
      if (vetoed) {
        store.setRewriteError(findingId, vetoed)
        store.setRewriteHeldBack(
          findingId,
          result.held_back.length > 0
            ? { original: result.original, candidates: result.held_back }
            : null,
        )
      } else {
        store.setRewrite(findingId, {
          original: result.original,
          options: result.suggestions,
        })
        store.setRewriteHeldBack(findingId, null)
      }
    }
  } catch (error) {
    useStore.getState().setRewriteError(findingId, error instanceof Error ? error.message : String(error))
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
  const resolution = resolveModel(state)
  if (!resolution.ok) {
    throw new Error(currentMessages().llmSkipped(resolution.reason))
  }
  return postSuggestions({
    text: view.state.doc.toString(),
    span: { start: item.from, end: item.to },
    message: item.finding.message,
    language: state.language,
    scope,
    rule_id: item.finding.rule_id,
    llm_provider: resolution.provider,
    llm_model: resolution.model,
    llm_instructions: activeProfile(state)?.llm_instructions ?? '',
  })
}
