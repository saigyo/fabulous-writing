import { postCheck, subscribeCheck } from '../api/client'
import { llmDisabled, tierAllowed } from '../auth/policy'
import { currentGeneration, flush } from '../documents/autosave'
import { getEditorView } from '../editor/editorRef'
import { mergeFindingsEffect } from '../editor/findings'
import { currentMessages } from '../i18n'
import { activeProfile, effectiveRuleConfig } from '../profiles/profile'
import { useStore } from '../state/store'
import type { Finding } from '../types'
import { setCancelCheckHandler } from './cancelSlot'
import { resolveModel } from './routing'

let currentCheckId: string | null = null
let unsubscribe: (() => void) | null = null

// A controller-local request epoch, distinct from currentGeneration() (the
// document/session-turnover counter). Switching documents does NOT bump
// currentGeneration() — only logout()/expireSession() do, via
// invalidateDocumentWork() — so a document switch mid-postCheck() would
// otherwise pass that check unchanged and let a pending check's response
// (findings, and worst of all onScorecard, which has no text guard) land on
// the newly opened document and get autosaved onto it. cancelCheck() (called
// by hydrateFromDocument() before every document switch) and each new
// runCheck() both bump this, so a check whose postCheck() resolves after
// either has happened is recognised as stale even though the session and
// document-generation counter never changed.
let checkEpoch = 0

/** Drop any in-flight check: closes the SSE subscription so late results
 * cannot land on a different document (they would be autosaved onto it). */
export function cancelCheck(): void {
  checkEpoch++
  unsubscribe?.()
  unsubscribe = null
  currentCheckId = null
  useStore.setState({
    checkPhase: 'idle',
    llmStartedAt: null,
    llmTokens: null,
    llmEffective: null,
  })
}

// Registered at load so session.ts can abort a running check on logout or
// expiry without importing this module — see checking/cancelSlot.ts for why
// that indirection is a dedicated leaf module rather than controller.ts and
// session.ts registering into each other directly.
setCancelCheckHandler(cancelCheck)

/**
 * Run a check on the current editor text. Fast findings (rules/terminology)
 * are applied from the POST response; LLM findings arrive via SSE and are
 * only applied if the text has not changed in the meantime. A newer check
 * supersedes any in-flight one.
 */
