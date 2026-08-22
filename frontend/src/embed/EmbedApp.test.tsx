// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'

// Only the catalog fetches useHeaderData()'s mount effects fire are
// replaced — everything else in api/client stays real but unused here
// (mirrors App.domains-guard.test.tsx's mocking of the same effects).
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getProviders: vi.fn().mockResolvedValue([]),
  getDomains: vi.fn().mockResolvedValue([]),
  getLanguages: vi.fn().mockResolvedValue([]),
  getRouting: vi.fn().mockResolvedValue(null),
  getProfiles: vi.fn().mockResolvedValue([]),
}))
vi.mock('../checking/controller', () => ({
  runCheck: vi.fn(),
  cancelCheck: vi.fn(),
}))

import { cancelCheck, runCheck } from '../checking/controller'
import type { ApplyResult, DocumentPort } from '../checking/documentPort'
import { setDocumentPort } from '../checking/documentPort'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import { EmbedApp } from './EmbedApp'
import { setEmbedOutbound } from './embedRef'
import type { HostDocOutbound } from './hostDoc'

function fakePort(): DocumentPort {
  return {
    hasDocument: () => true,
    getText: () => '',
    setDocument: () => {},
    currentFinding: () => null,
    serverSpan: () => null,
    mergeFindings: () => {},
    selectFinding: () => {},
    applySuggestion: () => Promise.resolve<ApplyResult>('ok'),
    applyRewrite: () => Promise.resolve<ApplyResult>('ok'),
  }
}

function fakeOutbound(): HostDocOutbound {
  return {
    sendApplyReplacement: () => {},
    sendSelectFinding: () => {},
    sendFindings: () => {},
    onInput: () => {},
  }
}

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  setEmbedOutbound(null)
})

beforeEach(() => {
  setDocumentPort(fakePort())
  useStore.setState({
    uiLocale: 'en',
    language: 'en',
    domainIds: [],
    profiles: [],
    profileId: null,
    user: null,
    checkPhase: 'idle',
    llmAuto: true,
    tracked: [],
    selectedId: null,
    connectedField: null,
  })
})

describe('EmbedApp', () => {
  it('renders the waiting state when no field is connected', () => {
    render(<EmbedApp />)
    expect(screen.getByText(en.embedWaiting)).toBeTruthy()
  })

  it('renders selectors, Sidebar, and the Check button once a field connects', () => {
    useStore.setState({
      connectedField: { fieldId: 'f1', url: 'https://host.example/doc' },
    })
    render(<EmbedApp />)

    expect(screen.getByText('https://host.example/doc')).toBeTruthy()
    expect(screen.getByText(en.profile)).toBeTruthy() // ProfileSelector
    expect(screen.getByText(en.domain)).toBeTruthy() // DomainMultiSelect label
    expect(screen.getByText(en.findings)).toBeTruthy() // Sidebar heading
    expect(screen.getByText(en.check)).toBeTruthy()
  })

  it('Check button calls runCheck(true)', () => {
    useStore.setState({ connectedField: { fieldId: 'f1', url: null } })
    render(<EmbedApp />)

    fireEvent.click(screen.getByText(en.check))

    expect(runCheck).toHaveBeenCalledWith(true)
  })

  it('a fresh connection cancels any in-flight check and runs a fast one', () => {
    render(<EmbedApp />)
    expect(cancelCheck).not.toHaveBeenCalled()

    act(() => {
      useStore.setState({ connectedField: { fieldId: 'f1', url: null } })
    })

    expect(cancelCheck).toHaveBeenCalled()
    expect(runCheck).toHaveBeenCalledWith(false)
  })

  // AccountMenu is the app's only sign-out affordance, and the embed
  // iframe's session is storage-partition-scoped — without it, a user who
  // logs in inside a host panel would have no way to end that session.
  // hideActivity suppresses "My activity" only: EmbedApp has no activity
  // view to switch into (unlike App.tsx, it never branches on
  // activeView === 'activity').
  it('renders AccountMenu with the activity item hidden while sign-out stays available', () => {
    useStore.setState({
      connectedField: { fieldId: 'f1', url: null },
      user: user(),
    })
    render(<EmbedApp />)

    fireEvent.click(screen.getByRole('button', { name: en.accountMenu }))

    expect(screen.queryByRole('button', { name: en.accountActivity })).toBeNull()
    expect(screen.getByRole('button', { name: en.accountChangePassword })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.accountLogOut })).toBeTruthy()
  })

  // main.tsx renders <EmbedApp /> with no props, so it reaches the bridge's
  // outbound sender via embedRef.ts's module-level singleton (see its own
  // comment) — this is the seam a test can drive without a real bridge.
  it('wires the check scheduler into the bridge outbound: onInput debounces a fast check', () => {
    vi.useFakeTimers()
    const outbound = fakeOutbound()
    setEmbedOutbound(outbound)

    const { unmount } = render(<EmbedApp />)
    expect(runCheck).not.toHaveBeenCalled()

    // Simulate what hostDoc.ts:syncBuffer does on every textChanged/
    // replaceResult: call the outbound's onInput, which EmbedApp's mount
    // effect replaced with the scheduler's onInput.
    act(() => {
      outbound.onInput()
    })
    expect(runCheck).not.toHaveBeenCalled() // debounced, not yet due

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(runCheck).toHaveBeenCalledWith(false)

    // Unmount's cleanup resets outbound.onInput to a no-op: a stale
    // reference to a torn-down scheduler must never fire a check.
    unmount()
    vi.mocked(runCheck).mockClear()
    act(() => {
      outbound.onInput()
      vi.advanceTimersByTime(2000)
    })
    expect(runCheck).not.toHaveBeenCalled()
  })
})
