// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
})
