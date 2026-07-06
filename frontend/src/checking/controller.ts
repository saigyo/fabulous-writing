import { postCheck, subscribeCheck } from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { mergeFindingsEffect } from '../editor/findings'
import { currentMessages } from '../i18n'
import { activeProfile, effectiveRuleConfig } from '../profiles/profile'
import { useStore } from '../state/store'
import type { Finding } from '../types'
import { resolveModel } from './routing'

let currentCheckId: string | null = null
let unsubscribe: (() => void) | null = null

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

  if (!text.trim()) {
    view.dispatch({
      effects: mergeFindingsEffect.of({
        replaceSources: ['rule', 'terminology', 'llm'],
        findings: [],
      }),
    })
    return
  }

  const resolution = resolveModel(state)

  const wantLlm = includeLlm && resolution.ok
  const checkers = wantLlm
    ? ['rules', 'terminology', 'llm']
    : ['rules', 'terminology']
  useStore.setState({
    checkPhase: wantLlm ? 'llm' : 'fast',
    llmError:
      includeLlm && !resolution.ok
        ? currentMessages().llmSkipped(resolution.reason)
        : includeLlm
          ? null
          : state.llmError,
    llmStartedAt: wantLlm ? Date.now() : null,
    llmTokens: null,
  })

  const profile = activeProfile(state)

  let result
  try {
    result = await postCheck({
      text,
      language: state.language,
      domain_ids: state.domainIds,
      checkers,
      rule_config: effectiveRuleConfig(profile),
      llm_provider: resolution.ok ? resolution.provider : null,
      llm_model: resolution.ok ? resolution.model : null,
      llm_instructions: profile?.llm_instructions ?? '',
    })
  } catch (error) {
    useStore.setState({
      checkPhase: 'idle',
      llmError: currentMessages().llmCheckFailed(String(error)),
      llmStartedAt: null,
      llmTokens: null,
    })
    return
  }

  applyFindings(text, ['rule', 'terminology'], fastFindings(result.findings))

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
      }
    },
    onError(_checker, error) {
      if (currentCheckId === checkId) useStore.setState({ llmError: currentMessages().llmCheckFailed(error) })
    },
    onProgress(tokens) {
      if (currentCheckId === checkId) useStore.setState({ llmTokens: tokens })
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
