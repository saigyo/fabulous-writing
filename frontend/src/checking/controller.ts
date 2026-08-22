import { HttpError, postCheck, subscribeCheck } from '../api/client'
import { llmDisabled, tierAllowed } from '../auth/policy'
import { refreshUserNow } from '../auth/refreshSlot'
import { currentGeneration, flush } from '../documents/autosave'
import { currentMessages } from '../i18n'
import { activeProfile, effectiveRuleConfig } from '../profiles/profile'
import { useStore } from '../state/store'
import type { Finding } from '../types'
import { setCancelCheckHandler } from './cancelSlot'
import { getDocumentPort } from './documentPort'
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
  const port = getDocumentPort()
  const state = useStore.getState()
  const text = port.getText()

  unsubscribe?.()
  unsubscribe = null
  checkEpoch++
  const epoch = checkEpoch

  if (!text.trim()) {
    port.mergeFindings(['rule', 'terminology', 'llm'], [])
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
    if (error instanceof HttpError && error.status === 429) {
      // Transient (spec §8): the server is busy, nothing is wrong with the
      // request — a retry note, not a failure, and never an auth event.
      useStore.setState({
        checkPhase: 'idle',
        llmError: currentMessages().serverBusy,
        llmStartedAt: null,
        llmTokens: null,
      })
      return
    }
    useStore.setState({
      checkPhase: 'idle',
      llmError: currentMessages().llmCheckFailed(String(error)),
      llmStartedAt: null,
      llmTokens: null,
    })
    return
  }

  // Two refreshes cover this run's whole lifecycle, because a single one
  // cannot see both ends of it. `effective_llm` present with no skipped code
  // is exactly "this POST admitted an LLM run" (a skip never takes a
  // reservation, matching the never-refresh-on-skip rule elsewhere — see
  // checking/suggest.ts's 429 branches, which skip the refresh for the same
  // reason: no ledger row was written, so a refresh there would just be
  // avoidable /me load). Captured once here so both refresh sites — this one
  // and onDone's below — agree on the same admission decision rather than
  // each re-deriving it from `result`, which onDone's closure only has by
  // reference anyway.
  const admittedLlmRun =
    wantLlm && result.effective_llm != null && result.effective_llm.skipped == null

  // Refresh #1, at admission: reserve_llm_run() inserts the ledger row at
  // ADMISSION time — inside this very request/response cycle — and each
  // usage window counts every row for its period regardless of status, so
  // the window percentages already changed the moment postCheck() resolved.
  // But the row still carries the admission ESTIMATE, not the settled cost —
  // this refresh alone would leave the indicator showing the estimate for
  // however long the run takes, which is exactly what the owner asked to fix
  // for expensive models: the gap between estimate and actual can be large,
  // and a user could sit near 100% without knowing until their next check.
  //
  // This must run BEFORE the epoch check below, not after: cancelCheck()
  // (document switch) or a newer runCheck() bumps checkEpoch while this very
  // postCheck() is still in flight, tearing down the SSE subscription before
  // onDone ever fires — but the admitted backend run keeps its quota row
  // regardless, so skipping the refresh just because the epoch moved on
  // would leave the quota indicator silently behind the ledger. Only `gen` is
  // checked here, not `epoch`: gen !== currentGeneration() means the session
  // itself ended (logout/expireSession, via invalidateDocumentWork()) while
  // postCheck was in flight, and refreshing then would race the *next*
  // session's own /me fetch. refreshUserNow() is itself generation-guarded,
  // so that race can't land the wrong user's data — but the explicit check
  // here keeps the guarantee visible at the call site rather than relying on
  // that alone.
  if (gen === currentGeneration() && admittedLlmRun) {
    refreshUserNow()
  }

  // gen !== currentGeneration(): the session ended while postCheck was in
  // flight (logout/expiry). epoch !== checkEpoch: cancelCheck() or a newer
  // runCheck() ran while postCheck was in flight — e.g. hydrateFromDocument()
  // switched documents to a *different* document in the *same* session, so
  // gen alone would not have caught it. Either way: do not apply findings,
  // flush, or subscribe — this is what a stale check's late arrival would
  // otherwise write onto the wrong document. (The admission-time /me refresh
  // above is a deliberate exception to this guard — see its own comment.)
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
      useStore.getState().setScorecard(scorecard)
      // The scorecard describes the checked snapshot; if the user kept
      // typing it is immediately outdated (unlike findings it has no
      // offsets, so it is kept rather than discarded). The runCheck()
      // early-return above already filters the empty-document case
      // (`!text.trim()` returns before any subscription), so a null port's
      // getText() === '' arriving here mid-teardown just marks stale —
      // harmless, and matches "document gone".
      if (port.getText() !== text) {
        useStore.getState().markScorecardStale()
      }
      void flush()
    },
    onDone() {
      if (currentCheckId === checkId) {
        // Refresh #2, at settlement: checks.py's LLM task runs
        // reservation.finish() (the ledger settle, to actual tokens) in its
        // `finally` BEFORE job.finish() — the call that emits this `done`
        // event and unblocks the SSE stream — so by the time this handler
        // runs the settled cost is already committed and this refresh is
        // guaranteed to read it, not the admission estimate. `admittedLlmRun`
        // (captured above, before the epoch check) carries the same
        // admission decision as refresh #1: a run that took no reservation
        // never reaches this subscription in the first place, but the guard
        // is kept here anyway so the two refresh sites can't drift apart.
        // `gen` is rechecked because the session can end while this
        // subscription is still open and waiting for `done`.
        if (gen === currentGeneration() && admittedLlmRun) refreshUserNow()
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
  const port = getDocumentPort()
  // Findings are anchored to the checked snapshot; if the user kept typing,
  // the offsets no longer apply, so stale results are discarded.
  if (port.getText() !== checkedText) return
  port.mergeFindings(sources, findings)
}
