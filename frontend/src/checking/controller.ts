import { postCheck, subscribeCheck } from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { mergeFindingsEffect } from '../editor/findings'
import { useStore } from '../state/store'
import type { Finding } from '../types'
import { effectiveModel } from './model'

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

  const checkers = includeLlm
    ? ['rules', 'terminology', 'llm']
    : ['rules', 'terminology']
  useStore.setState({
    checkPhase: includeLlm ? 'llm' : 'fast',
    llmError: includeLlm ? null : state.llmError,
  })

  let result
  try {
    result = await postCheck({
      text,
      language: state.language,
      domain_id: state.domainId,
      checkers,
      llm_provider: state.provider,
      llm_model: effectiveModel(state.model, state.provider, state.providers),
    })
  } catch (error) {
    useStore.setState({ checkPhase: 'idle', llmError: String(error) })
    return
  }

  applyFindings(text, ['rule', 'terminology'], fastFindings(result.findings))

  if (!includeLlm || result.status === 'done') {
    useStore.setState({ checkPhase: 'idle' })
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
      if (currentCheckId === checkId) useStore.setState({ llmError: error })
    },
    onDone() {
      if (currentCheckId === checkId) {
        useStore.setState({ checkPhase: 'idle' })
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