export async function runCheck(includeLlm: boolean): Promise<void> {
  const view = getEditorView()
  if (!view) return
  const state = useStore.getState()
  const text = view.state.doc.toString()

  unsubscribe?.()
  unsubscribe = null
  checkEpoch++
  const epoch = checkEpoch

  if (!text.trim()) {
    view.dispatch({
      effects: mergeFindingsEffect.of({
        replaceSources: ['rule', 'terminology', 'llm'],
        findings: [],
      }),
    })
    useStore.setState({ llmEffective: null })
    return
  }

  const resolution = resolveModel(state)

  // An off-plan tier's local availability is irrelevant: the server will
  // degrade to a different tier the client cannot pre-check, so the request
  // must go out even when the requested tier's own route is offline —
  // otherwise the client blocks the very degradation §6.2 exists for.
  const offPlanTier = state.tier !== null && !tierAllowed(state.user, state.tier)
  const wantLlm =
    includeLlm && !llmDisabled(state.user) && (offPlanTier || resolution.ok)
  const checkers = wantLlm
    ? ['rules', 'terminology', 'llm']
    : ['rules', 'terminology']
  useStore.setState({
    checkPhase: wantLlm ? 'llm' : 'fast',
    llmError:
      includeLlm && !resolution.ok && !offPlanTier
        ? currentMessages().llmSkipped(resolution.reason)
        : includeLlm
          ? null
          : state.llmError,
    llmStartedAt: wantLlm ? Date.now() : null,
    llmTokens: null,
    llmEffective: null,
  })

  const profile = activeProfile(state)

  // Captured before the request goes out: logout()/expireSession() bump this
  // (via invalidateDocumentWork()) while postCheck() is still in flight.
  // cancelInFlightCheck() only cancels a *subscribed* check (it nulls
  // unsubscribe/currentCheckId) — it cannot touch this await, so without this
  // guard runCheck() itself would re-arm currentCheckId and open a fresh
  // subscription for a session that has already ended once the await below
  // resolves. That subscription is what let a previous user's scorecard
  // (onScorecard has no text guard, unlike onResult/markScorecardStale) reach
  // the next user's store and get PUT onto their document.
  const gen = currentGeneration()

  let result
  try {
    result = await postCheck({
      text,
      language: state.language,
      domain_ids: state.domainIds,
      checkers,
      rule_config: effectiveRuleConfig(profile),
      llm_tier: state.tier,
      llm_provider: state.tier === null && resolution.ok ? resolution.provider : null,
      llm_model: state.tier === null && resolution.ok ? resolution.model : null,
      llm_instructions: profile?.llm_instructions ?? '',
    })
  } catch (error) {
    // gen guards session turnover; epoch guards a same-session document
    // switch or a newer runCheck() — see checkEpoch above for why both are
    // needed.
    if (gen !== currentGeneration() || epoch !== checkEpoch) return // stale error, nothing to report
    useStore.setState({
      checkPhase: 'idle',
      llmError: currentMessages().llmCheckFailed(String(error)),
      llmStartedAt: null,
      llmTokens: null,
    })
    return
  }

  // gen !== currentGeneration(): the session ended while postCheck was in
  // flight (logout/expiry). epoch !== checkEpoch: cancelCheck() or a newer
  // runCheck() ran while postCheck was in flight — e.g. hydrateFromDocument()
  // switched documents to a *different* document in the *same* session, so
  // gen alone would not have caught it. Either way: do not apply findings,
  // flush, or subscribe — this is what a stale check's late arrival would
  // otherwise write onto the wrong document.
  if (gen !== currentGeneration() || epoch !== checkEpoch) return

  useStore.setState({ llmEffective: result.effective_llm ?? null })
  applyFindings(text, ['rule', 'terminology'], fastFindings(result.findings))
  void flush()

  if (!wantLlm || result.status === 'done') {
    useStore.setState({ checkPhase: 'idle', llmStartedAt: null, llmTokens: null })
    return
  }

  currentCheckId = result.check_id
  const checkId = result.check_id
  unsubscribe = subscribeCheck(checkId, {
    onResult(checker, findings) {
      if (checker === 'llm' && currentCheckId === checkId) {
        applyFindings(text, ['llm'], findings)
        void flush()
      }
    },
    onError(_checker, error) {
      if (currentCheckId === checkId) useStore.setState({ llmError: currentMessages().llmCheckFailed(error) })
    },
    onProgress(tokens) {
      if (currentCheckId === checkId) useStore.setState({ llmTokens: tokens })
    },
    onScorecard(scorecard) {
      if (currentCheckId !== checkId) return
      const view = getEditorView()
      useStore.getState().setScorecard(scorecard)
      // The scorecard describes the checked snapshot; if the user kept
      // typing it is immediately outdated (unlike findings it has no
      // offsets, so it is kept rather than discarded).
      if (view && view.state.doc.toString() !== text) {
        useStore.getState().markScorecardStale()
      }
      void flush()
    },
    onDone() {
      if (currentCheckId === checkId) {
        useStore.setState({ checkPhase: 'idle', llmStartedAt: null, llmTokens: null })
        currentCheckId = null
      }
    },
  })
}

function fastFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.source !== 'llm')
}

function applyFindings(
  checkedText: string,
  sources: ('rule' | 'terminology' | 'llm')[],
  findings: Finding[],
): void {
  const view = getEditorView()
  if (!view) return
  // Findings are anchored to the checked snapshot; if the user kept typing,
  // the offsets no longer apply, so stale results are discarded.
  if (view.state.doc.toString() !== checkedText) return
  view.dispatch({
    effects: mergeFindingsEffect.of({ replaceSources: sources, findings }),
  })
}
