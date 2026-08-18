// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { TrackedFinding } from '../editor/findings'
import type { EffectiveLlm, Finding } from '../types'
import { Sidebar } from './Sidebar'

function finding(id: string): Finding {
  return {
    id,
    category: 'grammar',
    severity: 'warning',
    source: 'rule',
    rule_id: null,
    message: 'A finding message.',
    span: { start: 0, end: 5, text: 'Hello' },
    suggestions: [],
    advice: [],
  }
}

function tracked(f: Finding): TrackedFinding {
  return { finding: f, from: f.span.start, to: f.span.end }
}

function user(
  policy: MeResponse['policy'],
  overrides: Partial<MeResponse> = {},
): MeResponse {
  return {
    id: 1,
    email: 'u@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy,
    usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
    limits: {
      max_document_chars: 200000,
      max_llm_document_chars: 200000,
      concurrent_llm_runs: 5,
    },
    allow_additional_admins: false,
    db_backend: 'sqlite',
    ...overrides,
  }
}

const FLOOR: MeResponse['policy'] = {
  llm: { tiers: [], providers: [], models: null },
  features: [],
}

const FULL: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: ['custom_profiles', 'custom_domains'],
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
  })
})

describe('Sidebar async-notice live regions', () => {
  it('gives the check-error slot role="status", including for the 429/serverBusy notice', () => {
    useStore.setState({ llmError: en.serverBusy })
    render(<Sidebar />)

    const note = screen.getByText(en.serverBusy)
    expect(note.getAttribute('role')).toBe('status')
  })

  it('still reports a plain llmCheckFailed error through the same live region', () => {
    useStore.setState({ llmError: en.llmCheckFailed('boom') })
    render(<Sidebar />)

    const note = screen.getByText(en.llmCheckFailed('boom'))
    expect(note.getAttribute('role')).toBe('status')
  })
})

describe('Sidebar degradation/skip notes', () => {
  it('shows the llmDegraded note when a check ran but degraded', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'quality', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: true,
      skipped: null,
    }
    useStore.setState({ llmEffective })
    render(<Sidebar />)

    const note = screen.getByText(en.llmDegraded(en.tierName('balanced'), en.tierName('quality')))
    expect(note).toBeTruthy()
    expect(note.getAttribute('role')).toBe('status')
  })

  it('shows only the skip note when degraded AND skipped — nothing "ran"', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'quality', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: true,
      skipped: 'llm_unavailable',
    }
    useStore.setState({ llmEffective, user: user(FULL) })
    render(<Sidebar />)

    expect(
      screen.queryByText(en.llmDegraded(en.tierName('balanced'), en.tierName('quality'))),
    ).toBeNull()
    const note = screen.getByText(en.llmSkippedServer)
    expect(note).toBeTruthy()
    expect(note.getAttribute('role')).toBe('status')
  })

  it('shows llmNotIncluded when skipped for a floor-policy user', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'balanced', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: false,
      skipped: 'llm_unavailable',
    }
    useStore.setState({ llmEffective, user: user(FLOOR) })
    render(<Sidebar />)

    const note = screen.getByText(en.llmNotIncluded)
    expect(note).toBeTruthy()
    expect(note.getAttribute('role')).toBe('status')
  })

  it('shows llmSkippedServer when skipped for an unrestricted user', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'balanced', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: false,
      skipped: 'llm_unavailable',
    }
    useStore.setState({ llmEffective, user: user(FULL) })
    render(<Sidebar />)

    const note = screen.getByText(en.llmSkippedServer)
    expect(note).toBeTruthy()
    expect(note.getAttribute('role')).toBe('status')
  })

  it('shows llmQuotaExhausted when skipped for quota exhaustion', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'balanced', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: false,
      skipped: 'quota_exhausted',
    }
    useStore.setState({ llmEffective, user: user(FULL) })
    render(<Sidebar />)

    const note = screen.getByText(en.llmQuotaExhausted)
    expect(note).toBeTruthy()
    expect(note.getAttribute('role')).toBe('status')
  })

  it('shows llmDocumentTooLarge (with the fixture max) when skipped for an oversized document', () => {
    const llmEffective: EffectiveLlm = {
      requested: { tier: 'balanced', provider: null, model: null },
      effective: { tier: 'balanced', provider: null, model: null },
      degraded: false,
      skipped: 'document_too_large',
    }
    useStore.setState({ llmEffective, user: user(FULL) })
    render(<Sidebar />)

    const note = screen.getByText(en.llmDocumentTooLarge(200000))
    expect(note).toBeTruthy()
    expect(note.getAttribute('role')).toBe('status')
  })
})

