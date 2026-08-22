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
    profilesReady: true,
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

  // Copilot round 3: protocol.ts's parser accepts an empty-string meta.url
  // (the field-connected message just requires it to be a string), and a
  // `??` fallback treats '' as present — rendering a blank connection strip
  // instead of falling back to the documented fieldId.
  it('falls back to the fieldId when the connected field has an empty-string url', () => {
    useStore.setState({ connectedField: { fieldId: 'f1', url: '' } })
    render(<EmbedApp />)

    expect(screen.getByText('f1')).toBeTruthy()
  })

  it('Check button calls runCheck(true)', () => {
    useStore.setState({ connectedField: { fieldId: 'f1', url: null } })
    render(<EmbedApp />)

    fireEvent.click(screen.getByText(en.check))

    expect(runCheck).toHaveBeenCalledWith(true)
  })

  // Copilot round 7: the manual Check button bypassed the profilesReady gate
  // that the connect-time and scheduler-timer checks already respect, and
  // was clickable with no field connected at all.
  describe('Check button disabled state gated on connection + profilesReady', () => {
    it('is disabled when no field is connected', () => {
      render(<EmbedApp />)

      expect((screen.getByRole('button', { name: en.check }) as HTMLButtonElement).disabled).toBe(
        true,
      )
    })

    it('is disabled while profiles are still loading, even with a field connected', () => {
      useStore.setState({ connectedField: { fieldId: 'f1', url: null }, profilesReady: false })
      render(<EmbedApp />)

      expect((screen.getByRole('button', { name: en.check }) as HTMLButtonElement).disabled).toBe(
        true,
      )
    })

    it('is enabled once a field is connected and profiles are ready', () => {
      useStore.setState({ connectedField: { fieldId: 'f1', url: null }, profilesReady: true })
      render(<EmbedApp />)

      expect((screen.getByRole('button', { name: en.check }) as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
  })

  it('a fresh connection cancels any in-flight check and runs a fast one', () => {
    render(<EmbedApp />)
    // cancelCheck also runs on the mount effect itself (every transition,
    // including the initial no-field state) — clear it so this test isolates
    // the connect transition specifically.
    vi.mocked(cancelCheck).mockClear()
    vi.mocked(runCheck).mockClear()

    act(() => {
      useStore.setState({ connectedField: { fieldId: 'f1', url: null } })
    })

    expect(cancelCheck).toHaveBeenCalled()
    expect(runCheck).toHaveBeenCalledWith(false)
  })

  // Copilot round 1: cancelCheck() must run on EVERY connection-state
  // transition, not just connect — a check left in flight against a field
  // that just disconnected must not resolve and publish stale findings.
  it('a disconnect also triggers cancelCheck, without running a new check', () => {
    useStore.setState({ connectedField: { fieldId: 'f1', url: null } })
    render(<EmbedApp />)
    vi.mocked(cancelCheck).mockClear()
    vi.mocked(runCheck).mockClear()

    act(() => {
      useStore.setState({ connectedField: null })
    })

    expect(cancelCheck).toHaveBeenCalled()
    expect(runCheck).not.toHaveBeenCalled()
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
    // A field must be connected for the readiness-gated onFast callback
    // (Copilot round 7) to run — profilesReady is already true by default.
    useStore.setState({ connectedField: { fieldId: 'f1', url: null } })

    const { unmount } = render(<EmbedApp />)
    // Mount also triggers the connect-time check (connectedField +
    // profilesReady are both already truthy here) — clear it so this test
    // isolates the scheduler's own debounce behavior.
    vi.mocked(runCheck).mockClear()

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

  // Copilot round 7: onFast/onFull must not bypass the same profilesReady
  // gate the connect-time check already respects (Copilot round 4) — a host
  // textChanged during a cold profile load or language switch would
  // otherwise arm these timers and run against stale/empty profile config.
  describe('scheduler timers gated on profilesReady', () => {
    it('a fast-check timer that fires while profilesReady is false does not run a check', () => {
      vi.useFakeTimers()
      const outbound = fakeOutbound()
      setEmbedOutbound(outbound)
      useStore.setState({
        connectedField: { fieldId: 'f1', url: null },
        profilesReady: false,
      })

      render(<EmbedApp />)
      vi.mocked(runCheck).mockClear() // drop the connect-time check attempt (also gated, doesn't fire)

      act(() => {
        outbound.onInput()
        vi.advanceTimersByTime(1000)
      })

      expect(runCheck).not.toHaveBeenCalled()
    })

    it('after profilesReady flips true, the next onInput-armed timer runs the check', () => {
      vi.useFakeTimers()
      const outbound = fakeOutbound()
      setEmbedOutbound(outbound)
      useStore.setState({
        connectedField: { fieldId: 'f1', url: null },
        profilesReady: false,
      })

      render(<EmbedApp />)

      act(() => {
        useStore.setState({ profilesReady: true })
      })
      vi.mocked(runCheck).mockClear() // drop the connect-time re-check triggered by the flip

      act(() => {
        outbound.onInput()
        vi.advanceTimersByTime(1000)
      })

      expect(runCheck).toHaveBeenCalledWith(false)
    })
  })

  // Copilot round 1: scheduler timers must not cross field boundaries. A
  // timer armed by field A's onInput must be disposed, not left to fire,
  // once the connected field's identity changes to field B.
  it('onInput armed before a field switch does not fire runCheck after the switch, at the old deadline', () => {
    vi.useFakeTimers()
    const outbound = fakeOutbound()
    setEmbedOutbound(outbound)
    useStore.setState({ connectedField: { fieldId: 'field-a', url: null } })

    render(<EmbedApp />)
    vi.mocked(runCheck).mockClear()

    // Arm field A's scheduler.
    act(() => {
      outbound.onInput()
    })
    // 400ms in: switch to field B before A's 1000ms fast-check deadline.
    act(() => {
      vi.advanceTimersByTime(400)
      useStore.setState({ connectedField: { fieldId: 'field-b', url: null } })
    })
    vi.mocked(runCheck).mockClear() // drop the connect-triggered runCheck(false) for field B

    // Advance past where field A's original timer would have fired
    // (400 + 700 = 1100ms since arming) without B ever calling onInput.
    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(runCheck).not.toHaveBeenCalled()
  })

  // Copilot round 2: a same-field reconnect writes a brand-new
  // connectedField object with the SAME fieldId (store.ts's own comment on
  // setConnectedField), so keying the scheduler-lifecycle effect on
  // connectedField?.fieldId alone would leave the prior document's scheduler
  // — and its armed timer — alive across the reconnect. Depending on the
  // connectedField object itself re-runs the effect on every connect,
  // disposing the old scheduler before the timer's deadline.
  it('a same-field reconnect (new connectedField object, same fieldId) disposes the prior scheduler so its armed timer does not fire at the old deadline', () => {
    vi.useFakeTimers()
    const outbound = fakeOutbound()
    setEmbedOutbound(outbound)
    useStore.setState({ connectedField: { fieldId: 'field-a', url: null } })

    render(<EmbedApp />)
    vi.mocked(runCheck).mockClear()

    // Arm the scheduler with the first document's text.
    act(() => {
      outbound.onInput()
    })
    // 400ms in: the host reconnects to the SAME fieldId with a replacement
    // document (e.g. undo/redo, or a fresh load into the same field) — a
    // brand-new connectedField object — before the 1000ms fast-check
    // deadline armed against the OLD text.
    act(() => {
      vi.advanceTimersByTime(400)
      useStore.setState({ connectedField: { fieldId: 'field-a', url: null } })
    })
    vi.mocked(runCheck).mockClear() // drop the reconnect-triggered runCheck(false)

    // Advance past where the original timer would have fired (400 + 700 =
    // 1100ms since arming) without the replacement document ever calling
    // onInput itself.
    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(runCheck).not.toHaveBeenCalled()
  })

  // Copilot round 4: on a cold authenticated mount, the profiles fetch
  // (header/useHeaderData.ts) can still be in flight when a field connects
  // — the connect-time check must wait for it, or the first check omits
  // the profile's rule_config with nothing to re-check once it applies.
  describe('connect-time check gated on profilesReady', () => {
    it('defers the check until profilesReady, even though a field is connected', () => {
      useStore.setState({ connectedField: { fieldId: 'f1', url: null }, profilesReady: false })
      render(<EmbedApp />)

      expect(runCheck).not.toHaveBeenCalled()
    })

    it('fires once profiles resolve for an already-connected field', () => {
      useStore.setState({ connectedField: { fieldId: 'f1', url: null }, profilesReady: false })
      render(<EmbedApp />)
      vi.mocked(runCheck).mockClear()

      act(() => {
        useStore.setState({ profilesReady: true })
      })

      expect(runCheck).toHaveBeenCalledWith(false)
    })

    it('fires anyway when the profiles fetch fails (profilesReady still flips true)', () => {
      // useHeaderData.ts's catch branch sets profilesReady true on a failed
      // fetch too — simulated directly here since the fetch itself is mocked
      // out at the top of this file.
      useStore.setState({ connectedField: { fieldId: 'f1', url: null }, profilesReady: false })
      render(<EmbedApp />)
      vi.mocked(runCheck).mockClear()

      act(() => {
        useStore.setState({ profilesReady: true })
      })

      expect(runCheck).toHaveBeenCalledWith(false)
    })
  })
})
