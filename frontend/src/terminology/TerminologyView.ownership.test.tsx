// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type { Domain, Term } from '../types'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getDomains: vi.fn(),
  getTerms: vi.fn().mockResolvedValue([]),
  createDomain: vi.fn(),
  deleteDomain: vi.fn(),
  updateDomain: vi.fn(),
  createTerm: vi.fn(),
  updateTerm: vi.fn(),
  deleteTerm: vi.fn(),
}))
// documents.ts pulls in hydration.ts -> checking/controller.ts; logout()
// (via auth/session.ts) only needs these two exports, so the module is
// replaced outright rather than partially mocked (matching session.test.ts).
vi.mock('../documents/documents', () => ({
  invalidateDocumentWork: vi.fn(),
  clearLegacyText: vi.fn(),
}))

import { getDomains, getTerms, updateTerm } from '../api/client'
import { logout } from '../auth/session'
import { TerminologyView } from './TerminologyView'

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    ...overrides,
  }
}

const globalDomain: Domain = { id: 1, name: 'Global Domain', description: '', is_global: true }
const privateDomain: Domain = { id: 2, name: 'Private Domain', description: '', is_global: false }

const term: Term = {
  id: 100,
  domain_id: 1,
  language: 'en',
  preferred: 'widget',
  forbidden_variants: ['thingamajig'],
  definition: '',
  case_sensitive: false,
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getDomains).mockResolvedValue([globalDomain, privateDomain])
  vi.mocked(getTerms).mockResolvedValue([])
  useStore.setState({
    uiLocale: 'en',
    languages: FALLBACK_LANGUAGES,
    domains: [globalDomain, privateDomain],
    user: user({ is_admin: false }),
  })
})

describe('TerminologyView ownership affordances (non-admin)', () => {
  it('shows the built-in badge and hides rename/delete on a global domain row; double-click does not rename', async () => {
    render(<TerminologyView />)
    const globalRow = (await screen.findByText('Global Domain')).closest('.domain-row') as HTMLElement
    within(globalRow).getByText(en.globalBadge)
    expect(within(globalRow).queryByTitle(en.renameDomainTitle)).toBeNull()
    expect(within(globalRow).queryByTitle(en.deleteDomainTitle)).toBeNull()

    await userEvent.dblClick(within(globalRow).getByText('Global Domain'))
    expect(within(globalRow).queryByRole('textbox')).toBeNull()
  })

  it('keeps both buttons on a private domain row', async () => {
    render(<TerminologyView />)
    const privateRow = (await screen.findByText('Private Domain')).closest('.domain-row') as HTMLElement
    within(privateRow).getByTitle(en.renameDomainTitle)
    within(privateRow).getByTitle(en.deleteDomainTitle)
  })

  it('renders no add-term row and no per-term edit/delete buttons when a global domain is active', async () => {
    vi.mocked(getTerms).mockResolvedValue([term])
    render(<TerminologyView />)
    // The first domain (global) auto-selects as active.
    await screen.findByText('widget')
    expect(screen.queryByPlaceholderText(en.preferredPlaceholder)).toBeNull()
    expect(screen.queryByTitle(en.editTermTitle)).toBeNull()
    expect(screen.queryByTitle(en.deleteTermTitle)).toBeNull()
  })

  it('restores every control once is_admin flips to true, on the same fixtures', async () => {
    useStore.setState({ user: user({ is_admin: true }) })
    vi.mocked(getTerms).mockResolvedValue([term])
    render(<TerminologyView />)

    const globalRow = (await screen.findByText('Global Domain')).closest('.domain-row') as HTMLElement
    within(globalRow).getByTitle(en.renameDomainTitle)
    within(globalRow).getByTitle(en.deleteDomainTitle)

    await screen.findByText('widget')
    screen.getByPlaceholderText(en.preferredPlaceholder)
    screen.getByTitle(en.editTermTitle)
    screen.getByTitle(en.deleteTermTitle)
  })

  it('exits edit mode when the selected domain changes mid-edit, so the stale Save button cannot fire', async () => {
    // domains[0] is the global domain, so start on the private one to get
    // an editable row in the first place.
    vi.mocked(getTerms).mockResolvedValue([term])
    render(<TerminologyView />)

    const privateRow = (await screen.findByText('Private Domain')).closest('.domain-row') as HTMLElement
    await userEvent.click(within(privateRow).getByText('Private Domain'))
    await screen.findByText('widget')

    await userEvent.click(screen.getByTitle(en.editTermTitle))
    screen.getByDisplayValue('widget') // now editing: the row's input carries the term's value
    screen.getByTitle(en.saveEditTitle)

    // Switch to the global domain while still "editing" — terms haven't
    // been refetched yet, so without a reset the same edit row (and its
    // live Save button, wired to the private term's id) would still render.
    const globalRow = (await screen.findByText('Global Domain')).closest('.domain-row') as HTMLElement
    await userEvent.click(within(globalRow).getByText('Global Domain'))

    expect(screen.queryByTitle(en.saveEditTitle)).toBeNull()
    expect(screen.queryByDisplayValue('widget')).toBeNull()
    expect(updateTerm).not.toHaveBeenCalled()
  })
})

describe('TerminologyView refreshDomains generation guard', () => {
  it('discards a refreshDomains fetch that resolves after a session turnover', async () => {
    let resolveFetch!: (domains: Domain[]) => void
    vi.mocked(getDomains).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )
    render(<TerminologyView />) // mount fires refreshDomains()
    await waitFor(() => expect(getDomains).toHaveBeenCalled())
    logout() // session ends while it is in flight; store's domains reset to []
    resolveFetch([{ id: 9, name: 'Foreign', description: '', is_global: false }])
    // Drain the .then chain before asserting — see App.domains-guard.test.tsx
    // for why a waitFor here would pass before the stale write even lands.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().domains).toEqual([]) // nothing landed
  })
})