describe('Sidebar character count', () => {
  // Task 8's fixture sweep set BOTH caps to 200000, leaving no
  // between-the-caps range — override max_llm_document_chars down so the
  // three thresholds (below both / over the LLM cap / over the doc cap)
  // are all reachable.
  const LIMITS_OVERRIDE: MeResponse['limits'] = {
    max_document_chars: 200000,
    max_llm_document_chars: 20000,
    concurrent_llm_runs: 5,
  }

  it('shows the plain count with no suffix when under both caps', () => {
    useStore.setState({ user: user(FULL, { limits: LIMITS_OVERRIDE }), docChars: 100 })
    render(<Sidebar />)

    expect(screen.getByText(en.charCount(100))).toBeTruthy()
    expect(screen.queryByText(en.charCountOverLlm, { exact: false })).toBeNull()
    expect(screen.queryByText(en.charCountOverDoc, { exact: false })).toBeNull()
  })

  it('shows the count plus the LLM-cap suffix when over the LLM cap but under the document cap', () => {
    useStore.setState({
      user: user(FULL, { limits: LIMITS_OVERRIDE }),
      docChars: 20001,
    })
    render(<Sidebar />)

    expect(
      screen.getByText(`${en.charCount(20001)} — ${en.charCountOverLlm}`),
    ).toBeTruthy()
    expect(screen.queryByText(en.charCountOverDoc, { exact: false })).toBeNull()
  })

  it('shows the count plus the document-cap suffix (not the LLM one) when over the document cap', () => {
    useStore.setState({
      user: user(FULL, { limits: LIMITS_OVERRIDE }),
      docChars: 200001,
    })
    render(<Sidebar />)

    expect(
      screen.getByText(`${en.charCount(200001)} — ${en.charCountOverDoc}`),
    ).toBeTruthy()
    expect(screen.queryByText(en.charCountOverLlm, { exact: false })).toBeNull()
  })
})

describe('Sidebar suggestion/rewrite error live regions', () => {
  it('gives the suggestion-error paragraph role="status"', () => {
    const f = finding('f1')
    useStore.setState({
      tracked: [tracked(f)],
      selectedId: f.id,
      suggestPendingId: null,
      rewritePendingId: null,
      suggestErrors: { [f.id]: 'Could not fetch a suggestion.' },
      rewriteErrors: {},
      extraSuggestions: {},
      suggestHeldBack: {},
      suggestAdvice: {},
      rewrites: {},
      rewriteHeldBack: {},
      rewriteAdvice: {},
    })
    render(<Sidebar />)

    const note = screen.getByText('Could not fetch a suggestion.')
    expect(note.getAttribute('role')).toBe('status')
  })

  it('gives the rewrite-error paragraph role="status"', () => {
    const f = finding('f2')
    useStore.setState({
      tracked: [tracked(f)],
      selectedId: f.id,
      suggestPendingId: null,
      rewritePendingId: null,
      suggestErrors: {},
      rewriteErrors: { [f.id]: 'Could not fetch a rewrite.' },
      extraSuggestions: {},
      suggestHeldBack: {},
      suggestAdvice: {},
      rewrites: {},
      rewriteHeldBack: {},
      rewriteAdvice: {},
    })
    render(<Sidebar />)

    const note = screen.getByText('Could not fetch a rewrite.')
    expect(note.getAttribute('role')).toBe('status')
  })
})
