import { HttpError, postSuggestions } from '../api/client'
import { tierAllowed } from '../auth/policy'
import { refreshUserNow } from '../auth/refreshSlot'
import { currentGeneration } from '../documents/autosave'
import { getEditorView } from '../editor/editorRef'
import { findingsField } from '../editor/findings'
import { currentMessages } from '../i18n'
import { activeProfile } from '../profiles/profile'
import { useStore } from '../state/store'
import { resolveModel } from './routing'
import { skipNoticeText } from './skipNotice'
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
  // Captured before the LLM round-trip: postSuggestions() takes tens of
  // seconds, and a session ending mid-request must not let another user's
  // sentence (result.original) or its rewrites (result.suggestions) land in
  // the incoming session's store — see controller.ts's runCheck() for the
  // same hazard on the check-scorecard path.
  const gen = currentGeneration()
  try {
    const result = await requestForFinding(findingId, 'span')
    if (gen !== currentGeneration()) return // session ended: drop the response
    if (result) {
      if (result.skipped) {
        useStore.getState().setSuggestError(
          findingId,
          skipNoticeText(result.skipped, useStore.getState().user,
            currentMessages()) ?? currentMessages().llmSkippedServer,
        )
        return
      }
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
      refreshUserNow()
    }
  } catch (error) {
    if (gen !== currentGeneration()) return // session ended: stale error, nothing to report
    if (error instanceof HttpError && error.status === 429) {
      // A concurrency 429 reserved no ledger row (the server rejected before
      // spending quota), so refreshing here would just add avoidable /me
      // load exactly while the server is applying backpressure.
      useStore.getState().setSuggestError(findingId, currentMessages().serverBusy)
      return
    }
    // A provider failure (e.g. a 502) still spends quota — its ledger row
    // settles as 'failed' server-side — so used_today goes stale unless this
    // fires too.
    refreshUserNow()
    useStore.getState().setSuggestError(findingId, error instanceof Error ? error.message : String(error))
  } finally {
    // Scoped to the captured generation: an outgoing session's completion
    // must not clear the incoming session's own genuinely in-flight pending
    // marker (llmActionPending() gates a second concurrent call on it being
    // non-null) — unconditionally clearing here would let a second request
    // through that should have been blocked, or drop the incoming session's
    // spinner early.
    if (gen === currentGeneration()) useStore.getState().setSuggestPending(null)
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
  // Same hazard as fetchSuggestions() above: capture before the round-trip
  // so a session ending mid-request cannot write another user's rewritten
  // sentence into this session's store.
  const gen = currentGeneration()
  try {
    const result = await requestForFinding(findingId, 'sentence')
    if (gen !== currentGeneration()) return // session ended: drop the response
    if (result) {
      if (result.skipped) {
        useStore.getState().setRewriteError(
          findingId,
          skipNoticeText(result.skipped, useStore.getState().user,
            currentMessages()) ?? currentMessages().llmSkippedServer,
        )
        return
      }
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
      refreshUserNow()
    }
  } catch (error) {
    if (gen !== currentGeneration()) return // session ended: stale error, nothing to report
    if (error instanceof HttpError && error.status === 429) {
      // Same reasoning as fetchSuggestions()'s catch block above: nothing
      // was reserved, so skip the refresh.
      useStore.getState().setRewriteError(findingId, currentMessages().serverBusy)
      return
    }
    // Same reasoning as fetchSuggestions()'s catch block above.
    refreshUserNow()
    useStore.getState().setRewriteError(findingId, error instanceof Error ? error.message : String(error))
  } finally {
    // Same reasoning as fetchSuggestions()'s finally block above.
    if (gen === currentGeneration()) useStore.getState().setRewritePending(null)
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
  // Same off-plan bypass as controller.ts's runCheck(): an off-plan tier's
  // local availability is irrelevant, since the server degrades to a tier
  // the client cannot pre-check. Only a null (pinned) or policy-allowed
  // tier's own unavailability blocks the request client-side.
  const offPlanTier = state.tier !== null && !tierAllowed(state.user, state.tier)
  if (!resolution.ok && !offPlanTier) {
    throw new Error(currentMessages().llmSkipped(resolution.reason))
  }
  return postSuggestions({
    text: view.state.doc.toString(),
    span: { start: item.from, end: item.to },
    message: item.finding.message,
    language: state.language,
    scope,
    rule_id: item.finding.rule_id,
    llm_tier: state.tier,
    llm_provider: state.tier === null && resolution.ok ? resolution.provider : null,
    llm_model: state.tier === null && resolution.ok ? resolution.model : null,
    llm_instructions: activeProfile(state)?.llm_instructions ?? '',
  })
}
