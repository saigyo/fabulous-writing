// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApplyResult, DocumentPort } from '../checking/documentPort'
import { setDocumentPort } from '../checking/documentPort'
import type { TrackedFinding } from '../editor/findings'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { Finding } from '../types'
import { Sidebar } from './Sidebar'

function finding(id: string, suggestions: string[] = []): Finding {
  return {
    id,
    category: 'grammar',
    severity: 'warning',
    source: 'rule',
    rule_id: null,
    message: 'A finding message.',
    span: { start: 0, end: 5, text: 'Hello' },
    suggestions,
    advice: [],
  }
}

function tracked(f: Finding): TrackedFinding {
  return { finding: f, from: f.span.start, to: f.span.end }
}

function fakePort(
  applySuggestion: () => Promise<ApplyResult>,
  applyRewrite: () => Promise<ApplyResult>,
): DocumentPort {
  return {
    hasDocument: () => true,
    getText: () => 'Hello there.',
    setDocument: () => {},
    currentFinding: () => null,
    serverSpan: () => null,
    mergeFindings: () => {},
    selectFinding: () => {},
    applySuggestion,
    applyRewrite,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  useStore.setState({
    uiLocale: 'en',
    tracked: [],
    selectedId: null,
    checkPhase: 'idle',
    llmError: null,
    llmEffective: null,
    severityFilter: null,
    sourceFilter: null,
    user: null,
    docChars: 0,
    extraSuggestions: {},
    suggestPendingId: null,
    suggestErrors: {},
    suggestHeldBack: {},
    suggestAdvice: {},
    rewrites: {},
    rewritePendingId: null,
    rewriteErrors: {},
    rewriteHeldBack: {},
    rewriteAdvice: {},
  })
})

// Task 3's discriminated ApplyResult ('ok' | 'not-found' | 'refused') is
// what makes these two cases distinguishable — 'refused' is embed-only (the
// host declined or timed out), 'not-found' means the finding/sentence is
// simply gone (main app and embed alike).
describe('Sidebar surfaces embed replacement failures (B43 C1)', () => {
  it('a refused suggestion apply renders embedReplaceFailed and keeps the suggestions on screen', async () => {
    const f = finding('f1', ['better'])
    setDocumentPort(
      fakePort(
        () => Promise.resolve('refused'),
        () => Promise.resolve('refused'),
      ),
    )
    useStore.setState({ tracked: [tracked(f)], selectedId: f.id })
    render(<Sidebar />)

    fireEvent.click(screen.getByText('better'))

    await waitFor(() =>
      expect(screen.getByText(en.embedReplaceFailed)).toBeTruthy(),
    )
    // The suggestion button is still there — a host refusal must not force
    // a re-fetch of what was already fetched.
    expect(screen.getByText('better')).toBeTruthy()
  })

  it('a not-found rewrite apply keeps the existing sentence-changed message', async () => {
    const f = finding('f2')
    setDocumentPort(
      fakePort(
        () => Promise.resolve('not-found'),
        () => Promise.resolve('not-found'),
      ),
    )
    useStore.setState({
      tracked: [tracked(f)],
      selectedId: f.id,
      rewrites: { [f.id]: { original: 'Hello there.', options: ['Hi there.'] } },
    })
    render(<Sidebar />)

    fireEvent.click(screen.getByText('Hi there.'))

    await waitFor(() =>
      expect(screen.getByText(en.sentenceChangedRewriteAgain)).toBeTruthy(),
    )
  })

  it('a refused rewrite apply renders embedReplaceFailed instead', async () => {
    const f = finding('f3')
    setDocumentPort(
      fakePort(
        () => Promise.resolve('refused'),
        () => Promise.resolve('refused'),
      ),
    )
    useStore.setState({
      tracked: [tracked(f)],
      selectedId: f.id,
      rewrites: { [f.id]: { original: 'Hello there.', options: ['Hi there.'] } },
    })
    render(<Sidebar />)

    fireEvent.click(screen.getByText('Hi there.'))

    await waitFor(() =>
      expect(screen.getByText(en.embedReplaceFailed)).toBeTruthy(),
    )
  })
})

// Copilot round 5: an async apply left every apply control for the finding
// enabled while it was in flight — a double-click enqueued a duplicate
// replacement with the same expectedText; the first succeeded, the
// duplicate was refused, and that refusal's embedReplaceFailed rendered
// over the successful outcome.
describe('Sidebar apply-in-flight guard (B43 C1, Copilot round 5)', () => {
  it('a double-clicked suggestion issues one replacement and re-enables after it settles', async () => {
    const f = finding('f4', ['better'])
    let resolveApply!: (r: ApplyResult) => void
    let calls = 0
    setDocumentPort(
      fakePort(
        () =>
          new Promise((resolve) => {
            calls += 1
            resolveApply = resolve
          }),
        () => Promise.resolve('ok'),
      ),
    )
    useStore.setState({ tracked: [tracked(f)], selectedId: f.id })
    render(<Sidebar />)

    const button = screen.getByText('better') as HTMLButtonElement
    fireEvent.click(button)
    fireEvent.click(button) // the duplicate must be ignored while the first is pending

    expect(calls).toBe(1)
    expect(button.disabled).toBe(true)

    resolveApply('ok')
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it('a double-clicked rewrite option issues one replacement and re-enables after it settles', async () => {
    const f = finding('f5')
    let resolveApply!: (r: ApplyResult) => void
    let calls = 0
    setDocumentPort(
      fakePort(
        () => Promise.resolve('ok'),
        () =>
          new Promise((resolve) => {
            calls += 1
            resolveApply = resolve
          }),
      ),
    )
    useStore.setState({
      tracked: [tracked(f)],
      selectedId: f.id,
      rewrites: { [f.id]: { original: 'Hello there.', options: ['Hi there.'] } },
    })
    render(<Sidebar />)

    const button = screen.getByText('Hi there.') as HTMLButtonElement
    fireEvent.click(button)
    fireEvent.click(button) // the duplicate must be ignored while the first is pending

    expect(calls).toBe(1)
    expect(button.disabled).toBe(true)

    resolveApply('ok')
    await waitFor(() => expect(button.disabled).toBe(false))
  })
})
